import { NextRequest, NextResponse } from 'next/server';
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
    const payload = await request.json();
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
    console.error('[manychat-handoff] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to process ManyChat handoff' },
      { status: 500 }
    );
  }
}
