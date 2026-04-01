import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/instagram';
import {
  processIncomingMessage,
  scheduleAIReply,
  processCommentTrigger
} from '@/lib/webhook-processor';
import prisma from '@/lib/prisma';

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
  // Process events asynchronously.
  const payload = JSON.parse(rawBody);

  // Process synchronously for now (dev debugging) — switch to fire-and-forget in prod
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
        meta?.instagramAccountId === entryId
      );
    });

    console.log(
      `[instagram-webhook] entryId=${entryId}, matchedCred=${matchedCred?.id ?? 'NONE'}, ` +
      `allCreds=${allCredentials.map((c) => { const m = c.metadata as any; return `${c.provider}:pageId=${m?.pageId},igUserId=${m?.igUserId},igAcct=${m?.instagramAccountId}`; }).join(' | ')}`
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
        const uniqueAccountIds = [...new Set(allCredentials.map((c) => c.accountId))];
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
            `Stored credentials: ${allCredentials.map((c) => { const m = c.metadata as any; return `account=${c.accountId} ${c.provider}:pageId=${m?.pageId},igUserId=${m?.igUserId},igAcct=${m?.instagramAccountId}`; }).join(' | ')}`
          );
          continue;
        }
      }
    }

    // ── Handle messaging events (new DM received) ──────────────────────
    for (const event of entry.messaging ?? []) {
      if (!event.message) continue;

      const senderId: string = event.sender?.id ?? '';
      const messageText: string = event.message?.text ?? '';
      const platformMessageId: string = event.message?.mid ?? '';

      if (!senderId || !messageText) continue;

      try {
        // Attempt to fetch the sender's profile for name/handle
        let senderName = senderId;
        let senderHandle = senderId;

        try {
          const { getUserProfile } = await import('@/lib/instagram');
          const profile = await getUserProfile(accountId, senderId);
          senderName = profile.name || senderId;
          senderHandle = profile.username || senderId;
        } catch {
          // Profile fetch can fail for privacy reasons — use ID as fallback
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

    // ── Handle changes events (comments on posts) ──────────────────────
    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;

      const value = change.value;
      if (!value) continue;

      const commenterId: string = value.from?.id ?? '';
      const commenterName: string =
        value.from?.username ?? value.from?.name ?? commenterId;
      const commentText: string = value.text ?? '';
      const postId: string = value.media?.id ?? '';

      if (!commenterId || !commentText) continue;

      try {
        await processCommentTrigger({
          accountId,
          platformUserId: commenterId,
          platform: 'INSTAGRAM',
          commenterName,
          commenterHandle: commenterName,
          commentText,
          postId
        });
      } catch (err) {
        console.error(
          `[instagram-webhook] Failed to process comment from ${commenterId}:`,
          err
        );
      }
    }
  }
}
