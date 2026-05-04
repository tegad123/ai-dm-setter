import { NextRequest, NextResponse } from 'next/server';
import {
  processLeadConnectorWebhook,
  LeadConnectorWebhookError
} from '@/lib/leadconnector-webhook';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// LeadConnector / GoHighLevel "Appointment Booked" webhooks. Sets
// Conversation.scheduledCallAt + schedules pre-call confirmation
// reminders. See `src/lib/leadconnector-webhook.ts` for matching
// strategy + auth model.

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const { searchParams } = new URL(request.url);

  try {
    const result = await processLeadConnectorWebhook({
      accountId: searchParams.get('accountId'),
      secret: searchParams.get('secret'),
      rawBody
    });

    return NextResponse.json(
      {
        ok: true,
        matched: result.matched,
        matchedBy: result.matchedBy,
        conversationId: result.conversationId,
        scheduledCallAt: result.scheduledCallAt
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof LeadConnectorWebhookError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[leadconnector-webhook] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to process LeadConnector webhook' },
      { status: 500 }
    );
  }
}
