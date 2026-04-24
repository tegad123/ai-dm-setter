import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET / PATCH /api/settings/notification-prefs
// ---------------------------------------------------------------------------
// Per-account notification preferences. Three groups:
//   URGENT (in-app + email): distress, scheduling_conflict, ai_stuck
//   ACTIVITY (in-app only): humanOverride, callBooked, hotLead,
//                           bookingLimbo, noShow, closedDeal
//   EMAIL REPORTS: dailySummary, weeklyReport
//
// GET also returns `accountEmail` — the read-only destination for email
// notifications (the owner's registered Clerk/Account email, not a
// separately-editable field). The page renders this under "Reports
// sent to: ..." so the operator knows where alerts land.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  notifyOnDistress: true,
  notifyOnSchedulingConflict: true,
  notifyOnAIStuck: true,
  notifyOnHumanOverride: true,
  notifyOnCallBooked: true,
  notifyOnHotLead: true,
  notifyOnBookingLimbo: true,
  notifyOnNoShow: true,
  notifyOnClosedDeal: true,
  emailDailySummary: true,
  emailWeeklyReport: true
} as const;

type PrefKey = keyof typeof DEFAULTS;
const PREF_KEYS = Object.keys(DEFAULTS) as PrefKey[];

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const [account] = await Promise.all([
      prisma.account.findUnique({
        where: { id: auth.accountId },
        select: PREF_KEYS.reduce(
          (acc, k) => {
            (acc as Record<string, true>)[k] = true;
            return acc;
          },
          {} as Record<PrefKey, true>
        )
      })
    ]);
    return NextResponse.json({
      ...DEFAULTS,
      ...(account ?? {}),
      accountEmail: auth.email
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[notification-prefs:GET] error:', err);
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const body = await request.json();
    const data: Record<string, boolean> = {};

    for (const k of PREF_KEYS) {
      if (k in body) {
        if (typeof body[k] !== 'boolean') {
          return NextResponse.json(
            { error: `${k} must be boolean` },
            { status: 400 }
          );
        }
        data[k] = body[k];
      }
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields' },
        { status: 400 }
      );
    }

    const updated = await prisma.account.update({
      where: { id: auth.accountId },
      data,
      select: PREF_KEYS.reduce(
        (acc, k) => {
          (acc as Record<string, true>)[k] = true;
          return acc;
        },
        {} as Record<PrefKey, true>
      )
    });
    return NextResponse.json({ ...updated, accountEmail: auth.email });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[notification-prefs:PATCH] error:', err);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
