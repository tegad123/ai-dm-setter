import { NextResponse } from 'next/server';
import { silentStopHeartbeat } from '@/lib/silent-stop-recovery';

export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await silentStopHeartbeat();
  return NextResponse.json({ ok: true, ...result });
}
