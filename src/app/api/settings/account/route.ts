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
        trainingOverrideCount: true,
        responseDelayMin: true,
        responseDelayMax: true
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
      ghostThresholdDays,
      responseDelayMin,
      responseDelayMax
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
    if (typeof responseDelayMin === 'number' && responseDelayMin >= 0)
      data.responseDelayMin = Math.floor(responseDelayMin);
    if (typeof responseDelayMax === 'number' && responseDelayMax >= 0)
      data.responseDelayMax = Math.floor(responseDelayMax);

    // Normalize: ensure max >= min if either was updated
    if (
      data.responseDelayMin !== undefined ||
      data.responseDelayMax !== undefined
    ) {
      const min = (data.responseDelayMin as number | undefined) ?? undefined;
      const max = (data.responseDelayMax as number | undefined) ?? undefined;
      if (typeof min === 'number' && typeof max === 'number' && max < min) {
        data.responseDelayMax = min;
      }
    }

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
        trainingOverrideCount: true,
        responseDelayMin: true,
        responseDelayMax: true
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
