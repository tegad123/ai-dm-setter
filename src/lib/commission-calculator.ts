// ─── Commission Calculator ──────────────────────────────────────────────
// Calculates commissions for setters and closers when deals close.
// Setter gets commission for qualifying the lead.
// Closer gets commission for closing the deal.

import prisma from '@/lib/prisma';

export interface CommissionResult {
  setterId: string | null;
  setterName: string | null;
  setterCommission: number;
  closerId: string | null;
  closerName: string | null;
  closerCommission: number;
  totalCommission: number;
  revenue: number;
}

/**
 * Calculate and apply commissions when a deal closes.
 * Finds the setter (who handled the lead) and closer (who closed it)
 * based on message history and user roles.
 */
export async function calculateAndApplyCommissions(
  accountId: string,
  leadId: string,
  revenue: number
): Promise<CommissionResult> {
  // Find human messages on this lead's conversation to identify setter/closer
  const conversation = await prisma.conversation.findFirst({
    where: { leadId },
    include: {
      messages: {
        where: { sender: 'HUMAN', sentByUserId: { not: null } },
        select: { sentByUserId: true, timestamp: true },
        orderBy: { timestamp: 'asc' }
      }
    }
  });

  const humanMessageUserIds = Array.from(
    new Set(
      (conversation?.messages ?? [])
        .map((m) => m.sentByUserId)
        .filter(Boolean) as string[]
    )
  );

  // Get team members who interacted with this lead
  const involvedUsers = await prisma.user.findMany({
    where: {
      accountId,
      id: { in: humanMessageUserIds },
      isActive: true
    },
    select: {
      id: true,
      name: true,
      role: true,
      commissionRate: true
    }
  });

  // Identify setter (first SETTER role to interact) and closer (CLOSER or ADMIN)
  const setter = involvedUsers.find((u) => u.role === 'SETTER') ?? null;
  const closer =
    involvedUsers.find((u) => u.role === 'CLOSER') ??
    involvedUsers.find((u) => u.role === 'ADMIN') ??
    null;

  const setterRate = setter?.commissionRate ?? 0;
  const closerRate = closer?.commissionRate ?? 0;

  const setterCommission =
    Math.round(((revenue * setterRate) / 100) * 100) / 100;
  const closerCommission =
    Math.round(((revenue * closerRate) / 100) * 100) / 100;
  const totalCommission = setterCommission + closerCommission;

  // Update commission totals on user records
  const updates: Promise<unknown>[] = [];

  if (setter && setterCommission > 0) {
    updates.push(
      prisma.user.update({
        where: { id: setter.id },
        data: { totalCommission: { increment: setterCommission } }
      })
    );
  }

  if (closer && closerCommission > 0) {
    updates.push(
      prisma.user.update({
        where: { id: closer.id },
        data: { totalCommission: { increment: closerCommission } }
      })
    );
  }

  if (updates.length > 0) {
    await Promise.all(updates);
  }

  return {
    setterId: setter?.id ?? null,
    setterName: setter?.name ?? null,
    setterCommission,
    closerId: closer?.id ?? null,
    closerName: closer?.name ?? null,
    closerCommission,
    totalCommission,
    revenue
  };
}
