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
  computeSystemStage,
  detectMidConversationStepSkip,
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
          stage: true,
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
  const scriptByAccount = new Map<string, any>();
  for (const accountId of Array.from(
    new Set(conversations.map((c) => c.lead.accountId))
  )) {
    const [persona, script] = await Promise.all([
      prisma.aIPersona.findFirst({
        where: { accountId, isActive: true },
        select: { minimumCapitalRequired: true }
      }),
      prisma.script.findFirst({
        where: { accountId, isActive: true },
        include: {
          steps: {
            orderBy: { stepNumber: 'asc' },
            include: {
              actions: {
                where: { branchId: null },
                orderBy: { sortOrder: 'asc' },
                include: { form: { include: { fields: true } } }
              },
              branches: {
                orderBy: { sortOrder: 'asc' },
                include: {
                  actions: {
                    orderBy: { sortOrder: 'asc' },
                    include: { form: { include: { fields: true } } }
                  }
                }
              }
            }
          }
        }
      })
    ]);
    personaByAccount.set(accountId, {
      minimumCapitalRequired: persona?.minimumCapitalRequired ?? null
    });
    scriptByAccount.set(accountId, script);
  }

  const counts = new Map<string, number>();
  const skipCounts = new Map<string, number>();
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
    const accountSlug = conversation.lead.account.slug;

    if (trigger.triggered && thresholdMet !== null) {
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

    const script = scriptByAccount.get(conversation.lead.accountId);
    const systemStage = computeSystemStage(script, points);
    const skip = detectMidConversationStepSkip({
      snapshot: {
        conversationId: conversation.id,
        leadId: conversation.lead.id,
        script,
        currentStep: systemStage.step,
        currentScriptStep: systemStage.step?.stepNumber ?? 1,
        activeBranch: null,
        selectedBranchLabel: null,
        systemStage:
          systemStage.step?.stateKey || systemStage.step?.title || null,
        capturedDataPoints: points,
        persona: {
          minimumCapitalRequired: persona?.minimumCapitalRequired ?? null,
          capitalVerificationPrompt: null,
          freeValueLink: null,
          downsellConfig: null,
          promptConfig: null
        },
        reason: systemStage.reason
      },
      history
    });
    const qualifiedWithoutCapital =
      conversation.lead.stage === 'QUALIFIED' && thresholdMet === null;
    if (skip.skip || qualifiedWithoutCapital) {
      skipCounts.set(accountSlug, (skipCounts.get(accountSlug) ?? 0) + 1);
      if (examples.length < 20) {
        examples.push({
          account: accountSlug,
          handle: conversation.lead.handle,
          route: skip.skip
            ? `mid-conversation step skip → ${skip.plannedStepKey}`
            : 'QUALIFIED without capital verification',
          conversationId: conversation.id
        });
      }
    }
  }

  console.log('Self-recovery diagnostic report-only scan');
  console.log(`Window: ${LOOKBACK_DAYS} days`);
  console.log('Stall/escalation recoverable capital routes:');
  console.table(
    Array.from(counts.entries()).map(([account, count]) => ({ account, count }))
  );
  console.log('Mid-conversation step skips / qualified-without-capital:');
  console.table(
    Array.from(skipCounts.entries()).map(([account, count]) => ({
      account,
      count
    }))
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
