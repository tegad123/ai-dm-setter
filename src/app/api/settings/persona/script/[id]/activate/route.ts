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

    // Sprint 3: Lenient activation — ambiguities and unfilled slots do NOT
    // block activation. The AI falls back to text or skips actions at runtime.
    // Only blocking voice note slots (BLOCK_UNTIL_FILLED) still gate activation.
    const unreadySlots = await prisma.voiceNoteSlot.findMany({
      where: {
        breakdownId,
        status: 'EMPTY',
        fallbackBehavior: 'BLOCK_UNTIL_FILLED'
      }
    });
    if (unreadySlots.length > 0) {
      const n = unreadySlots.length;
      const noun = n === 1 ? 'voice note slot' : 'voice note slots';
      return NextResponse.json(
        {
          error: `${n} ${noun} need audio uploads or an approved fallback.`,
          unreadySlots: unreadySlots.map((s) => ({
            id: s.id,
            name: s.slotName
          }))
        },
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
        include: {
          sections: true,
          ambiguities: true,
          scriptSlots: {
            orderBy: { orderIndex: 'asc' },
            include: {
              boundVoiceNote: {
                select: {
                  id: true,
                  userLabel: true,
                  audioFileUrl: true,
                  durationSeconds: true,
                  summary: true
                }
              }
            }
          }
        }
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
