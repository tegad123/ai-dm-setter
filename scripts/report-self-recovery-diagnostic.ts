/**
 * Report-only 60-day diagnostic for self-recovery opportunities.
 *
 * This intentionally does not create SelfRecoveryEvent rows and does not
 * mutate Conversation/Lead state. It scans for stalled AI turns where the
 * lead data already supports a deterministic capital route.
 *
 * Run: npx tsx scripts/report-self-recovery-diagnostic.ts
 */

import prisma from '@/lib/prisma';
import {
  extractCapturedDataPointsForTest,
  isSelfRecoveryTrigger,
  type ScriptHistoryMessage
} from '@/lib/script-state-recovery';

const LOOKBACK_DAYS = Number(process.env.RECOVERY_DIAG_LOOKBACK_DAYS || 60);

function valueOf<T>(points: Record<string, any>, key: string): T | null {
  const point = points[key];
  if (!point || point.confidence !== 'HIGH') return null;
  return point.value as T;
}

async function main() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const conversations = await prisma.conversation.findMany({
    where: {
      lastMessageAt: { gte: since },
      distressDetected: false,
      messages: {
        some: {
          sender: 'AI',
          timestamp: { gte: since }
        }
      }
    },
    include: {
      lead: {
        select: {
          id: true,
          accountId: true,
          name: true,
          handle: true,
          account: { select: { slug: true, name: true } }
        }
      },
      messages: { orderBy: { timestamp: 'asc' } }
    },
    take: 1000
  });

  const personaByAccount = new Map<
    string,
    { minimumCapitalRequired: number | null }
  >();
  for (const accountId of Array.from(
    new Set(conversations.map((c) => c.lead.accountId))
  )) {
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId, isActive: true },
      select: { minimumCapitalRequired: true }
    });
    personaByAccount.set(accountId, {
      minimumCapitalRequired: persona?.minimumCapitalRequired ?? null
    });
  }

  const counts = new Map<string, number>();
  const examples: Array<{
    account: string;
    handle: string;
    route: string;
    conversationId: string;
  }> = [];

  for (const conversation of conversations) {
    const lastAi = [...conversation.messages]
      .reverse()
      .find((m) => m.sender === 'AI');
    const trigger = isSelfRecoveryTrigger({
      message: lastAi?.content,
      messages: lastAi?.content ? [lastAi.content] : [],
      stallType: lastAi?.stallType ?? null,
      escalateToHuman: false
    });
    if (!trigger.triggered) continue;

    const persona = personaByAccount.get(conversation.lead.accountId);
    const history: ScriptHistoryMessage[] = conversation.messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      timestamp: m.timestamp
    }));
    const points = extractCapturedDataPointsForTest({
      history,
      minimumCapitalRequired: persona?.minimumCapitalRequired ?? null,
      durableStatus: conversation.capitalVerificationStatus,
      durableAmount: conversation.capitalVerifiedAmount
    });
    const thresholdMet = valueOf<boolean>(points, 'capitalThresholdMet');
    if (thresholdMet === null) continue;

    const accountSlug = conversation.lead.account.slug;
    counts.set(accountSlug, (counts.get(accountSlug) ?? 0) + 1);
    if (examples.length < 20) {
      examples.push({
        account: accountSlug,
        handle: conversation.lead.handle,
        route: thresholdMet ? 'application/call route' : 'downsell route',
        conversationId: conversation.id
      });
    }
  }

  console.log('Self-recovery diagnostic report-only scan');
  console.log(`Window: ${LOOKBACK_DAYS} days`);
  console.table(
    Array.from(counts.entries()).map(([account, count]) => ({ account, count }))
  );
  console.table(examples);
}

main()
  .catch((err) => {
    console.error('[self-recovery-diagnostic] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
