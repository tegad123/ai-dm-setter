// POST /api/admin/onboard/[accountId]/persona — Phase 2 Step 3.
// Updates the AIPersona row created in Step 1 with the operator-
// supplied core fields. Bumps onboardingStep → 3.

import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    const auth = await requireSuperAdmin(request);
    const { accountId } = await params;
    const body = await request.json().catch(() => ({}));

    const persona = await prisma.aIPersona.findFirst({
      where: { accountId },
      select: { id: true }
    });
    if (!persona) {
      return NextResponse.json(
        { error: 'No AIPersona row for this account — run Step 1 first' },
        { status: 404 }
      );
    }

    const fullName = String(body?.fullName ?? '').trim();
    const personaName = String(body?.personaName ?? '').trim();
    const tone =
      typeof body?.tone === 'string'
        ? body.tone.trim()
        : 'casual, direct, friendly';
    const adminBio =
      typeof body?.adminBio === 'string' ? body.adminBio.trim() : null;
    const whatTheySell =
      typeof body?.whatTheySell === 'string' ? body.whatTheySell.trim() : null;
    const closerName =
      typeof body?.closerName === 'string' ? body.closerName.trim() : null;
    const minimumCapitalRequiredRaw = body?.minimumCapitalRequired;
    const minimumCapitalRequired =
      typeof minimumCapitalRequiredRaw === 'number' &&
      minimumCapitalRequiredRaw >= 0
        ? Math.round(minimumCapitalRequiredRaw)
        : null;
    const homeworkUrl =
      typeof body?.homeworkUrl === 'string' ? body.homeworkUrl.trim() : null;
    const youtubeFallbackUrl =
      typeof body?.youtubeFallbackUrl === 'string'
        ? body.youtubeFallbackUrl.trim()
        : null;
    const downsellUrl =
      typeof body?.downsellUrl === 'string' ? body.downsellUrl.trim() : null;
    const downsellPriceRaw = body?.downsellPriceUsd;
    const downsellPriceUsd =
      typeof downsellPriceRaw === 'number' && downsellPriceRaw >= 0
        ? Math.round(downsellPriceRaw * 100) / 100
        : null;
    const typeformUrl =
      typeof body?.typeformUrl === 'string' ? body.typeformUrl.trim() : null;
    const scopeAndLimits =
      typeof body?.scopeAndLimits === 'string'
        ? body.scopeAndLimits.trim()
        : null;
    const verifiedFacts =
      typeof body?.verifiedFacts === 'string'
        ? body.verifiedFacts.trim()
        : null;

    if (fullName.length < 2 || personaName.length < 2) {
      return NextResponse.json(
        { error: 'fullName + personaName are required' },
        { status: 400 }
      );
    }

    // Update only the columns we know exist on AIPersona — extra
    // operator-supplied fields land in `verifiedDetails` JSON for the
    // prompt builder to surface as a free-form context block.
    const verifiedDetails: Record<string, unknown> = {
      adminBio,
      whatTheySell,
      closerName,
      homeworkUrl,
      youtubeFallbackUrl,
      downsellUrl,
      downsellPriceUsd,
      typeformUrl,
      scopeAndLimits,
      verifiedFacts
    };

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.aIPersona.update({
        where: { id: persona.id },
        data: {
          fullName,
          personaName,
          tone,
          minimumCapitalRequired,
          // Cast to satisfy Prisma's `Json` input typing without
          // pulling the heavy types at the route layer.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          verifiedDetails: verifiedDetails as any
        },
        select: { id: true, minimumCapitalRequired: true }
      });
      // Bump onboardingStep — Step 3 of 6.
      await tx.account.update({
        where: { id: accountId },
        data: { onboardingStep: 3 }
      });
      await tx.adminLog.create({
        data: {
          adminUserId: auth.userId,
          targetAccountId: accountId,
          action: 'onboard.configure_persona',
          metadata: {
            minimumCapitalRequired,
            hasHomeworkUrl: Boolean(homeworkUrl),
            hasDownsellUrl: Boolean(downsellUrl),
            hasTypeformUrl: Boolean(typeformUrl)
          }
        }
      });
      return row;
    });

    return NextResponse.json({ ok: true, personaId: updated.id });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[POST onboard/persona] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to update persona' },
      { status: 500 }
    );
  }
}
