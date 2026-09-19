import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { acceptQueuedManyChatHandoff } from '@/lib/manychat-handoff-receipt';
import {
  ManyChatHandoffError,
  processManyChatHandoff
} from '@/lib/manychat-handoff';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

async function notifyQueuedHandoffFailure(params: {
  webhookKey: string | null;
  error: ManyChatHandoffError;
}) {
  const key = params.webhookKey?.trim();
  if (!key) return;

  try {
    const account = await prisma.account.findUnique({
      where: { manyChatWebhookKey: key },
      select: { id: true }
    });
    if (!account) return;

    const title = 'ManyChat first-reply intake failed';
    const reason = params.error.message.slice(0, 800);
    const recent = await prisma.notification.findFirst({
      where: { accountId: account.id, title },
      orderBy: { createdAt: 'desc' },
      select: { body: true, createdAt: true }
    });
    const sameReason = recent?.body?.includes(reason) ?? false;
    const recentEnough =
      recent && Date.now() - recent.createdAt.getTime() < 30 * 60 * 1000;
    if (sameReason && recentEnough) return;

    await prisma.notification.create({
      data: {
        accountId: account.id,
        type: 'SYSTEM',
        title,
        body: `The queued ManyChat first-reply callback was not accepted. No AI work was created. HTTP ${params.error.status}. Reason: ${reason}`
      }
    });
  } catch {
    // The response remains authoritative even if the best-effort alert cannot be saved.
  }
}

function getWebhookKey(request: NextRequest): string | null {
  const url = new URL(request.url);
  return (
    request.headers.get('x-qualifydms-key') ||
    url.searchParams.get('key') ||
    url.searchParams.get('apiKey') ||
    url.searchParams.get('qualifydmsKey')
  );
}

export async function POST(request: NextRequest) {
  let queuedFirstReply = false;
  try {
    // Empty/malformed body is a client error, not a server crash — the 500
    // at 2026-08-04 20:22 was request.json() throwing on an empty body from
    // a mid-wiring External Request test ("Unexpected end of JSON input").
    const payload = await request.json().catch(() => {
      throw new ManyChatHandoffError(
        'Request body is not valid JSON (empty or malformed). The ManyChat External Request must send a JSON body.',
        400
      );
    });
    queuedFirstReply = payload?.processingMode === 'queued_first_reply';
    if (queuedFirstReply) {
      const receipt = await acceptQueuedManyChatHandoff({
        webhookKey: getWebhookKey(request),
        payload
      });
      return NextResponse.json(receipt, { status: 200 });
    }
    const result = await processManyChatHandoff({
      webhookKey: getWebhookKey(request),
      payload
    });

    return NextResponse.json(
      {
        ok: true,
        duplicate: result.duplicate,
        leadId: result.leadId,
        conversationId: result.conversationId
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof ManyChatHandoffError) {
      if (queuedFirstReply) {
        await notifyQueuedHandoffFailure({
          webhookKey: getWebhookKey(request),
          error: err
        });
      }
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    if (queuedFirstReply) {
      await notifyQueuedHandoffFailure({
        webhookKey: getWebhookKey(request),
        error: new ManyChatHandoffError('Durable receipt intake failed', 500)
      });
    }
    // Prisma errors may include query parameters; never log request credentials.
    console.error('[manychat-handoff] processing failed');
    return NextResponse.json(
      { error: 'Failed to process ManyChat handoff' },
      { status: 500 }
    );
  }
}
