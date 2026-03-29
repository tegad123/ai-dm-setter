import prisma from '@/lib/prisma';

/**
 * Calculate and apply commissions when a deal closes.
 */
export async function calculateAndApplyCommissions(
  accountId: string,
  leadId: string,
  dealValue: number
): Promise<{
  commissions: Array<{ userId: string; amount: number; rate: number }>;
}> {
  // Find all users in this account with commission rates
  const users = await prisma.user.findMany({
    where: { accountId, commissionRate: { gt: 0 } },
    select: { id: true, commissionRate: true, totalCommission: true }
  });

  const commissions = [];

  for (const user of users) {
    const rate = user.commissionRate || 0;
    const amount = dealValue * (rate / 100);

    if (amount > 0) {
      await prisma.user.update({
        where: { id: user.id },
        data: { totalCommission: (user.totalCommission || 0) + amount }
      });

      commissions.push({
        userId: user.id,
        amount: Math.round(amount * 100) / 100,
        rate
      });
    }
  }

  return { commissions };
}
