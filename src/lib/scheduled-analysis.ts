import prisma from '@/lib/prisma';
import { updateConversationOutcome } from '@/lib/conversation-state-machine';

/**
 * Run daily analysis for all active accounts.
 * Called by cron job to update conversation outcomes, detect ghosts, etc.
 */
export async function runAnalysisForAllAccounts(): Promise<{
  accountsProcessed: number;
  conversationsUpdated: number;
  results: Array<{ accountId: string; success: boolean; conversationsUpdated: number; error?: string }>;
}> {
  const accounts = await prisma.account.findMany({
    select: { id: true }
  });

  let conversationsUpdated = 0;
  const results: Array<{ accountId: string; success: boolean; conversationsUpdated: number; error?: string }> = [];

  for (const account of accounts) {
    let accountUpdated = 0;
    // Find ONGOING conversations that may need outcome updates
    const ongoingConversations = await prisma.conversation.findMany({
      where: {
        lead: { accountId: account.id },
        outcome: 'ONGOING'
      },
      select: { id: true, lastMessageAt: true }
    });

    for (const convo of ongoingConversations) {
      try {
        const newOutcome = await updateConversationOutcome(convo.id);
        if (newOutcome !== 'ONGOING') {
          conversationsUpdated++;
          accountUpdated++;
        }
      } catch (err) {
        console.error(`[scheduled-analysis] Error updating ${convo.id}:`, err);
      }
    }

    // Detect and mark ghosted leads (no response in 7+ days)
    const ghostThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await prisma.lead.updateMany({
      where: {
        accountId: account.id,
        status: { in: ['NEW_LEAD', 'IN_QUALIFICATION', 'HOT_LEAD'] },
        conversation: {
          lastMessageAt: { lt: ghostThreshold },
          outcome: 'LEFT_ON_READ'
        }
      },
      data: { status: 'GHOSTED' }
    });

    results.push({ accountId: account.id, success: true, conversationsUpdated: accountUpdated });
  }

  return {
    accountsProcessed: accounts.length,
    conversationsUpdated,
    results
  };
}
