// POST /api/admin/onboard/[accountId]/activate — Phase 2 Step 6.
// Final activation: flips both awayMode toggles on, marks
// onboardingComplete, writes a SYSTEM notification flagging the
// new-account "review first 10 conversations" follow-up, and logs
// the action.

import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const auth = await requireSuperAdmin(request);
    const { accountId } = await params;

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        onboardingComplete: true,
        awayModeInstagram: true,
        awayModeFacebook: true
      }
    });
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const acct = await tx.account.update({
        where: { id: accountId },
        data: {
          awayModeInstagram: true,
          awayModeInstagramEnabledAt: now,
          awayModeFacebook: true,
          awayModeFacebookEnabledAt: now,
          onboardingComplete: true,
          onboardingStep: 6
        }
      });
      await tx.notification.create({
        data: {
          accountId,
          type: 'SYSTEM',
          title: 'New account active — review first 10 conversations',
          body: `${account.name} is live. AI auto-send is on for both platforms (14-day trial). Review the first 10 lead conversations to verify quality before scaling.`
        }
      });
      await tx.adminLog.create({
        data: {
          adminUserId: auth.userId,
          targetAccountId: accountId,
          action: 'onboard.activate',
          metadata: {
            awayModeInstagram: true,
            awayModeFacebook: true,
            previousAwayModeInstagram: account.awayModeInstagram,
            previousAwayModeFacebook: account.awayModeFacebook
          }
        }
      });
      return acct;
    });

    return NextResponse.json({
      ok: true,
      account: {
        id: updated.id,
        name: updated.name,
        onboardingComplete: updated.onboardingComplete,
        awayModeInstagram: updated.awayModeInstagram,
        awayModeFacebook: updated.awayModeFacebook
      }
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[POST onboard/activate] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to activate account' },
      { status: 500 }
    );
  }
}
