import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// PUT    /api/settings/scripts/.../branches/[branchId] — Update branch
// DELETE /api/settings/scripts/.../branches/[branchId] — Delete branch
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  {
    params
  }: { params: Promise<{ scriptId: string; stepId: string; branchId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, branchId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const branch = await prisma.scriptBranch.update({
      where: { id: branchId },
      data: {
        ...(body.branchLabel !== undefined && {
          branchLabel: body.branchLabel
        }),
        ...(body.conditionDescription !== undefined && {
          conditionDescription: body.conditionDescription
        })
      },
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
    });

    return NextResponse.json(branch);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/branches] PUT error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; branchId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, branchId } = await params;

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.scriptBranch.delete({ where: { id: branchId } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/branches] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
