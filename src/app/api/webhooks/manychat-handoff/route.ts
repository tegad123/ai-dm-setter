import { NextRequest, NextResponse } from 'next/server';
import { acceptQueuedManyChatHandoff } from '@/lib/manychat-handoff-receipt';
import {
  ManyChatHandoffError,
  processManyChatHandoff
} from '@/lib/manychat-handoff';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
    if (payload?.processingMode === 'queued_first_reply') {
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
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    // Prisma errors may include query parameters; never log request credentials.
    console.error('[manychat-handoff] processing failed');
    return NextResponse.json(
      { error: 'Failed to process ManyChat handoff' },
      { status: 500 }
    );
  }
}
