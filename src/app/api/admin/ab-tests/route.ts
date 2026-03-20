import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const tests = await prisma.aBTest.findMany({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return NextResponse.json({ tests });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/ab-tests error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch A/B tests' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();

    const { testName, stage, variantA, variantB, metric, sampleSizeTarget } =
      body;

    if (!testName || !stage || !variantA || !variantB) {
      return NextResponse.json(
        {
          error: 'Missing required fields: testName, stage, variantA, variantB'
        },
        { status: 400 }
      );
    }

    const test = await prisma.aBTest.create({
      data: {
        accountId: auth.accountId,
        testName,
        stage,
        variantA,
        variantB,
        ...(metric && { metric }),
        ...(sampleSizeTarget && { sampleSizeTarget })
      }
    });

    return NextResponse.json({ test }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/ab-tests error:', error);
    return NextResponse.json(
      { error: 'Failed to create A/B test' },
      { status: 500 }
    );
  }
}
