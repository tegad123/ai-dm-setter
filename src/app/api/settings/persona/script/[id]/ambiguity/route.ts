import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: breakdownId } = await params;
    const body = await req.json();
    const { ambiguityId, userAnswer } = body as {
      ambiguityId: string;
      userAnswer: string;
    };

    if (!ambiguityId || !userAnswer?.trim()) {
      return NextResponse.json(
        { error: 'ambiguityId and userAnswer are required' },
        { status: 400 }
      );
    }

    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id: breakdownId, accountId: auth.accountId }
    });
    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    const ambiguity = await prisma.breakdownAmbiguity.findFirst({
      where: { id: ambiguityId, breakdownId }
    });
    if (!ambiguity) {
      return NextResponse.json(
        { error: 'Ambiguity not found' },
        { status: 404 }
      );
    }

    const updated = await prisma.breakdownAmbiguity.update({
      where: { id: ambiguityId },
      data: {
        userAnswer: userAnswer.trim(),
        resolved: true
      }
    });

    return NextResponse.json({ ambiguity: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /persona/script/[id]/ambiguity error:', error);
    return NextResponse.json(
      { error: 'Failed to resolve ambiguity' },
      { status: 500 }
    );
  }
}
