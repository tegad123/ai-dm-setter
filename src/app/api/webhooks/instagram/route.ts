import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { verifyWebhookSignature } from '@/lib/instagram';
import {
  processIncomingMessage,
  scheduleAIReply,
  processScheduledReply,
  computeReplyDelaySeconds
} from '@/lib/webhook-processor';
import prisma from '@/lib/prisma';
import { resolvePlatformAwayMode } from '@/lib/stage-progression';

// Short delays bypass the per-minute cron queue and run inline via after().
// Anything longer falls back to ScheduledReply + cron pickup so the lambda
// doesn't have to stay alive for minutes. 90s leaves headroom for AI gen.
const INLINE_DELAY_THRESHOLD_SECONDS = 90;

function hasImageAttachment(attachments: unknown): boolean {
  return (
    Array.isArray(attachments) &&
    attachments.some((attachment) => {
      const candidate = attachment as {
        type?: unknown;
        payload?: { url?: unknown } | null;
      };
      return (
        candidate?.type === 'image' &&
        typeof candidate.payload?.url === 'string'
      );
    })
  );
}

// Voice notes are delivered as `attachments[].type === 'audio'`. The
// inbound filter must let these through (FAILURE B 2026-05-02);
// dropping them silently meant lead voice notes never reached the
// app and operator voice notes never paused the AI.
function hasAudioAttachment(attachments: unknown): boolean {
  return (
    Array.isArray(attachments) &&
    attachments.some((attachment) => {
      const candidate = attachment as {
        type?: unknown;
        payload?: { url?: unknown } | null;
      };
      return (
        candidate?.type === 'audio' &&
        typeof candidate.payload?.url === 'string'
      );
    })
  );
}

function firstAudioAttachmentUrl(attachments: unknown): string | null {
  if (!Array.isArray(attachments)) return null;
  for (const attachment of attachments) {
    const candidate = attachment as {
      type?: unknown;
      payload?: { url?: unknown } | null;
    };
    if (
      candidate?.type === 'audio' &&
      typeof candidate.payload?.url === 'string'
    ) {
      return candidate.payload.url;
    }
  }
  return null;
}

// Vercel Hobby defaults to 10s — AI generation + send needs more time.
// Bumped to 120s to accommodate the inline-delay-then-reply path (after()
// callback): up to 90s delay + ~25s for AI generation + Instagram send.
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// GET — Webhook verification (Meta sends hub.mode, hub.verify_token, hub.challenge)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[instagram-webhook] Verification successful');
    return new NextResponse(challenge, { status: 200 });
  }

  console.warn('[instagram-webhook] Verification failed');
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — Receive webhook events from Meta (Instagram)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Read the raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';

  // Verify the webhook signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn(
      '[instagram-webhook] Invalid signature, raw sig:',
      signature?.slice(0, 20)
    );
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    console.warn('[instagram-webhook] Skipping signature check in dev mode');
  }

  // Return 200 immediately — Meta requires a fast response.
  const payload = JSON.parse(rawBody);

  // Process the events fully BEFORE returning 200.
  // This ensures AI generation + Instagram send completes within the function lifecycle.
  // Vercel keeps the function alive until we return the response.
  try {
    await processInstagramEvents(payload);
    console.log('[instagram-webhook] Processing complete');
  } catch (err) {
    console.error('[instagram-webhook] Event processing error:', err);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Async event processor
// ---------------------------------------------------------------------------

async function processInstagramEvents(payload: any): Promise<void> {
  console.log(
    `[instagram-webhook] payload.object=${payload.object}, entries=${payload.entry?.length ?? 0}, ` +
      `payload=${JSON.stringify(payload).slice(0, 1000)}`
  );
  if (payload.object !== 'instagram') {
    console.warn(
      `[instagram-webhook] Ignoring payload.object="${payload.object}" (expected "instagram")`
    );
    return;
  }

  // Fetch all active META and INSTAGRAM integration credentials for account lookup
  console.log('[instagram-webhook] fetching credentials');
  const allCredentials = await prisma.integrationCredential.findMany({
    where: { provider: { in: ['META', 'INSTAGRAM'] }, isActive: true }
  });
  console.log(
    `[instagram-webhook] credentials fetched: ${allCredentials.length}`
  );

  for (const entry of payload.entry ?? []) {
    console.log(
      `[instagram-webhook] entry-loop: id=${entry.id} hasMessaging=${!!entry.messaging} ` +
        `messagingLen=${entry.messaging?.length ?? 0} hasChanges=${!!entry.changes}`
    );
    // ── Resolve accountId from the entry ID in the webhook ────────
    const entryId: string = entry.id ?? '';

    // Match against all known ID fields across META and INSTAGRAM credentials.
    // Instagram webhooks send the IG Business Account ID as entry.id, which
    // may be stored as instagramAccountId (META provider) or igUserId (INSTAGRAM provider).
    const matchedCred = allCredentials.find((cred) => {
      const meta = cred.metadata as any;
      return (
        meta?.pageId === entryId ||
        meta?.igUserId === entryId ||
        meta?.instagramAccountId === entryId ||
        meta?.igBusinessAccountId === entryId
      );
    });

    console.log(
      `[instagram-webhook] entryId=${entryId}, matchedCred=${matchedCred?.id ?? 'NONE'}, ` +
        `allCreds=${allCredentials
          .map((c) => {
            const m = c.metadata as any;
            return `${c.provider}:pageId=${m?.pageId},igUserId=${m?.igUserId},igAcct=${m?.instagramAccountId}`;
          })
          .join(' | ')}`
    );

    let accountId: string;

    if (matchedCred) {
      accountId = matchedCred.accountId;
    } else {
      // Fallback 1: match via env var
      const envPageId =
        process.env.INSTAGRAM_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
      if (envPageId && envPageId === entryId) {
        const firstAccount = await prisma.account.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { id: true }
        });
        if (!firstAccount) {
          console.warn(`[instagram-webhook] No accounts in DB, skipping entry`);
          continue;
        }
        accountId = firstAccount.id;
        console.log(
          `[instagram-webhook] Matched entryId=${entryId} via env var → account=${accountId}`
        );
      } else if (allCredentials.length === 0) {
        // Fallback 2: No credentials at all — use the first account if one exists.
        // This handles setups where OAuth hasn't been completed yet but the
        // webhook is already configured in Meta's dashboard.
        const firstAccount = await prisma.account.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { id: true }
        });
        if (!firstAccount) {
          console.warn(`[instagram-webhook] No accounts in DB, skipping entry`);
          continue;
        }
        accountId = firstAccount.id;
        console.warn(
          `[instagram-webhook] No credentials found at all — falling back to first account=${accountId} for entryId=${entryId}`
        );
      } else {
        // Fallback 3: Single-account setup — if there's only one distinct account
        // across all credentials, use it. The entryId mismatch is likely due to
        // the Instagram Business Account ID not being stored during OAuth.
        const uniqueAccountIds = Array.from(
          new Set(allCredentials.map((c) => c.accountId))
        );
        if (uniqueAccountIds.length === 1) {
          accountId = uniqueAccountIds[0];
          console.warn(
            `[instagram-webhook] entryId=${entryId} didn't match any stored IDs, ` +
              `but only one account exists — using account=${accountId}. ` +
              `Consider re-connecting Instagram to fix the ID mismatch.`
          );
        } else {
          console.error(
            `[instagram-webhook] No IntegrationCredential found for entryId=${entryId}. ` +
              `Multiple accounts exist (${uniqueAccountIds.length}), cannot guess which one. ` +
              `Stored credentials: ${allCredentials
                .map((c) => {
                  const m = c.metadata as any;
                  return `account=${c.accountId} ${c.provider}:pageId=${m?.pageId},igUserId=${m?.igUserId},igAcct=${m?.instagramAccountId}`;
                })
                .join(' | ')}`
          );
          continue;
        }
      }
    }

    // ── Gate: skip if no active INSTAGRAM credential for this account ────
    // A META-only credential (Messenger) should NOT enable Instagram DM
    // processing. The Meta OAuth callback auto-creates a separate INSTAGRAM
    // credential when the FB page has a linked IG Business Account, so
    // legitimate dual-platform users will still pass this gate.
    const hasIgCredential = allCredentials.some(
      (c) => c.accountId === accountId && c.provider === 'INSTAGRAM'
    );
    if (!hasIgCredential) {
      console.log(
        `[instagram-webhook] No INSTAGRAM credential for account=${accountId}, skipping`
      );
      continue;
    }

    // ── Resolve page/business account ID for admin message detection ──
    const credMeta = (matchedCred?.metadata as any) || {};
    const pageOwnIds = new Set(
      [
        entryId,
        credMeta.pageId,
        credMeta.igUserId,
        credMeta.instagramAccountId,
        credMeta.igBusinessAccountId
      ].filter(Boolean)
    );

    // ── Handle messaging events (new DM received) ──────────────────────
    for (const event of entry.messaging ?? []) {
      if (!event.message) continue;

      const senderId: string = event.sender?.id ?? '';
      const recipientId: string = event.recipient?.id ?? '';
      const messageText: string = event.message?.text ?? '';
      const attachments = Array.isArray(event.message?.attachments)
        ? event.message.attachments
        : [];
      const platformMessageId: string = event.message?.mid ?? '';
      const isEcho: boolean = event.message?.is_echo === true;

      if (
        !messageText &&
        !hasImageAttachment(attachments) &&
        !hasAudioAttachment(attachments)
      )
        continue;

      // ── Admin/page message detection ────────────────────────────────
      // Meta sends message echoes when the page sends a message (is_echo=true)
      // Also detect by checking if senderId matches any known page/business IDs
      const isAdminMessage = isEcho || pageOwnIds.has(senderId);

      console.log(
        `[instagram-webhook] Message: sender=${senderId}, recipient=${recipientId}, ` +
          `isEcho=${isEcho}, isAdmin=${isAdminMessage}, pageOwnIds=[${Array.from(pageOwnIds).join(',')}], ` +
          `text="${messageText?.slice(0, 50)}" attachments=${attachments.length}`
      );

      if (isAdminMessage) {
        const audioUrl = firstAudioAttachmentUrl(attachments);
        // FAILURE A 2026-05-02: operator voice note echoes were
        // dropped by `if (!messageText) continue` above. Now we
        // accept the echo when EITHER text OR audio is present and
        // pass the audioUrl through so the admin handler can mark
        // the saved row as a voice note + cancel pending AI replies.
        if (!messageText && !audioUrl) continue;
        // This message was sent by the business/admin, not the lead
        const leadPlatformUserId = isEcho
          ? recipientId
          : recipientId || senderId;
        console.log(
          `[instagram-webhook] Admin message detected (is_echo=${isEcho}, sender=${senderId}, voiceNote=${Boolean(audioUrl)}), lead=${leadPlatformUserId}`
        );
        try {
          const { processAdminMessage } = await import(
            '@/lib/webhook-processor'
          );
          await processAdminMessage({
            accountId,
            platformUserId: leadPlatformUserId,
            platform: 'INSTAGRAM',
            messageText: messageText || (audioUrl ? '[Voice note]' : ''),
            audioUrl: audioUrl ?? undefined,
            platformMessageId: platformMessageId || undefined
          });
        } catch (adminErr) {
          console.error(
            `[instagram-webhook] Failed to process admin message:`,
            adminErr
          );
        }
        continue; // Don't trigger AI reply for admin messages
      }

      if (!senderId) continue;

      try {
        // Attempt to fetch the sender's profile for name/handle
        let senderName = senderId;
        let senderHandle = senderId;

        try {
          const { getUserProfile } = await import('@/lib/instagram');
          // Pass entryId as the known IG Business Account ID so
          // getUserProfile can use it for the conversations API without
          // needing to re-derive it from credential metadata (which may
          // not have it stored under the right key).
          const profile = await getUserProfile(accountId, senderId, entryId);
          senderName = profile.name || senderId;
          senderHandle = profile.username || senderId;
          console.log(
            `[instagram-webhook] Resolved profile: ${senderName} (@${senderHandle})`
          );
        } catch (profileErr: any) {
          console.warn(
            `[instagram-webhook] Profile fetch failed for ${senderId}: ${profileErr?.message || profileErr}`
          );
        }

        const result = await processIncomingMessage({
          accountId,
          platformUserId: senderId,
          platform: 'INSTAGRAM',
          senderName,
          senderHandle,
          messageText,
          attachments,
          triggerType: 'DM',
          platformMessageId: platformMessageId || undefined
        });

        // Skip the AI reply trigger when processIncomingMessage already
        // determined this delivery should not produce a reply (deduped
        // retry, "clear conversation" command, P2002 race). Otherwise Meta's
        // webhook retries cause two ScheduledReply rows to be created for
        // one inbound message and the AI sends the same opener twice — the
        // bug tegaumukoro_ saw on 2026-04-08.
        if (result.skipReply) {
          continue;
        }

        // Check conversation AI toggle and platform-specific away mode.
        // Legacy account.awayMode is only a fallback when the platform flag is
        // null/undefined; an explicit Instagram=false must win.
        const [convo, account] = await Promise.all([
          prisma.conversation.findUnique({
            where: { id: result.conversationId },
            select: { aiActive: true }
          }),
          prisma.account.findUnique({
            where: { id: accountId },
            select: {
              awayMode: true,
              awayModeInstagram: true,
              awayModeFacebook: true
            }
          })
        ]);
        const awayModeForPlatform = resolvePlatformAwayMode(
          account,
          'INSTAGRAM'
        );
        if (convo?.aiActive || awayModeForPlatform) {
          // Decide between inline (after()) and queued (cron) execution.
          // The cron runs every minute, so a 30-45s configured delay would
          // typically wait an extra 0-60s for the next tick, making the
          // total feel like 90s+ to the user. For short delays we keep the
          // lambda alive via after() and process inline — no cron lag.
          const delaySeconds = await computeReplyDelaySeconds(accountId);
          const targetConvoId = result.conversationId;

          if (delaySeconds <= INLINE_DELAY_THRESHOLD_SECONDS) {
            console.log(
              `[instagram-webhook] Inline-deferring reply for ${targetConvoId} ` +
                `(${delaySeconds}s, threshold ${INLINE_DELAY_THRESHOLD_SECONDS}s)`
            );
            after(async () => {
              try {
                if (delaySeconds > 0) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, delaySeconds * 1000)
                  );
                }
                // Re-check aiActive at delivery time — the user may have
                // toggled AI off during the delay window.
                const fresh = await prisma.conversation.findUnique({
                  where: { id: targetConvoId },
                  select: { aiActive: true }
                });
                if (!fresh?.aiActive) {
                  console.log(
                    `[instagram-webhook] inline reply cancelled — aiActive flipped off for ${targetConvoId}`
                  );
                  return;
                }
                await processScheduledReply(targetConvoId, accountId);
                console.log(
                  `[instagram-webhook] inline reply delivered for ${targetConvoId}`
                );
              } catch (afterErr) {
                console.error(
                  `[instagram-webhook] inline reply failed for ${targetConvoId}:`,
                  afterErr
                );
              }
            });
          } else {
            // Long delay — fall back to the durable cron queue. Pass the
            // skipDelayQueue=false flow that scheduleAIReply already handles.
            await scheduleAIReply(targetConvoId, accountId);
          }
        }
      } catch (err) {
        console.error(
          `[instagram-webhook] Failed to process DM from ${senderId}:`,
          err
        );
      }
    }

    // ── Comments: ignored for now (trigger-word feature coming later) ──
    // Comments are received via entry.changes with field === 'comments'
    // but we skip processing to avoid creating DM conversations from comments.
  }
}
