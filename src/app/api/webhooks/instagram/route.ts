import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/instagram';
import {
  processIncomingMessage,
  scheduleAIReply
} from '@/lib/webhook-processor';
import prisma from '@/lib/prisma';

// Vercel Hobby defaults to 10s — AI generation + send needs more time
export const maxDuration = 60;

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
  if (payload.object !== 'instagram') return;

  // Fetch all active META and INSTAGRAM integration credentials for account lookup
  const allCredentials = await prisma.integrationCredential.findMany({
    where: { provider: { in: ['META', 'INSTAGRAM'] }, isActive: true }
  });

  for (const entry of payload.entry ?? []) {
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
      const platformMessageId: string = event.message?.mid ?? '';
      const isEcho: boolean = event.message?.is_echo === true;

      if (!messageText) continue;

      // ── Admin/page message detection ────────────────────────────────
      // Meta sends message echoes when the page sends a message (is_echo=true)
      // Also detect by checking if senderId matches any known page/business IDs
      const isAdminMessage = isEcho || pageOwnIds.has(senderId);

      if (isAdminMessage) {
        // This message was sent by the business/admin, not the lead
        const leadPlatformUserId = isEcho
          ? recipientId
          : recipientId || senderId;
        console.log(
          `[instagram-webhook] Admin message detected (is_echo=${isEcho}, sender=${senderId}), lead=${leadPlatformUserId}`
        );
        try {
          const { processAdminMessage } = await import(
            '@/lib/webhook-processor'
          );
          await processAdminMessage({
            accountId,
            platformUserId: leadPlatformUserId,
            platform: 'INSTAGRAM',
            messageText,
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
          const profile = await getUserProfile(accountId, senderId);
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
          triggerType: 'DM',
          platformMessageId: platformMessageId || undefined
        });

        // Only schedule AI reply if AI is active on this conversation
        const convo = await prisma.conversation.findUnique({
          where: { id: result.conversationId },
          select: { aiActive: true }
        });
        if (convo?.aiActive) {
          await scheduleAIReply(result.conversationId, accountId);
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
