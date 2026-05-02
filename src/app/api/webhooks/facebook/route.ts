import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { verifyWebhookSignature } from '@/lib/facebook';
import {
  processIncomingMessage,
  scheduleAIReply,
  processScheduledReply,
  computeReplyDelaySeconds
} from '@/lib/webhook-processor';
import prisma from '@/lib/prisma';

// Vercel Hobby defaults to 10s — AI generation + send needs more time.
// Bumped to 120s to fit the inline-delay-then-reply path.
export const maxDuration = 120;

// Short delays bypass the per-minute cron and run inline via after().
const INLINE_DELAY_THRESHOLD_SECONDS = 90;

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
    console.log('[facebook-webhook] Verification successful');
    return new NextResponse(challenge, { status: 200 });
  }

  console.warn('[facebook-webhook] Verification failed');
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// ---------------------------------------------------------------------------
// POST — Receive webhook events from Meta (Facebook Messenger)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  // Read the raw body for signature verification
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';

  // Verify the webhook signature
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn(
      '[facebook-webhook] Invalid signature, raw sig:',
      signature?.slice(0, 20)
    );
    // In dev mode, continue processing even with invalid signature
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    console.warn('[facebook-webhook] Skipping signature check in dev mode');
  }

  // Return 200 immediately — Meta requires a fast response.
  const payload = JSON.parse(rawBody);
  for (const entry of payload.entry ?? []) {
    const debugEvents = [
      ...(entry.messaging ?? []).map((event: any) => ({
        event,
        bucket: 'messaging' as const
      })),
      ...(entry.standby ?? []).map((event: any) => ({
        event,
        bucket: 'standby' as const
      }))
    ];
    for (const { event, bucket } of debugEvents) {
      console.log(
        'FB WEBHOOK:',
        JSON.stringify({
          type: event.type ?? bucket,
          bucket,
          isEcho: event.message?.is_echo,
          senderId: event.sender?.id,
          recipientId: event.recipient?.id,
          text:
            typeof event.message?.text === 'string'
              ? event.message.text.substring(0, 50)
              : undefined,
          timestamp: new Date().toISOString()
        })
      );
    }
  }
  console.log(
    '[facebook-webhook] Received payload:',
    JSON.stringify(payload).slice(0, 500)
  );

  // Process synchronously for now (dev debugging) — switch to fire-and-forget in prod
  try {
    await processFacebookEvents(payload);
    console.log('[facebook-webhook] Processing complete');
  } catch (err) {
    console.error('[facebook-webhook] Event processing error:', err);
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Async event processor
// ---------------------------------------------------------------------------

async function processFacebookEvents(payload: any): Promise<void> {
  if (payload.object !== 'page') return;

  // Fetch all active META integration credentials once for account lookup
  const metaCredentials = await prisma.integrationCredential.findMany({
    where: { provider: 'META', isActive: true }
  });

  for (const entry of payload.entry ?? []) {
    // ── Resolve accountId from the page ID in the webhook entry ────────
    const pageId: string = entry.id ?? '';
    const matchedCred = metaCredentials.find(
      (cred) => (cred.metadata as any)?.pageId === pageId
    );

    let accountId: string;

    if (matchedCred) {
      accountId = matchedCred.accountId;
    } else {
      // Fallback 1: match via env var FACEBOOK_PAGE_ID → use first account in DB
      const envPageId = process.env.FACEBOOK_PAGE_ID;
      if (envPageId && envPageId === pageId) {
        const firstAccount = await prisma.account.findFirst({
          orderBy: { createdAt: 'asc' },
          select: { id: true }
        });
        if (!firstAccount) {
          console.warn(`[facebook-webhook] No accounts in DB, skipping entry`);
          continue;
        }
        accountId = firstAccount.id;
        console.log(
          `[facebook-webhook] Matched pageId=${pageId} via env var → account=${accountId}`
        );
      } else {
        // Fallback 2: Single-account setup — if only one account has credentials, use it
        const uniqueAccountIds = Array.from(
          new Set(metaCredentials.map((c) => c.accountId))
        );
        if (uniqueAccountIds.length === 1) {
          accountId = uniqueAccountIds[0];
          console.warn(
            `[facebook-webhook] pageId=${pageId} didn't match stored credentials, ` +
              `but only one account exists — using account=${accountId}`
          );
        } else if (metaCredentials.length === 0) {
          const firstAccount = await prisma.account.findFirst({
            orderBy: { createdAt: 'asc' },
            select: { id: true }
          });
          if (!firstAccount) {
            console.warn(
              `[facebook-webhook] No accounts in DB, skipping entry`
            );
            continue;
          }
          accountId = firstAccount.id;
          console.warn(
            `[facebook-webhook] No credentials found — falling back to first account=${accountId}`
          );
        } else {
          console.error(
            `[facebook-webhook] No IntegrationCredential found for pageId=${pageId}, ` +
              `and multiple accounts exist — cannot determine which account to use`
          );
          continue;
        }
      }
    }

    // ── Gate: skip if no active Meta credential for this account ────
    // When a user disconnects Facebook, the credential is deleted. No
    // credential = no processing.
    const hasMetaCredential = metaCredentials.some(
      (c) => c.accountId === accountId
    );
    if (!hasMetaCredential) {
      console.log(
        `[facebook-webhook] No active credential for account=${accountId}, skipping`
      );
      continue;
    }

    // ── Resolve page ID for admin message detection ────────────────────
    const credMeta = (matchedCred?.metadata as any) || {};
    const pageOwnIds = new Set(
      [pageId, credMeta.pageId, credMeta.instagramAccountId].filter(Boolean)
    );

    // ── Handle messaging events (new Messenger DM received) ────────────
    // Facebook Page Inbox / handover events can arrive under `standby`
    // instead of `messaging`. Treat both arrays as first-class events so
    // native Messenger replies still hit the admin echo capture path.
    const events = [
      ...(entry.messaging ?? []).map((event: any) => ({
        event,
        bucket: 'messaging' as const
      })),
      ...(entry.standby ?? []).map((event: any) => ({
        event,
        bucket: 'standby' as const
      }))
    ];

    for (const { event, bucket } of events) {
      console.log(
        'FB WEBHOOK:',
        JSON.stringify({
          type: event.type ?? bucket,
          bucket,
          isEcho: event.message?.is_echo,
          senderId: event.sender?.id,
          recipientId: event.recipient?.id,
          text:
            typeof event.message?.text === 'string'
              ? event.message.text.substring(0, 50)
              : undefined,
          timestamp: new Date().toISOString()
        })
      );

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
      const isAdminMessage = isEcho || pageOwnIds.has(senderId);

      console.log(
        `[facebook-webhook] Message: sender=${senderId}, recipient=${recipientId}, ` +
          `isEcho=${isEcho}, isAdmin=${isAdminMessage}, pageOwnIds=[${Array.from(pageOwnIds).join(',')}], ` +
          `bucket=${bucket}, text="${messageText?.slice(0, 50)}" attachments=${attachments.length}`
      );

      if (isAdminMessage) {
        const audioUrl = firstAudioAttachmentUrl(attachments);
        if (!messageText && !audioUrl) continue;
        const candidateLeadIds = Array.from(
          new Set(
            [recipientId, senderId].filter((id) => id && !pageOwnIds.has(id))
          )
        );
        const leadPlatformUserId =
          candidateLeadIds[0] ||
          (isEcho ? recipientId : recipientId || senderId);
        console.log(
          `[facebook-webhook] Admin message detected (is_echo=${isEcho}, sender=${senderId}, voiceNote=${Boolean(audioUrl)}), lead=${leadPlatformUserId}, candidates=[${candidateLeadIds.join(',')}]`
        );
        try {
          const { processAdminMessage } = await import(
            '@/lib/webhook-processor'
          );
          await processAdminMessage({
            accountId,
            platformUserId: leadPlatformUserId,
            platform: 'FACEBOOK',
            messageText: messageText || (audioUrl ? '[Voice note]' : ''),
            audioUrl: audioUrl ?? undefined,
            platformMessageId: platformMessageId || undefined,
            candidatePlatformUserIds: candidateLeadIds
          });
        } catch (adminErr) {
          console.error(
            `[facebook-webhook] Failed to process admin message:`,
            adminErr
          );
        }
        continue;
      }

      if (!senderId) continue;

      try {
        // Attempt to fetch the sender's profile
        let senderName = senderId;

        try {
          const { getUserProfile } = await import('@/lib/facebook');
          // Pass pageId so getUserProfile can use the conversations API
          // fallback without needing to re-derive it from credentials.
          const profile = await getUserProfile(accountId, senderId, pageId);
          senderName = profile.name || senderId;
          console.log(`[facebook-webhook] Resolved profile: ${senderName}`);
        } catch (profileErr: any) {
          // Both Graph-API strategies inside getUserProfile already log
          // [FB_PROFILE_FETCH_FAILED] with status + error body for each
          // attempt. This is the outer rollup — captures the final
          // throw + stack so the numeric-ID lead has a trailing log
          // tying "lead created with numeric name" to the specific
          // user whose lookup failed.
          console.error(
            `[FB_PROFILE_FETCH_FAILED] strategy=all-exhausted status=threw error=${profileErr?.stack || profileErr?.message || String(profileErr)} userId=${senderId}`
          );
        }

        const result = await processIncomingMessage({
          accountId,
          platformUserId: senderId,
          platform: 'FACEBOOK',
          senderName,
          senderHandle: senderName, // Facebook doesn't have separate handles
          messageText,
          attachments,
          triggerType: 'DM',
          platformMessageId: platformMessageId || undefined
        });

        // Skip the AI reply trigger when processIncomingMessage already
        // determined this delivery should not produce a reply (deduped
        // retry, "clear conversation" command, P2002 race). Otherwise Meta's
        // webhook retries cause two ScheduledReply rows to be created for
        // one inbound message.
        if (result.skipReply) {
          continue;
        }

        // Check conversation AI toggle AND account-level away mode
        const [convo, account] = await Promise.all([
          prisma.conversation.findUnique({
            where: { id: result.conversationId },
            select: { aiActive: true }
          }),
          prisma.account.findUnique({
            where: { id: accountId },
            select: { awayMode: true }
          })
        ]);
        if (convo?.aiActive || account?.awayMode) {
          const delaySeconds = await computeReplyDelaySeconds(accountId);
          const targetConvoId = result.conversationId;

          if (delaySeconds <= INLINE_DELAY_THRESHOLD_SECONDS) {
            console.log(
              `[facebook-webhook] Inline-deferring reply for ${targetConvoId} ` +
                `(${delaySeconds}s)`
            );
            after(async () => {
              try {
                if (delaySeconds > 0) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, delaySeconds * 1000)
                  );
                }
                const fresh = await prisma.conversation.findUnique({
                  where: { id: targetConvoId },
                  select: { aiActive: true }
                });
                if (!fresh?.aiActive) {
                  console.log(
                    `[facebook-webhook] inline reply cancelled — aiActive flipped off for ${targetConvoId}`
                  );
                  return;
                }
                await processScheduledReply(targetConvoId, accountId);
                console.log(
                  `[facebook-webhook] inline reply delivered for ${targetConvoId}`
                );
              } catch (afterErr) {
                console.error(
                  `[facebook-webhook] inline reply failed for ${targetConvoId}:`,
                  afterErr
                );
              }
            });
          } else {
            await scheduleAIReply(targetConvoId, accountId);
          }
        }
      } catch (err) {
        console.error(
          `[facebook-webhook] Failed to process DM from ${senderId}:`,
          err
        );
      }
    }

    // ── Comments: ignored for now (trigger-word feature coming later) ──
  }
}
