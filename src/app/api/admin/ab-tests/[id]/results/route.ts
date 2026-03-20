import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkStatisticalSignificance } from '@/lib/ab-testing';
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

    const assignmentCount = test.assignments.length;
    const significance = checkStatisticalSignificance(
      test.resultsA as Record<string, unknown> | null,
      test.resultsB as Record<string, unknown> | null,
      test.countA,
      test.countB
    );

    return NextResponse.json({
      test,
      significance,
      assignmentCount
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/ab-tests/[id]/results error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch A/B test results' },
      { status: 500 }
    );
  }
}
