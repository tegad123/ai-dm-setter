// GET /api/admin/onboard/[accountId]/status — drives the resume path
// + lights up the progress dots in the wizard. Returns onboarding
// step, IG/FB credential presence, persona config presence,
// training-data count.

import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    await requireSuperAdmin(request);
    const { accountId } = await params;

    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        planStatus: true,
        onboardingStep: true,
        onboardingComplete: true,
        awayModeInstagram: true,
        awayModeFacebook: true,
        users: {
          where: { role: 'ADMIN' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { id: true, email: true, name: true, isActive: true }
        },
        integrations: {
          where: { isActive: true },
          select: { provider: true, updatedAt: true }
        },
        personas: {
          select: {
            id: true,
            personaName: true,
            fullName: true,
            minimumCapitalRequired: true,
            updatedAt: true
          }
        }
      }
    });
    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const trainingCount = await prisma.trainingExample.count({
      where: { accountId }
    });

    const persona = account.personas[0] ?? null;
    const personaConfigured = Boolean(
      persona &&
        persona.minimumCapitalRequired !== null &&
        persona.minimumCapitalRequired !== undefined
    );
    const igConnected = account.integrations.some(
      (c) => c.provider === 'INSTAGRAM'
    );
    const fbConnected = account.integrations.some((c) => c.provider === 'META');

    return NextResponse.json({
      accountId: account.id,
      name: account.name,
      slug: account.slug,
      plan: account.plan,
      planStatus: account.planStatus,
      onboardingStep: account.onboardingStep,
      onboardingComplete: account.onboardingComplete,
      awayModeInstagram: account.awayModeInstagram,
      awayModeFacebook: account.awayModeFacebook,
      owner: account.users[0] ?? null,
      meta: {
        instagramConnected: igConnected,
        facebookConnected: fbConnected
      },
      persona: persona
        ? {
            id: persona.id,
            personaName: persona.personaName,
            fullName: persona.fullName,
            minimumCapitalRequired: persona.minimumCapitalRequired,
            configured: personaConfigured
          }
        : null,
      trainingCount
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[GET onboard status] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to load onboarding status' },
      { status: 500 }
    );
  }
}
