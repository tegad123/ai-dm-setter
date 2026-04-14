import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST   /api/settings/scripts/.../forms/[formId]/fields — Create field
// PUT    — Update field
// DELETE — Delete field
// ---------------------------------------------------------------------------

export async function POST(
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

    // Get next sort order
    const maxField = await prisma.scriptFormField.findFirst({
      where: { formId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true }
    });
    const nextOrder = (maxField?.sortOrder ?? -1) + 1;

    const field = await prisma.scriptFormField.create({
      data: {
        formId,
        fieldLabel: body.fieldLabel || 'New Field',
        fieldValue: body.fieldValue ?? null,
        sortOrder: nextOrder
      }
    });

    return NextResponse.json(field, { status: 201 });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/fields] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string; formId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { fieldId, ...data } = body;

    if (!fieldId) {
      return NextResponse.json(
        { error: 'fieldId is required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const field = await prisma.scriptFormField.update({
      where: { id: fieldId },
      data: {
        ...(data.fieldLabel !== undefined && { fieldLabel: data.fieldLabel }),
        ...(data.fieldValue !== undefined && { fieldValue: data.fieldValue }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder })
      }
    });

    return NextResponse.json(field);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/fields] PUT error:', err);
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
    const { scriptId } = await params;
    const body = await req.json();
    const { fieldId } = body;

    if (!fieldId) {
      return NextResponse.json(
        { error: 'fieldId is required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.scriptFormField.delete({ where: { id: fieldId } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/fields] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
