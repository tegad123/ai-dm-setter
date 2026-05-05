import { NextRequest, NextResponse } from 'next/server';
import {
  ManyChatCompleteError,
  processManyChatComplete
} from '@/lib/manychat-complete';

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
    const result = await processManyChatComplete({
      webhookKey: getWebhookKey(request),
      payload
    });

    return NextResponse.json(
      {
        success: true,
        conversationId: result.conversationId,
        alreadyHandedOff: result.alreadyHandedOff
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof ManyChatCompleteError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[manychat-complete] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to process ManyChat completion' },
      { status: 500 }
    );
  }
}
