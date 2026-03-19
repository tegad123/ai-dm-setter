import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// PUT /api/tags/[id] — update a tag
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();
    const { name, color, isAuto } = body;

    // Verify tag belongs to account
    const existing = await prisma.tag.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) {
      data.name = name
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '_')
        .replace(/[^A-Z0-9_]/g, '');
    }
    if (color !== undefined) data.color = color;
    if (isAuto !== undefined) data.isAuto = isAuto;

    const tag = await prisma.tag.update({ where: { id }, data });

    return NextResponse.json(tag);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/tags/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update tag' },
      { status: 500 }
    );
  }
}

// DELETE /api/tags/[id] — delete a tag
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const existing = await prisma.tag.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    // Cascade deletes LeadTag entries automatically
    await prisma.tag.delete({ where: { id } });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/tags/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete tag' },
      { status: 500 }
    );
  }
}
