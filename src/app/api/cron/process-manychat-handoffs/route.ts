import { NextRequest, NextResponse } from 'next/server';
import { processManyChatHandoffReceipts } from '@/lib/manychat-handoff-worker';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (process.env.MANYCHAT_QUEUED_HANDOFF_PAUSED === 'true') {
    return NextResponse.json({ paused: true });
  }
  try {
    return NextResponse.json(
      await processManyChatHandoffReceipts({ limit: 3 })
    );
  } catch {
    // Database/SDK errors can include parameters. Do not log raw credentials or payloads.
    console.error('[manychat-handoff-worker] batch failed');
    return NextResponse.json(
      { error: 'Handoff processing unavailable' },
      { status: 500 }
    );
  }
}
