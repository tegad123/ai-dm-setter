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
    console.warn('[instagram-webhook] Invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // Return 200 immediately — Meta requires a fast response.
  // Process events asynchronously.
  const payload = JSON.parse(rawBody);

  // Fire-and-forget processing so we respond within Meta's timeout
  processInstagramEvents(payload).catch((err) => {
    console.error('[instagram-webhook] Event processing error:', err);
  });

  return NextResponse.json({ received: true }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Async event processor
// ---------------------------------------------------------------------------

async function processInstagramEvents(payload: any): Promise<void> {
  if (payload.object !== 'instagram') return;

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

    if (!matchedCred) {
      console.warn(
        `[instagram-webhook] No IntegrationCredential found for pageId=${pageId}, skipping entry`
      );
      continue;
    }

    const accountId = matchedCred.accountId;

    // ── Handle messaging events (new DM received) ──────────────────────
    for (const event of entry.messaging ?? []) {
      if (!event.message) continue;

      const senderId: string = event.sender?.id ?? '';
      const messageText: string = event.message?.text ?? '';

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
          triggerType: 'DM'
        });

        // If AI is active, schedule a reply
        await scheduleAIReply(result.conversationId);
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
