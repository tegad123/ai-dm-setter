// Drives a single conversation turn through the production webhook
// pipeline. Mirrors what /api/webhooks/instagram does after parsing the
// raw payload — calls processIncomingMessage, then synchronously drains
// any ScheduledReply rows the flow enqueued so the AI reply actually
// lands as a Message row before the harness reads back state.

import { getPrisma, assertTestDb } from './safety-guard';
import { buildIncomingMessageParams } from './payload-factories';

export interface TurnInvocation {
  accountId: string;
  conversationId: string;
  platformUserId: string;
  messageText: string;
  drainTimeoutMs?: number;
}

export interface TurnOutcome {
  inboundMessageId: string;
  aiReplyText: string | null;
  aiMessageIds: string[];
  conversationState: ConversationStateSnapshot | null;
  inboundQualificationCreated: boolean;
  notificationsCreated: number;
}

export interface ConversationStateSnapshot {
  systemStage: string | null;
  currentScriptStep: number | null;
  capturedDataPoints: Record<string, unknown> | null;
  leadIntentTag: string | null;
  outcome: string | null;
  aiActive: boolean;
  unreadCount: number;
  awaitingAiResponse: boolean;
  lastMessageAt: Date | null;
}

export async function runTurn(input: TurnInvocation): Promise<TurnOutcome> {
  await assertTestDb();
  const prisma = await getPrisma();
  const drainTimeoutMs = input.drainTimeoutMs ?? 45_000;

  const trailingTsBefore = await getLatestMessageTs(
    prisma,
    input.conversationId
  );
  const inboundQualBefore = await prisma.inboundQualification.count({
    where: { conversationId: input.conversationId }
  });
  const notificationsBefore = await prisma.notification.count({
    where: { lead: { conversation: { id: input.conversationId } } }
  });

  const { processIncomingMessage } = await import(
    '../../../src/lib/webhook-processor'
  );

  const params = buildIncomingMessageParams({
    accountId: input.accountId,
    platformUserId: input.platformUserId,
    messageText: input.messageText
  });
  const result = await processIncomingMessage(params);

  if (!result.skipReply) {
    await drainScheduledReplies(
      input.conversationId,
      input.accountId,
      drainTimeoutMs
    );
  }

  const inboundMessageId = result.messageId;
  const aiMessages = await prisma.message.findMany({
    where: {
      conversationId: input.conversationId,
      sender: 'AI',
      ...(trailingTsBefore ? { timestamp: { gt: trailingTsBefore } } : {})
    },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true }
  });

  const aiMessageIds = aiMessages.map((m) => m.id);
  const aiReplyText = aiMessages.length
    ? aiMessages.map((m) => m.content).join('\n')
    : null;

  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      systemStage: true,
      currentScriptStep: true,
      capturedDataPoints: true,
      leadIntentTag: true,
      outcome: true,
      aiActive: true,
      unreadCount: true,
      awaitingAiResponse: true,
      lastMessageAt: true
    }
  });

  const inboundQualAfter = await prisma.inboundQualification.count({
    where: { conversationId: input.conversationId }
  });
  const notificationsAfter = await prisma.notification.count({
    where: { lead: { conversation: { id: input.conversationId } } }
  });

  return {
    inboundMessageId,
    aiReplyText,
    aiMessageIds,
    conversationState: conversation
      ? {
          systemStage: conversation.systemStage ?? null,
          currentScriptStep: conversation.currentScriptStep ?? null,
          capturedDataPoints:
            (conversation.capturedDataPoints as Record<
              string,
              unknown
            > | null) ?? null,
          leadIntentTag: conversation.leadIntentTag ?? null,
          outcome: conversation.outcome ?? null,
          aiActive: conversation.aiActive,
          unreadCount: conversation.unreadCount,
          awaitingAiResponse: conversation.awaitingAiResponse ?? false,
          lastMessageAt: conversation.lastMessageAt ?? null
        }
      : null,
    inboundQualificationCreated: inboundQualAfter > inboundQualBefore,
    notificationsCreated: notificationsAfter - notificationsBefore
  };
}

async function getLatestMessageTs(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  conversationId: string
): Promise<Date | null> {
  const latest = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true }
  });
  return latest?.timestamp ?? null;
}

async function drainScheduledReplies(
  conversationId: string,
  accountId: string,
  timeoutMs: number
): Promise<void> {
  const prisma = await getPrisma();
  const { scheduleAIReply, processScheduledReply } = await import(
    '../../../src/lib/webhook-processor'
  );

  await scheduleAIReply(conversationId, accountId, { skipDelayQueue: true });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await prisma.scheduledReply.findFirst({
      where: { conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });
    if (!pending) break;
    await processScheduledReply(conversationId, accountId, {
      messageType: pending.messageType,
      generatedResult: pending.generatedResult,
      createdAt: pending.createdAt
    });
    await prisma.scheduledReply
      .update({ where: { id: pending.id }, data: { status: 'SENT' } })
      .catch(() => null);
  }
}
