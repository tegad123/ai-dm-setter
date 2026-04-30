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
import { requirePlatformAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECENT_ACTION_MS = 7 * DAY_MS;
const UPCOMING_CALL_MS = 48 * HOUR_MS;

type ActionSeverity = 'RED' | 'AMBER';

interface GlobalActionItem {
  id: string;
  accountId: string;
  accountName: string;
  conversationId: string | null;
  leadName: string;
  label: string;
  severity: ActionSeverity;
  occurredAt: string;
  href: string;
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin(request);

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
        onboardingComplete: true,
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
          todaysVolume,
          activeConversations,
          qualifiedToday,
          aiMessagesToday,
          callsBooked,
          lastLead,
          actionStats
        ] = await Promise.all([
          prisma.lead.count({ where: { accountId: acct.id } }),
          prisma.message.count({
            where: {
              timestamp: { gte: startOfToday },
              conversation: { lead: { accountId: acct.id } }
            }
          }),
          prisma.conversation.count({
            where: {
              lead: {
                accountId: acct.id,
                stage: {
                  notIn: [
                    'CLOSED_WON',
                    'CLOSED_LOST',
                    'UNQUALIFIED',
                    'GHOSTED',
                    'NURTURE'
                  ]
                }
              },
              lastMessageAt: { gte: new Date(now.getTime() - 7 * DAY_MS) }
            }
          }),
          prisma.lead.count({
            where: {
              accountId: acct.id,
              stage: {
                in: [
                  'QUALIFIED',
                  'CALL_PROPOSED',
                  'BOOKED',
                  'SHOWED',
                  'CLOSED_WON'
                ]
              },
              stageEnteredAt: { gte: startOfToday }
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
              stageEnteredAt: { gte: startOfToday }
            }
          }),
          prisma.lead.findFirst({
            where: { accountId: acct.id },
            orderBy: { updatedAt: 'desc' },
            select: { updatedAt: true }
          }),
          getAccountActionStats(acct.id, now)
        ]);

        const revenueAgg = await prisma.lead.aggregate({
          where: {
            accountId: acct.id,
            stageEnteredAt: { gte: startOfMonth }
          },
          _sum: { revenue: true }
        });

        const lastActive = lastLead?.updatedAt ?? null;
        const noActivity48h =
          acct.onboardingComplete &&
          (!lastActive || now.getTime() - lastActive.getTime() > 48 * HOUR_MS);
        const health =
          actionStats.distressCount > 0 ||
          actionStats.deliveryFailureCount > 0 ||
          noActivity48h
            ? 'CRITICAL'
            : actionStats.totalPending > 0
              ? 'WARNING'
              : 'HEALTHY';

        return {
          id: acct.id,
          name: acct.name,
          slug: acct.slug,
          ownerEmail: acct.users[0]?.email ?? null,
          ownerName: acct.users[0]?.name ?? null,
          plan: acct.plan,
          planStatus: acct.planStatus,
          health,
          lastHealthCheck: acct.lastHealthCheck?.toISOString() ?? null,
          leadsTotal,
          activeConversations,
          todaysVolume,
          qualifiedToday,
          aiMessagesToday,
          callsBooked,
          actionItemCount: actionStats.totalPending + (noActivity48h ? 1 : 0),
          revenueMonth: Number(revenueAgg._sum.revenue ?? 0),
          monthlyApiCostUsd: Number(acct.monthlyApiCostUsd ?? 0),
          lastActive: lastActive?.toISOString() ?? null,
          createdAt: acct.createdAt.toISOString()
        };
      })
    );

    const actionItems = (
      await Promise.all(
        accounts.map((acct) => getAccountActionItems(acct.id, acct.name, now))
      )
    )
      .flat()
      .sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'RED' ? -1 : 1;
        return (
          new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
        );
      })
      .slice(0, 40);

    // Top-of-page summary cards.
    const summary = {
      totalAccounts: rows.length,
      activeToday: rows.filter(
        (r) => r.aiMessagesToday > 0 || r.todaysVolume > 0
      ).length,
      leadsAllTime: rows.reduce((sum, r) => sum + r.leadsTotal, 0),
      aiMessagesToday: rows.reduce((sum, r) => sum + r.aiMessagesToday, 0),
      apiCostMonth: rows.reduce((sum, r) => sum + r.monthlyApiCostUsd, 0),
      revenueMonth: rows.reduce((sum, r) => sum + r.revenueMonth, 0)
    };

    return NextResponse.json({ accounts: rows, summary, actionItems });
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

async function getAccountActionStats(accountId: string, now: Date) {
  const recentCutoff = new Date(now.getTime() - RECENT_ACTION_MS);
  const upcomingCutoff = new Date(now.getTime() + UPCOMING_CALL_MS);
  const [distressCount, pausedCount, upcomingCallCount, deliveryFailureGroups] =
    await Promise.all([
      prisma.conversation.count({
        where: {
          lead: { accountId },
          distressDetected: true,
          distressDetectedAt: { gte: recentCutoff }
        }
      }),
      prisma.conversation.count({
        where: {
          lead: { accountId },
          aiActive: false,
          distressDetected: false,
          lastMessageAt: { gte: recentCutoff }
        }
      }),
      prisma.conversation.count({
        where: {
          lead: { accountId },
          scheduledCallAt: {
            gte: now,
            lte: upcomingCutoff
          }
        }
      }),
      prisma.messageGroup.findMany({
        where: { failedAt: { gte: recentCutoff } },
        select: { conversationId: true }
      })
    ]);
  const deliveryConversationIds = deliveryFailureGroups.map(
    (g) => g.conversationId
  );
  const deliveryFailureCount =
    deliveryConversationIds.length === 0
      ? 0
      : await prisma.conversation.count({
          where: {
            id: { in: deliveryConversationIds },
            lead: { accountId }
          }
        });

  return {
    distressCount,
    pausedCount,
    upcomingCallCount,
    deliveryFailureCount,
    totalPending:
      distressCount + pausedCount + upcomingCallCount + deliveryFailureCount
  };
}

async function getAccountActionItems(
  accountId: string,
  accountName: string,
  now: Date
): Promise<GlobalActionItem[]> {
  const recentCutoff = new Date(now.getTime() - RECENT_ACTION_MS);
  const upcomingCutoff = new Date(now.getTime() + UPCOMING_CALL_MS);
  const items: GlobalActionItem[] = [];

  const [distressRows, pausedRows, callRows, failedGroups] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        lead: { accountId },
        distressDetected: true,
        distressDetectedAt: { gte: recentCutoff }
      },
      orderBy: { distressDetectedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        distressDetectedAt: true,
        lead: { select: { name: true, handle: true } }
      }
    }),
    prisma.conversation.findMany({
      where: {
        lead: { accountId },
        aiActive: false,
        distressDetected: false,
        lastMessageAt: { gte: recentCutoff }
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 10,
      select: {
        id: true,
        lastMessageAt: true,
        lead: { select: { name: true, handle: true } }
      }
    }),
    prisma.conversation.findMany({
      where: {
        lead: { accountId },
        scheduledCallAt: {
          gte: now,
          lte: upcomingCutoff
        }
      },
      orderBy: { scheduledCallAt: 'asc' },
      take: 10,
      select: {
        id: true,
        scheduledCallAt: true,
        lead: { select: { name: true, handle: true } }
      }
    }),
    prisma.messageGroup.findMany({
      where: { failedAt: { gte: recentCutoff } },
      orderBy: { failedAt: 'desc' },
      take: 25,
      select: { conversationId: true, failedAt: true }
    })
  ]);

  for (const row of distressRows) {
    items.push({
      id: `distress:${row.id}`,
      accountId,
      accountName,
      conversationId: row.id,
      leadName: row.lead.name || row.lead.handle || 'Lead',
      label: 'distress signal',
      severity: 'RED',
      occurredAt: (row.distressDetectedAt ?? now).toISOString(),
      href: `/dashboard/conversations?accountId=${accountId}&conversationId=${row.id}`
    });
  }
  for (const row of pausedRows) {
    items.push({
      id: `paused:${row.id}`,
      accountId,
      accountName,
      conversationId: row.id,
      leadName: row.lead.name || row.lead.handle || 'Lead',
      label: 'AI paused',
      severity: 'AMBER',
      occurredAt: (row.lastMessageAt ?? now).toISOString(),
      href: `/dashboard/conversations?accountId=${accountId}&conversationId=${row.id}`
    });
  }
  for (const row of callRows) {
    items.push({
      id: `call:${row.id}`,
      accountId,
      accountName,
      conversationId: row.id,
      leadName: row.lead.name || row.lead.handle || 'Lead',
      label: 'call scheduled',
      severity: 'AMBER',
      occurredAt: (row.scheduledCallAt ?? now).toISOString(),
      href: `/dashboard/conversations?accountId=${accountId}&conversationId=${row.id}`
    });
  }

  const failedConversationIds = Array.from(
    new Set(failedGroups.map((g) => g.conversationId))
  );
  if (failedConversationIds.length > 0) {
    const failedConversations = await prisma.conversation.findMany({
      where: { id: { in: failedConversationIds }, lead: { accountId } },
      select: {
        id: true,
        lead: { select: { name: true, handle: true } }
      }
    });
    for (const conversation of failedConversations) {
      const failures = failedGroups.filter(
        (g) => g.conversationId === conversation.id
      );
      const latest = failures
        .map((g) => g.failedAt)
        .filter((d): d is Date => Boolean(d))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      items.push({
        id: `failed:${conversation.id}`,
        accountId,
        accountName,
        conversationId: conversation.id,
        leadName: conversation.lead.name || conversation.lead.handle || 'Lead',
        label: `${failures.length} failed deliver${failures.length === 1 ? 'y' : 'ies'}`,
        severity: 'RED',
        occurredAt: (latest ?? now).toISOString(),
        href: `/dashboard/conversations?accountId=${accountId}&conversationId=${conversation.id}`
      });
    }
  }

  return items;
}
