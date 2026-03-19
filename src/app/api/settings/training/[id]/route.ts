import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    // Verify training example belongs to this account
    const existing = await prisma.trainingExample.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Training example not found' },
        { status: 404 }
      );
    }

    const allowedFields = ['category', 'leadMessage', 'idealResponse', 'notes'];
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    }

    const example = await prisma.trainingExample.update({
      where: { id },
      data,
      include: {
        persona: {
          select: { id: true, personaName: true }
        }
      }
    });

    return NextResponse.json(example);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/training/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update training example' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Verify training example belongs to this account
    const existing = await prisma.trainingExample.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json(
        { error: 'Training example not found' },
        { status: 404 }
      );
    }

    await prisma.trainingExample.delete({ where: { id } });

    return NextResponse.json({ message: 'Training example deleted' });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/settings/training/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete training example' },
      { status: 500 }
    );
  }
}
