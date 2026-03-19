import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const versions = await prisma.promptVersion.findMany({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return NextResponse.json({ versions });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/prompt-versions error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch prompt versions' },
      { status: 500 }
    );
  }
}
