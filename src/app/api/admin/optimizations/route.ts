import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { generateOptimizations } from '@/lib/optimization-engine';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const suggestions = await prisma.optimizationSuggestion.findMany({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return NextResponse.json({ suggestions });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/optimizations error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch optimization suggestions' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const suggestions = await generateOptimizations(auth.accountId);

    return NextResponse.json({ suggestions });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/optimizations error:', error);
    return NextResponse.json(
      { error: 'Failed to generate optimization suggestions' },
      { status: 500 }
    );
  }
}
