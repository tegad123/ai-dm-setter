import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { verifyToken, getTokenFromHeader } from '@/lib/auth';
import { requireAuth, AuthError } from '@/lib/auth-guard';

export async function GET(request: Request) {
  try {
    // Strategy 1: Try JWT token from Authorization header
    const authHeader = request.headers.get('Authorization');
    const token = getTokenFromHeader(authHeader);

    if (token) {
      const payload = verifyToken(token);
      if (payload) {
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            accountId: true,
            avatarUrl: true
          }
        });

        if (user) {
          const account = await prisma.account.findUnique({
            where: { id: user.accountId },
            select: {
              id: true,
              name: true,
              slug: true,
              logoUrl: true,
              brandName: true,
              primaryColor: true,
              plan: true,
              onboardingComplete: true
            }
          });

          return NextResponse.json({ user, account });
        }
      }
    }

    // Strategy 2: Try Clerk session (cookie-based auth)
    try {
      const auth = await requireAuth(request);

      const user = await prisma.user.findUnique({
        where: { id: auth.userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          accountId: true,
          avatarUrl: true
        }
      });

      if (!user) {
        return NextResponse.json(
          { error: 'User not found' },
          { status: 404 }
        );
      }

      const account = await prisma.account.findUnique({
        where: { id: user.accountId },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          brandName: true,
          primaryColor: true,
          plan: true,
          onboardingComplete: true
        }
      });

      return NextResponse.json({ user, account });
    } catch (e) {
      if (e instanceof AuthError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  } catch (error) {
    console.error('GET /api/auth/me error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
