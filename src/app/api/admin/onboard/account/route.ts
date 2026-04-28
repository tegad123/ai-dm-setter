// POST /api/admin/onboard/account
// Phase 2 Step 1 — super-admin creates a new tenant account, the
// initial admin User row (isActive=false until the owner signs in
// via Clerk), and an empty AIPersona row for the wizard's Step 3 to
// fill in. Sets onboardingStep=1 so the resume path returns here.

import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PLANS = ['FREE', 'PRO', 'ENTERPRISE'] as const;

export async function POST(request: NextRequest) {
  try {
    const auth = await requireSuperAdmin(request);
    const body = await request.json().catch(() => ({}));

    const businessName = String(body?.businessName ?? '').trim();
    const ownerName = String(body?.ownerName ?? '').trim();
    const ownerEmail = String(body?.ownerEmail ?? '')
      .trim()
      .toLowerCase();
    const ownerPhone =
      typeof body?.ownerPhone === 'string' ? body.ownerPhone.trim() : '';
    const plan = (body?.plan ?? 'FREE') as (typeof VALID_PLANS)[number];

    if (businessName.length < 2) {
      return NextResponse.json(
        { error: 'businessName is required (min 2 chars)' },
        { status: 400 }
      );
    }
    if (ownerName.length < 2) {
      return NextResponse.json(
        { error: 'ownerName is required' },
        { status: 400 }
      );
    }
    if (!EMAIL_RE.test(ownerEmail)) {
      return NextResponse.json(
        { error: 'ownerEmail must be a valid email' },
        { status: 400 }
      );
    }
    if (!VALID_PLANS.includes(plan)) {
      return NextResponse.json(
        { error: `plan must be one of: ${VALID_PLANS.join(', ')}` },
        { status: 400 }
      );
    }

    // Email collision: if another User already owns this email, refuse —
    // they'd land in their existing workspace on next sign-in.
    const existingUser = await prisma.user.findUnique({
      where: { email: ownerEmail },
      select: { id: true }
    });
    if (existingUser) {
      return NextResponse.json(
        { error: `${ownerEmail} already has a User row` },
        { status: 409 }
      );
    }

    // Slug derivation: lowercase + hyphens, ensure uniqueness with a
    // numeric suffix.
    const baseSlug =
      businessName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'tenant';
    let slug = baseSlug;
    let i = 1;
    while (await prisma.account.findUnique({ where: { slug } })) {
      i++;
      slug = `${baseSlug}-${i}`;
    }

    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          name: businessName,
          slug,
          plan,
          planStatus: 'TRIAL',
          trialEndsAt,
          onboardingStep: 1,
          onboardingComplete: false
        }
      });
      const user = await tx.user.create({
        data: {
          accountId: account.id,
          email: ownerEmail,
          name: ownerName,
          passwordHash: '', // Clerk-managed
          role: 'ADMIN',
          isActive: false // flips true on first Clerk sign-in (auth-guard)
        }
      });
      // Empty persona row — Step 3 fills it in.
      const personaName = `Sales ${ownerName.split(' ')[0] || 'Setter'}`;
      const systemPrompt = `You are ${ownerName}. You're messaging a lead who showed interest in your services. Your job is to qualify them and book a call. Be conversational and authentic — talk like a real person, not a bot. (Phase 2 placeholder — owner will refine via /admin/onboard step 3.)`;
      const persona = await tx.aIPersona.create({
        data: {
          accountId: account.id,
          personaName,
          fullName: ownerName,
          tone: 'casual, direct, friendly',
          systemPrompt
        }
      });
      await tx.adminLog.create({
        data: {
          adminUserId: auth.userId,
          targetAccountId: account.id,
          action: 'onboard.create_account',
          metadata: {
            ownerEmail,
            ownerName,
            plan,
            ownerPhone: ownerPhone || null
          }
        }
      });
      return {
        accountId: account.id,
        slug: account.slug,
        userId: user.id,
        personaId: persona.id
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[POST /api/admin/onboard/account] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to create account' },
      { status: 500 }
    );
  }
}
