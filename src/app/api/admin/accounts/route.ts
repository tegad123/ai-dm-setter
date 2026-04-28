// GET /api/admin/accounts — super-admin overview of every tenant
// account. Returns the row shape needed by /admin's accounts table:
// account meta + leadsTotal + leadsToday + aiMessagesToday +
// callsBookedMonth + revenueMonth + lastActive + healthStatus.
//
// All counts are best-effort COUNT queries — fast enough for the
// expected scale (low hundreds of accounts) and avoid maintaining a
// per-account aggregate cache. A future Phase 3 cache would just
// replace the inline computeMetrics call.

import prisma from '@/lib/prisma';
import { requireSuperAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function GET(request: NextRequest) {
  try {
    await requireSuperAdmin(request);

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const accounts = await prisma.account.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        planStatus: true,
        healthStatus: true,
        lastHealthCheck: true,
        monthlyApiCostUsd: true,
        createdAt: true,
        users: {
          where: { role: 'ADMIN', isActive: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { email: true, name: true }
        }
      }
    });

    // Aggregate counts in parallel per account. Count queries are
    // indexed lookups — fine for low-hundred account counts.
    const rows = await Promise.all(
      accounts.map(async (acct) => {
        const [
          leadsTotal,
          leadsToday,
          aiMessagesToday,
          callsBookedMonth,
          lastLead
        ] = await Promise.all([
          prisma.lead.count({ where: { accountId: acct.id } }),
          prisma.lead.count({
            where: {
              accountId: acct.id,
              createdAt: { gte: startOfToday }
            }
          }),
          prisma.message.count({
            where: {
              sender: 'AI',
              timestamp: { gte: startOfToday },
              conversation: { lead: { accountId: acct.id } }
            }
          }),
          prisma.lead.count({
            where: {
              accountId: acct.id,
              stage: { in: ['BOOKED', 'SHOWED', 'CLOSED_WON'] },
              stageEnteredAt: { gte: startOfMonth }
            }
          }),
          prisma.lead.findFirst({
            where: { accountId: acct.id },
            orderBy: { updatedAt: 'desc' },
            select: { updatedAt: true }
          })
        ]);

        const revenueAgg = await prisma.lead.aggregate({
          where: {
            accountId: acct.id,
            stageEnteredAt: { gte: startOfMonth }
          },
          _sum: { revenue: true }
        });

        return {
          id: acct.id,
          name: acct.name,
          slug: acct.slug,
          ownerEmail: acct.users[0]?.email ?? null,
          ownerName: acct.users[0]?.name ?? null,
          plan: acct.plan,
          planStatus: acct.planStatus,
          health: acct.healthStatus,
          lastHealthCheck: acct.lastHealthCheck?.toISOString() ?? null,
          leadsTotal,
          leadsToday,
          aiMessagesToday,
          callsBookedMonth,
          revenueMonth: Number(revenueAgg._sum.revenue ?? 0),
          monthlyApiCostUsd: Number(acct.monthlyApiCostUsd ?? 0),
          lastActive: lastLead?.updatedAt?.toISOString() ?? null,
          createdAt: acct.createdAt.toISOString()
        };
      })
    );

    // Top-of-page summary cards.
    const summary = {
      totalAccounts: rows.length,
      activeToday: rows.filter((r) => r.aiMessagesToday > 0 || r.leadsToday > 0)
        .length,
      leadsAllTime: rows.reduce((sum, r) => sum + r.leadsTotal, 0),
      aiMessagesToday: rows.reduce((sum, r) => sum + r.aiMessagesToday, 0),
      apiCostMonth: rows.reduce((sum, r) => sum + r.monthlyApiCostUsd, 0),
      revenueMonth: rows.reduce((sum, r) => sum + r.revenueMonth, 0)
    };

    return NextResponse.json({ accounts: rows, summary });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[GET /api/admin/accounts] fatal:', err);
    return NextResponse.json(
      { error: 'Failed to load accounts' },
      { status: 500 }
    );
  }
}
