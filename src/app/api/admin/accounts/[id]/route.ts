// GET /api/admin/accounts/[id] — full detail for one tenant account.
//
// Phase 1 returns Sections A (info), B (health checks), and C (30-day
// activity stats). Sections D (cost), E (recent issues), F (actions)
// are deferred to Phase 3.
//
// Side effect: persists the rollup health status + lastHealthCheck
// onto Account so the overview table reflects the latest run.

import prisma from '@/lib/prisma';
import { requirePlatformAdmin, AuthError } from '@/lib/auth-guard';
import { runHealthChecks, rollupStatus } from '@/lib/admin-health';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requirePlatformAdmin(request);
    const { id } = await params;

    const acct = await prisma.account.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        planStatus: true,
        trialEndsAt: true,
        monthlyApiCostUsd: true,
        healthStatus: true,
        lastHealthCheck: true,
        onboardingComplete: true,
        onboardingStep: true,
        createdAt: true,
        updatedAt: true,
        users: {
          where: { role: 'ADMIN' },
          orderBy: { createdAt: 'asc' },
          take: 5,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            isActive: true,
            createdAt: true
          }
        },
        integrations: {
          where: { isActive: true },
          select: {
            id: true,
            provider: true,
            createdAt: true,
            updatedAt: true,
            metadata: true
          }
        }
      }
    });
    if (!acct) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // ── Section A: Account info ─────────────────────────────────
    const owner = acct.users[0] ?? null;
    const igCred = acct.integrations.find((c) => c.provider === 'INSTAGRAM');
    const metaCred = acct.integrations.find((c) => c.provider === 'META');
    const lastWebhookMessage = await prisma.message.findFirst({
      where: {
        sender: 'LEAD',
        conversation: { lead: { accountId: acct.id } }
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    });

    const sectionA = {
      id: acct.id,
      name: acct.name,
      slug: acct.slug,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      plan: acct.plan,
      planStatus: acct.planStatus,
      trialEndsAt: acct.trialEndsAt?.toISOString() ?? null,
      onboardingComplete: acct.onboardingComplete,
      onboardingStep: acct.onboardingStep,
      createdAt: acct.createdAt.toISOString(),
      updatedAt: acct.updatedAt.toISOString(),
      instagramPageId:
        ((igCred?.metadata as Record<string, unknown> | null) ?? {}).igUserId ??
        null,
      facebookPageId:
        ((metaCred?.metadata as Record<string, unknown> | null) ?? {}).pageId ??
        null,
      lastWebhookAt: lastWebhookMessage?.timestamp.toISOString() ?? null,
      adminUsers: acct.users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        isActive: u.isActive,
        createdAt: u.createdAt.toISOString()
      }))
    };

    // ── Section B: Health checks (run + persist rollup) ────────
    const checks = await runHealthChecks(acct.id);
    const rollup = rollupStatus(checks);
    const now = new Date();
    await prisma.account.update({
      where: { id: acct.id },
      data: { healthStatus: rollup, lastHealthCheck: now }
    });
    const sectionB = {
      rollup,
      lastCheckedAt: now.toISOString(),
      checks: checks.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        detail: c.detail,
        lastCheckedAt: c.lastCheckedAt.toISOString()
      }))
    };

    // ── Section C: Activity stats (30 day window) ──────────────
    const start30 = new Date(now.getTime() - 30 * DAY_MS);

    // Daily series of LEAD vs AI vs HUMAN messages over 30 days. Pull
    // raw rows + bucket in JS — Postgres trunc would need raw SQL.
    const recentMessages = await prisma.message.findMany({
      where: {
        timestamp: { gte: start30 },
        conversation: { lead: { accountId: acct.id } }
      },
      select: { sender: true, timestamp: true }
    });
    const byDay: Record<string, { LEAD: number; AI: number; HUMAN: number }> =
      {};
    for (const m of recentMessages) {
      const d = m.timestamp.toISOString().slice(0, 10);
      if (!byDay[d]) byDay[d] = { LEAD: 0, AI: 0, HUMAN: 0 };
      const sender = m.sender as 'LEAD' | 'AI' | 'HUMAN';
      byDay[d][sender] = (byDay[d][sender] ?? 0) + 1;
    }
    const messagesByDay = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts }));

    const stageCounts = await prisma.lead.groupBy({
      by: ['stage'],
      _count: { id: true },
      where: { accountId: acct.id }
    });
    const stages = Object.fromEntries(
      stageCounts.map((s) => [s.stage, s._count.id])
    );

    const totalLeads = await prisma.lead.count({
      where: { accountId: acct.id }
    });
    const qualifiedCount = await prisma.lead.count({
      where: {
        accountId: acct.id,
        stage: {
          in: ['QUALIFIED', 'CALL_PROPOSED', 'BOOKED', 'SHOWED', 'CLOSED_WON']
        }
      }
    });
    const bookedCount =
      (stages['BOOKED'] ?? 0) +
      (stages['SHOWED'] ?? 0) +
      (stages['CLOSED_WON'] ?? 0);
    const showedCount = (stages['SHOWED'] ?? 0) + (stages['CLOSED_WON'] ?? 0);

    const avgQualityAgg = await prisma.aISuggestion.aggregate({
      where: {
        accountId: acct.id,
        generatedAt: { gte: start30 }
      },
      _avg: { qualityGateScore: true }
    });

    const sectionC = {
      windowDays: 30,
      messagesByDay,
      stages,
      qualificationRate: totalLeads > 0 ? qualifiedCount / totalLeads : 0,
      bookingRate: qualifiedCount > 0 ? bookedCount / qualifiedCount : 0,
      showRate: bookedCount > 0 ? showedCount / bookedCount : 0,
      avgQualityScore: avgQualityAgg._avg.qualityGateScore ?? null,
      totalLeads,
      qualifiedCount,
      bookedCount
    };

    return NextResponse.json({
      sectionA,
      sectionB,
      sectionC
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[GET /api/admin/accounts/:id] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to load account detail' },
      { status: 500 }
    );
  }
}
