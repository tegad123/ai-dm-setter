// GET/PUT /api/admin/accounts/[id]/ai-delivery — platform-operator kill
// switch for AI delivery on a tenant account, per platform.
//
// "Suggestions only" = Account.generateOnly<Platform> = true: the full
// pipeline still runs and every draft is stored as a suggestion with its
// shadow row, but nothing is delivered to the lead. It is the exact state a
// workspace sits in before go-live, so flipping back to it is a zero-risk,
// instant, no-deploy stop. Platform operators (SUPER_ADMIN / MANAGER) only.

import prisma from '@/lib/prisma';
import { requirePlatformAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const SELECT = {
  id: true,
  name: true,
  generateOnlyInstagram: true,
  generateOnlyFacebook: true,
  awayModeInstagram: true,
  awayModeFacebook: true,
  showSuggestionBanner: true
} as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin(request);
    const { id } = await params;
    const acct = await prisma.account.findUnique({
      where: { id },
      select: SELECT
    });
    if (!acct)
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    return NextResponse.json(acct);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/accounts/[id]/ai-delivery error:', error);
    return NextResponse.json(
      { error: 'Failed to read AI delivery state' },
      { status: 500 }
    );
  }
}

// Body: { generateOnlyInstagram?: boolean, generateOnlyFacebook?: boolean }
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requirePlatformAdmin(request);
    const { id } = await params;
    const body = (await request.json()) as {
      generateOnlyInstagram?: unknown;
      generateOnlyFacebook?: unknown;
    };
    const data: {
      generateOnlyInstagram?: boolean;
      generateOnlyFacebook?: boolean;
    } = {};
    if (typeof body.generateOnlyInstagram === 'boolean')
      data.generateOnlyInstagram = body.generateOnlyInstagram;
    if (typeof body.generateOnlyFacebook === 'boolean')
      data.generateOnlyFacebook = body.generateOnlyFacebook;
    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        {
          error:
            'Provide generateOnlyInstagram and/or generateOnlyFacebook as booleans'
        },
        { status: 400 }
      );
    }
    const before = await prisma.account.findUnique({
      where: { id },
      select: SELECT
    });
    if (!before)
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    const acct = await prisma.account.update({
      where: { id },
      data,
      select: SELECT
    });
    console.warn(
      `[ai-delivery] ${auth.email ?? auth.name} (${auth.role}) set account ${id} (${acct.name}): ` +
        `generateOnlyInstagram ${before.generateOnlyInstagram}→${acct.generateOnlyInstagram}, ` +
        `generateOnlyFacebook ${before.generateOnlyFacebook}→${acct.generateOnlyFacebook}`
    );
    return NextResponse.json(acct);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/admin/accounts/[id]/ai-delivery error:', error);
    return NextResponse.json(
      { error: 'Failed to update AI delivery state' },
      { status: 500 }
    );
  }
}
