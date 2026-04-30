import { NextRequest, NextResponse } from 'next/server';
import {
  processTypeformWebhook,
  TypeformWebhookError
} from '@/lib/typeform-webhook';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const { searchParams } = new URL(request.url);

  try {
    const result = await processTypeformWebhook({
      accountId: searchParams.get('accountId'),
      rawBody,
      signature: request.headers.get('typeform-signature')
    });

    return NextResponse.json(
      {
        ok: true,
        duplicate: result.duplicate,
        matched: result.matched,
        leadId: result.leadId,
        conversationId: result.conversationId
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof TypeformWebhookError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[typeform-webhook] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to process Typeform webhook' },
      { status: 500 }
    );
  }
}
