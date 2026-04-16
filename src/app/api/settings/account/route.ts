import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        brandName: true,
        primaryColor: true,
        plan: true,
        onboardingComplete: true,
        ghostThresholdDays: true,
        trainingPhase: true,
        trainingPhaseStartedAt: true,
        trainingPhaseCompletedAt: true,
        trainingTargetOverrideCount: true,
        trainingOverrideCount: true
      }
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    return NextResponse.json({ account });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/account error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch account' },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Only ADMIN can update account settings
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can update account settings' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const {
      name,
      brandName,
      logoUrl,
      primaryColor,
      onboardingComplete,
      ghostThresholdDays
    } = body;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (brandName !== undefined) data.brandName = brandName;
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (primaryColor !== undefined) data.primaryColor = primaryColor;
    if (onboardingComplete !== undefined)
      data.onboardingComplete = onboardingComplete;
    if (ghostThresholdDays !== undefined)
      data.ghostThresholdDays = ghostThresholdDays;

    const account = await prisma.account.update({
      where: { id: auth.accountId },
      data,
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        brandName: true,
        primaryColor: true,
        plan: true,
        onboardingComplete: true,
        ghostThresholdDays: true,
        trainingPhase: true,
        trainingPhaseStartedAt: true,
        trainingPhaseCompletedAt: true,
        trainingTargetOverrideCount: true,
        trainingOverrideCount: true
      }
    });

    return NextResponse.json({ account });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/account error:', error);
    return NextResponse.json(
      { error: 'Failed to update account' },
      { status: 500 }
    );
  }
}
