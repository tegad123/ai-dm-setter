import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/settings/training-phase — Fetch account's training phase status
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: {
        trainingPhase: true,
        trainingPhaseStartedAt: true,
        trainingPhaseCompletedAt: true,
        trainingTargetOverrideCount: true,
        trainingOverrideCount: true
      }
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({ trainingPhase: account });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/training-phase error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch training phase' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/settings/training-phase — Advance training phase
// ---------------------------------------------------------------------------

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can update training phase' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'complete') {
      // Complete training — move to ACTIVE
      const account = await prisma.account.update({
        where: { id: auth.accountId },
        data: {
          trainingPhase: 'ACTIVE',
          trainingPhaseCompletedAt: new Date()
        },
        select: {
          trainingPhase: true,
          trainingPhaseStartedAt: true,
          trainingPhaseCompletedAt: true,
          trainingTargetOverrideCount: true,
          trainingOverrideCount: true
        }
      });

      return NextResponse.json({ trainingPhase: account });
    }

    if (action === 'pause') {
      const account = await prisma.account.update({
        where: { id: auth.accountId },
        data: { trainingPhase: 'PAUSED' },
        select: {
          trainingPhase: true,
          trainingPhaseStartedAt: true,
          trainingPhaseCompletedAt: true,
          trainingTargetOverrideCount: true,
          trainingOverrideCount: true
        }
      });

      return NextResponse.json({ trainingPhase: account });
    }

    if (action === 'resume') {
      // Resume from PAUSED: go back to ONBOARDING without wiping the
      // accumulated counter. Used when admin had paused training and wants
      // to keep the prior override credit.
      const account = await prisma.account.update({
        where: { id: auth.accountId },
        data: { trainingPhase: 'ONBOARDING' },
        select: {
          trainingPhase: true,
          trainingPhaseStartedAt: true,
          trainingPhaseCompletedAt: true,
          trainingTargetOverrideCount: true,
          trainingOverrideCount: true
        }
      });

      return NextResponse.json({ trainingPhase: account });
    }

    if (action === 'restart') {
      // Full restart: used when admin wants to re-enter onboarding from
      // ACTIVE, typically because the AI's voice drifted or because the
      // account was grandfathered in wrongly and never actually trained.
      // Zeroes the counter and resets the session window.
      const account = await prisma.account.update({
        where: { id: auth.accountId },
        data: {
          trainingPhase: 'ONBOARDING',
          trainingPhaseStartedAt: new Date(),
          trainingPhaseCompletedAt: null,
          trainingOverrideCount: 0
        },
        select: {
          trainingPhase: true,
          trainingPhaseStartedAt: true,
          trainingPhaseCompletedAt: true,
          trainingTargetOverrideCount: true,
          trainingOverrideCount: true
        }
      });

      return NextResponse.json({ trainingPhase: account });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use: complete, pause, resume, or restart' },
      { status: 400 }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/training-phase error:', error);
    return NextResponse.json(
      { error: 'Failed to update training phase' },
      { status: 500 }
    );
  }
}
