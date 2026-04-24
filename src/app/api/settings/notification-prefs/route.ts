import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET / PATCH /api/settings/notification-prefs
// ---------------------------------------------------------------------------
// Out-of-app escalation preferences: where to email + which categories
// opt into email. Per Account, account-scoped via requireAuth. Used by
// the /dashboard/settings/notifications page.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: {
        notificationEmail: true,
        notifyOnSchedulingConflict: true,
        notifyOnDistress: true,
        notifyOnStuckLead: true,
        notifyOnAIStuck: true,
        notifyOnAllAIPauses: true
      }
    });
    return NextResponse.json(
      account ?? {
        notificationEmail: null,
        notifyOnSchedulingConflict: true,
        notifyOnDistress: true,
        notifyOnStuckLead: true,
        notifyOnAIStuck: true,
        notifyOnAllAIPauses: false
      }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[notification-prefs:GET] error:', err);
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const body = await request.json();
    const data: Record<string, unknown> = {};

    if ('notificationEmail' in body) {
      const v = body.notificationEmail;
      if (v === null || v === '') {
        data.notificationEmail = null;
      } else if (typeof v === 'string' && EMAIL_RE.test(v.trim())) {
        data.notificationEmail = v.trim();
      } else {
        return NextResponse.json(
          { error: 'Invalid notificationEmail' },
          { status: 400 }
        );
      }
    }
    const BOOL_FIELDS = [
      'notifyOnSchedulingConflict',
      'notifyOnDistress',
      'notifyOnStuckLead',
      'notifyOnAIStuck',
      'notifyOnAllAIPauses'
    ] as const;
    for (const k of BOOL_FIELDS) {
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
      select: {
        notificationEmail: true,
        notifyOnSchedulingConflict: true,
        notifyOnDistress: true,
        notifyOnStuckLead: true,
        notifyOnAIStuck: true,
        notifyOnAllAIPauses: true
      }
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[notification-prefs:PATCH] error:', err);
    return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
  }
}
