import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// PUT    /api/settings/scripts/[scriptId]/forms/[formId] — Update form
// DELETE /api/settings/scripts/[scriptId]/forms/[formId] — Delete form
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; formId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, formId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const form = await prisma.scriptForm.update({
      where: { id: formId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description })
      },
      include: { fields: { orderBy: { sortOrder: 'asc' } } }
    });

    return NextResponse.json(form);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/forms] PUT error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; formId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId, formId } = await params;

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Nullify formId on actions referencing this form
    await prisma.scriptAction.updateMany({
      where: { formId },
      data: { formId: null }
    });

    await prisma.scriptForm.delete({ where: { id: formId } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/forms] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
