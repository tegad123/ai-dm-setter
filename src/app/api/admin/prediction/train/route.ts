import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { trainModel } from '@/lib/booking-predictor';
import { NextRequest, NextResponse } from 'next/server';

const MIN_CONVERSATIONS = 200;

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    // Check if account has enough resolved conversations to train
    const resolvedCount = await prisma.conversation.count({
      where: {
        lead: { accountId: auth.accountId },
        outcome: { not: 'ONGOING' }
      }
    });

    if (resolvedCount < MIN_CONVERSATIONS) {
      return NextResponse.json(
        {
          error: 'Insufficient data to train prediction model',
          conversationsNeeded: MIN_CONVERSATIONS,
          currentCount: resolvedCount,
          remaining: MIN_CONVERSATIONS - resolvedCount
        },
        { status: 400 }
      );
    }

    const result = await trainModel(auth.accountId);

    return NextResponse.json({
      modelId: result.modelId,
      version: result.version,
      metrics: result.metrics
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/prediction/train error:', error);
    return NextResponse.json(
      { error: 'Failed to train prediction model' },
      { status: 500 }
    );
  }
}
