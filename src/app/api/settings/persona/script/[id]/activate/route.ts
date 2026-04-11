import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: breakdownId } = await params;

    // Fetch breakdown with sections and ambiguities
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id: breakdownId, accountId: auth.accountId },
      include: { sections: true, ambiguities: true }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    // Validate: at least one section must be approved
    const hasApprovedSection = breakdown.sections.some((s) => s.userApproved);
    if (!hasApprovedSection) {
      return NextResponse.json(
        { error: 'At least one section must be approved before activation.' },
        { status: 400 }
      );
    }

    // Validate: all ambiguities must be resolved
    const unresolvedAmbiguities = breakdown.ambiguities.filter(
      (a) => !a.resolved
    );
    if (unresolvedAmbiguities.length > 0) {
      const n = unresolvedAmbiguities.length;
      const noun = n === 1 ? 'ambiguity' : 'ambiguities';
      return NextResponse.json(
        { error: `${n} ${noun} must be resolved before activation.` },
        { status: 400 }
      );
    }

    // Activate within a transaction
    const activated = await prisma.$transaction(async (tx) => {
      // Archive any other ACTIVE breakdowns for this account
      await tx.personaBreakdown.updateMany({
        where: {
          accountId: auth.accountId,
          status: 'ACTIVE',
          id: { not: breakdownId }
        },
        data: { status: 'ARCHIVED' }
      });

      // Set this breakdown to ACTIVE
      const updated = await tx.personaBreakdown.update({
        where: { id: breakdownId },
        data: { status: 'ACTIVE' },
        include: { sections: true, ambiguities: true }
      });

      // Update the AIPersona record
      await tx.aIPersona.update({
        where: { id: breakdown.personaId },
        data: {
          rawScript: breakdown.sourceText,
          rawScriptFileName: breakdown.sourceFileName,
          isActive: true
        }
      });

      return updated;
    });

    return NextResponse.json(activated);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'POST /api/settings/persona/script/[id]/activate error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to activate breakdown' },
      { status: 500 }
    );
  }
}
