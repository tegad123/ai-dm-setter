import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST /api/settings/scripts/[scriptId]/steps/[stepId]/branches — Create branch
// PUT  — Reorder branches
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; stepId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, stepId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Get next sort order
    const maxBranch = await prisma.scriptBranch.findFirst({
      where: { stepId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true }
    });
    const nextOrder = (maxBranch?.sortOrder ?? -1) + 1;

    const branch = await prisma.scriptBranch.create({
      data: {
        stepId,
        branchLabel: body.branchLabel || 'New Branch',
        conditionDescription: body.conditionDescription || null,
        sortOrder: nextOrder
      },
      include: {
        actions: { orderBy: { sortOrder: 'asc' } }
      }
    });

    return NextResponse.json(branch, { status: 201 });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/branches] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; stepId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { branchIds } = body;

    if (!Array.isArray(branchIds)) {
      return NextResponse.json(
        { error: 'branchIds array required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.$transaction(
      branchIds.map((id: string, index: number) =>
        prisma.scriptBranch.update({
          where: { id },
          data: { sortOrder: index }
        })
      )
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/branches] PUT reorder error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
