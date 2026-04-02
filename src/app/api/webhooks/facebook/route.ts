import { NextRequest, NextResponse } from 'next/server';
import { verifyWebhookSignature } from '@/lib/facebook';
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

    // ── Handle messaging events (new Messenger DM received) ────────────
    for (const event of entry.messaging ?? []) {
      if (!event.message) continue;

      const senderId: string = event.sender?.id ?? '';
      const messageText: string = event.message?.text ?? '';
      const platformMessageId: string = event.message?.mid ?? '';

      if (!senderId || !messageText) continue;

      try {
        // Attempt to fetch the sender's profile
        let senderName = senderId;

        try {
          const { getUserProfile } = await import('@/lib/facebook');
          const profile = await getUserProfile(accountId, senderId);
          senderName = profile.name || senderId;
        } catch {
          // Profile fetch can fail for privacy reasons — use ID as fallback
        }

        const result = await processIncomingMessage({
          accountId,
          platformUserId: senderId,
          platform: 'FACEBOOK',
          senderName,
          senderHandle: senderName, // Facebook doesn't have separate handles
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
          `[facebook-webhook] Failed to process DM from ${senderId}:`,
          err
        );
      }
    }

    // ── Comments: ignored for now (trigger-word feature coming later) ──
  }
}
