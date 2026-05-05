import { NextRequest, NextResponse } from 'next/server';
import {
  ManyChatMessageError,
  processManyChatMessage
} from '@/lib/manychat-message';

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
    const result = await processManyChatMessage({
      webhookKey: getWebhookKey(request),
      payload
    });
    return NextResponse.json(
      {
        success: true,
        conversationId: result.conversationId,
        messageId: result.messageId,
        duplicate: result.duplicate
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof ManyChatMessageError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[manychat-message] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to process ManyChat message' },
      { status: 500 }
    );
  }
}
