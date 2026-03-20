import { requireAuth, AuthError } from '@/lib/auth-guard';
import { evaluateModel } from '@/lib/booking-predictor';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    const evaluation = await evaluateModel(auth.accountId);

    return NextResponse.json(evaluation);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/prediction/evaluate error:', error);
    return NextResponse.json(
      { error: 'Failed to evaluate prediction model' },
      { status: 500 }
    );
  }
}
