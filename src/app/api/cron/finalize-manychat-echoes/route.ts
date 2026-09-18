import { NextRequest, NextResponse } from 'next/server';
import { finalizeManyChatEchoAttributions } from '@/lib/manychat-echo-finalizer';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await finalizeManyChatEchoAttributions({ limit: 25 });
    return NextResponse.json(result, { status: result.failed > 0 ? 500 : 200 });
  } catch (error) {
    console.error(
      '[manychat-echo-finalizer] batch failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
    return NextResponse.json(
      { error: 'Echo attribution processing unavailable' },
      { status: 500 }
    );
  }
}
