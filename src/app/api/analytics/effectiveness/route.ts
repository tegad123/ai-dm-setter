import { requireAuth, AuthError } from '@/lib/auth-guard';
import { checkColdStart, DATA_THRESHOLDS } from '@/lib/cold-start';
import { calculateMessageEffectiveness } from '@/lib/effectiveness-scorer';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const coldStart = await checkColdStart(
      auth.accountId,
      DATA_THRESHOLDS.MESSAGE_EFFECTIVENESS
    );

    const scores = await calculateMessageEffectiveness(auth.accountId);

    return NextResponse.json({
      scores,
      coldStart
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch effectiveness scores:', error);
    return NextResponse.json(
      { error: 'Failed to fetch effectiveness scores' },
      { status: 500 }
    );
  }
}
