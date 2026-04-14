import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// PUT    /api/settings/scripts/[scriptId]/steps/[stepId] — Update step
// DELETE /api/settings/scripts/[scriptId]/steps/[stepId] — Delete step
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; stepId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, stepId } = await params;
    const body = await req.json();

    // Verify ownership
    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const step = await prisma.scriptStep.update({
      where: { id: stepId },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && {
          description: body.description
        }),
        ...(body.objective !== undefined && { objective: body.objective })
      },
      include: {
        branches: {
          orderBy: { sortOrder: 'asc' },
          include: {
            actions: {
              orderBy: { sortOrder: 'asc' },
              include: {
                voiceNote: {
                  select: {
                    id: true,
                    userLabel: true,
                    audioFileUrl: true,
                    durationSeconds: true
                  }
                }
              }
            }
          }
        },
        actions: {
          where: { branchId: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            voiceNote: {
              select: {
                id: true,
                userLabel: true,
                audioFileUrl: true,
                durationSeconds: true
              }
            }
          }
        }
      }
    });

    return NextResponse.json(step);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/steps] PUT error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; stepId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, stepId } = await params;

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.scriptStep.delete({ where: { id: stepId } });

    // Re-number remaining steps
    const remaining = await prisma.scriptStep.findMany({
      where: { scriptId },
      orderBy: { stepNumber: 'asc' },
      select: { id: true }
    });
    if (remaining.length > 0) {
      await prisma.$transaction(
        remaining.map((s, i) =>
          prisma.scriptStep.update({
            where: { id: s.id },
            data: { stepNumber: i + 1 }
          })
        )
      );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/steps] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
