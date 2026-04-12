import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import type { ScriptStep, ScriptBranch } from '@/lib/script-framework-types';

// ---------------------------------------------------------------------------
// PUT /api/settings/persona/script/:id/step
// Edit a single script step within the breakdown's scriptSteps JSON.
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: breakdownId } = await params;
    const body = await req.json();
    const { stepId, title, branches, userApproved } = body as {
      stepId: string;
      title?: string;
      branches?: ScriptBranch[];
      userApproved?: boolean;
    };

    if (!stepId) {
      return NextResponse.json(
        { error: 'stepId is required' },
        { status: 400 }
      );
    }

    // Fetch breakdown
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id: breakdownId, accountId: auth.accountId }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = ((breakdown.scriptSteps as any) || []) as ScriptStep[];
    const stepIndex = steps.findIndex((s) => s.step_id === stepId);

    if (stepIndex === -1) {
      return NextResponse.json(
        { error: `Step "${stepId}" not found` },
        { status: 404 }
      );
    }

    // Apply updates
    const updatedStep = { ...steps[stepIndex] };
    if (title !== undefined) updatedStep.title = title;
    if (branches !== undefined) updatedStep.branches = branches;
    if (userApproved !== undefined) updatedStep.user_approved = userApproved;
    updatedStep.user_edited = true;

    const updatedSteps = [...steps];
    updatedSteps[stepIndex] = updatedStep;

    await prisma.personaBreakdown.update({
      where: { id: breakdownId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { scriptSteps: updatedSteps as any }
    });

    return NextResponse.json({ step: updatedStep });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('PUT /api/settings/persona/script/[id]/step error:', errMsg);
    return NextResponse.json(
      { error: `Failed to update step: ${errMsg}` },
      { status: 500 }
    );
  }
}
