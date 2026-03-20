import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const test = await prisma.aBTest.findFirst({
      where: { id, accountId: auth.accountId },
      include: { assignments: true }
    });

    if (!test) {
      return NextResponse.json(
        { error: 'A/B test not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ test });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/ab-tests/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch A/B test' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    const existing = await prisma.aBTest.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'A/B test not found' },
        { status: 404 }
      );
    }

    const { status, sampleSizeTarget } = body;

    const updateData: Record<string, unknown> = {};
    if (status !== undefined) {
      if (!['RUNNING', 'COMPLETED', 'PAUSED'].includes(status)) {
        return NextResponse.json(
          { error: 'Invalid status. Must be RUNNING, COMPLETED, or PAUSED' },
          { status: 400 }
        );
      }
      updateData.status = status;
      if (status === 'COMPLETED') {
        updateData.completedAt = new Date();
      }
    }
    if (sampleSizeTarget !== undefined) {
      updateData.sampleSizeTarget = sampleSizeTarget;
    }

    const test = await prisma.aBTest.update({
      where: { id },
      data: updateData
    });

    return NextResponse.json({ test });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/admin/ab-tests/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update A/B test' },
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

    const existing = await prisma.aBTest.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'A/B test not found' },
        { status: 404 }
      );
    }

    await prisma.aBTest.delete({ where: { id } });

    return NextResponse.json({ message: 'A/B test deleted successfully' });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/admin/ab-tests/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete A/B test' },
      { status: 500 }
    );
  }
}
