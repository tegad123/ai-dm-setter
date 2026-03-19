import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const triggerCounts = await prisma.lead.groupBy({
      by: ['triggerType'],
      _count: { id: true },
      where: { accountId: auth.accountId }
    });

    const data = triggerCounts.map((row) => ({
      trigger: row.triggerType === 'COMMENT' ? 'Comment' : 'DM',
      count: row._count.id
    }));

    return NextResponse.json({ data });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch trigger data:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trigger data' },
      { status: 500 }
    );
  }
}
