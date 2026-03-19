import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/settings/away-mode — current away mode status
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: { awayMode: true, awayModeEnabledAt: true }
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({
      awayMode: account.awayMode,
      awayModeEnabledAt: account.awayModeEnabledAt?.toISOString() ?? null
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/away-mode error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch away mode status' },
      { status: 500 }
    );
  }
}

// PUT /api/settings/away-mode — toggle away mode on/off
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Only ADMIN can toggle away mode
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can toggle away mode' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { awayMode } = body;

    if (typeof awayMode !== 'boolean') {
      return NextResponse.json(
        { error: 'awayMode must be a boolean' },
        { status: 400 }
      );
    }

    const account = await prisma.account.update({
      where: { id: auth.accountId },
      data: {
        awayMode,
        awayModeEnabledAt: awayMode ? new Date() : null
      },
      select: { awayMode: true, awayModeEnabledAt: true }
    });

    console.log(
      `[away-mode] Account ${auth.accountId} away mode ${awayMode ? 'ENABLED' : 'DISABLED'} by ${auth.name}`
    );

    return NextResponse.json({
      awayMode: account.awayMode,
      awayModeEnabledAt: account.awayModeEnabledAt?.toISOString() ?? null
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/away-mode error:', error);
    return NextResponse.json(
      { error: 'Failed to update away mode' },
      { status: 500 }
    );
  }
}
