import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST /api/settings/scripts/[scriptId]/steps — Create a new step
// PUT  /api/settings/scripts/[scriptId]/steps — Reorder steps
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Get the next step number
    const maxStep = await prisma.scriptStep.findFirst({
      where: { scriptId },
      orderBy: { stepNumber: 'desc' },
      select: { stepNumber: true }
    });
    const nextNumber = (maxStep?.stepNumber ?? 0) + 1;

    const step = await prisma.scriptStep.create({
      data: {
        scriptId,
        stepNumber: nextNumber,
        title: body.title || `Step ${nextNumber}`,
        description: body.description || '',
        objective: body.objective || ''
      },
      include: {
        branches: { include: { actions: true } },
        actions: { where: { branchId: null } }
      }
    });

    return NextResponse.json(step, { status: 201 });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/steps] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { stepIds } = body;

    if (!Array.isArray(stepIds)) {
      return NextResponse.json(
        { error: 'stepIds array required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Update step numbers to match array order
    await prisma.$transaction(
      stepIds.map((id: string, index: number) =>
        prisma.scriptStep.update({
          where: { id },
          data: { stepNumber: index + 1 }
        })
      )
    );

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/steps] PUT reorder error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
