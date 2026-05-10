import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

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

    const RESPONSE_DELAY_MIN_FLOOR = 0;
    const RESPONSE_DELAY_MAX_CEILING = 3600;

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (brandName !== undefined) data.brandName = brandName;
    if (logoUrl !== undefined) data.logoUrl = logoUrl;
    if (primaryColor !== undefined) data.primaryColor = primaryColor;
    if (onboardingComplete !== undefined)
      data.onboardingComplete = onboardingComplete;
    if (ghostThresholdDays !== undefined)
      data.ghostThresholdDays = ghostThresholdDays;

    if (responseDelayMin !== undefined) {
      if (
        typeof responseDelayMin !== 'number' ||
        !Number.isFinite(responseDelayMin) ||
        responseDelayMin < RESPONSE_DELAY_MIN_FLOOR ||
        responseDelayMin > RESPONSE_DELAY_MAX_CEILING
      ) {
        return NextResponse.json(
          {
            error: `responseDelayMin must be between ${RESPONSE_DELAY_MIN_FLOOR} and ${RESPONSE_DELAY_MAX_CEILING} seconds`
          },
          { status: 400 }
        );
      }
      data.responseDelayMin = Math.floor(responseDelayMin);
    }
    if (responseDelayMax !== undefined) {
      if (
        typeof responseDelayMax !== 'number' ||
        !Number.isFinite(responseDelayMax) ||
        responseDelayMax < RESPONSE_DELAY_MIN_FLOOR ||
        responseDelayMax > RESPONSE_DELAY_MAX_CEILING
      ) {
        return NextResponse.json(
          {
            error: `responseDelayMax must be between ${RESPONSE_DELAY_MIN_FLOOR} and ${RESPONSE_DELAY_MAX_CEILING} seconds`
          },
          { status: 400 }
        );
      }
      data.responseDelayMax = Math.floor(responseDelayMax);
    }

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

    const existingAccount = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: {
        responseDelayMin: true,
        responseDelayMax: true
      }
    });

    if (!existingAccount) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const effectiveDelayMin =
      (data.responseDelayMin as number | undefined) ??
      existingAccount.responseDelayMin ??
      300;
    const effectiveDelayMax =
      (data.responseDelayMax as number | undefined) ??
      existingAccount.responseDelayMax ??
      600;
    if (
      (data.responseDelayMin !== undefined ||
        data.responseDelayMax !== undefined) &&
      effectiveDelayMax < effectiveDelayMin
    ) {
      data.responseDelayMax = effectiveDelayMin;
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
      { error: `Failed to update account: ${errorMessage(error)}` },
      { status: 500 }
    );
  }
}
