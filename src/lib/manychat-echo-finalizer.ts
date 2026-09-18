import prisma from '@/lib/prisma';
import { enqueueInboundMediaProcessing } from '@/lib/media-processing';
import { broadcastNewMessage } from '@/lib/realtime';

const FOLLOW_UP_TYPES = [
  'FOLLOW_UP_1',
  'FOLLOW_UP_2',
  'FOLLOW_UP_3',
  'FOLLOW_UP_SOFT_EXIT',
  'BOOKING_LINK_FOLLOWUP'
] as const;

type FinalizerDb = typeof prisma;

export interface ManyChatEchoFinalizerResult {
  examined: number;
  finalizedHuman: number;
  skipped: number;
  failed: number;
}

interface FinalizeOneOptions {
  messageId: string;
  conversationId: string;
  now?: Date;
  db?: FinalizerDb;
  broadcast?: typeof broadcastNewMessage;
  enqueueMedia?: typeof enqueueInboundMediaProcessing;
}

function textSimilarity(suggestion: string, human: string): number {
  const suggestionWords = suggestion.toLowerCase().split(/\s+/).filter(Boolean);
  const humanWords = human.toLowerCase().split(/\s+/).filter(Boolean);
  const humanSet = new Set(humanWords);
  const intersection = suggestionWords.filter((word) =>
    humanSet.has(word)
  ).length;
  const union = new Set([...suggestionWords, ...humanWords]);
  return union.size > 0 ? intersection / union.size : 0;
}

/**
 * Finalize one due business-side echo as a genuine HUMAN/PHONE message.
 * The provider callback uses the same advisory lock, so either provider
 * attribution wins before human side effects or every human side effect and
 * the final marker commit together.
 */
export async function finalizeManyChatEchoAttribution(
  options: FinalizeOneOptions
): Promise<boolean> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const broadcast = options.broadcast ?? broadcastNewMessage;
  const enqueueMedia = options.enqueueMedia ?? enqueueInboundMediaProcessing;

  const finalized = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-message:${options.conversationId}`}, 0))`;

    const message = await tx.message.findFirst({
      where: {
        id: options.messageId,
        conversationId: options.conversationId,
        sender: 'HUMAN',
        deletedAt: null,
        echoAttributionPendingUntil: { lte: now },
        echoAttributionFinalizedAt: null
      },
      include: {
        conversation: {
          include: {
            lead: { select: { accountId: true } }
          }
        }
      }
    });
    if (!message) return null;

    const accountId = message.conversation.lead.accountId;
    const suggestion = await tx.aISuggestion.findFirst({
      where: {
        conversationId: message.conversationId,
        wasSelected: false,
        wasRejected: false,
        generatedAt: {
          gte: new Date(message.timestamp.getTime() - 2 * 60 * 60 * 1000),
          lte: message.timestamp
        }
      },
      orderBy: { generatedAt: 'desc' }
    });

    let rejectedAISuggestionId: string | null = null;
    let editedFromSuggestion = false;
    let loggedDuringTrainingPhase = false;
    if (suggestion) {
      const bubbles = suggestion.messageBubbles;
      const comparisonSource = Array.isArray(bubbles)
        ? (bubbles as string[]).join(' ')
        : suggestion.responseText;
      const similarity = textSimilarity(comparisonSource, message.content);
      const claimed = await tx.aISuggestion.updateMany({
        where: {
          id: suggestion.id,
          wasSelected: false,
          wasRejected: false
        },
        data: {
          wasRejected: true,
          wasEdited: similarity > 0.7,
          finalSentText: message.content,
          similarityToFinalSent: similarity
        }
      });
      if (claimed.count === 1) {
        const account = await tx.account.findUnique({
          where: { id: accountId },
          select: { trainingPhase: true }
        });
        loggedDuringTrainingPhase = account?.trainingPhase === 'ONBOARDING';
        await tx.account.update({
          where: { id: accountId },
          data: { trainingOverrideCount: { increment: 1 } }
        });
        rejectedAISuggestionId = suggestion.id;
        editedFromSuggestion = similarity > 0.7;
      }
    }

    const resolved = await tx.message.update({
      where: { id: message.id },
      data: {
        sender: 'HUMAN',
        humanSource: 'PHONE',
        isHumanOverride: Boolean(rejectedAISuggestionId),
        rejectedAISuggestionId,
        editedFromSuggestion,
        loggedDuringTrainingPhase,
        msgSource: 'HUMAN_OVERRIDE',
        echoAttributionPendingUntil: null,
        echoAttributionFinalizedAt: now
      }
    });

    const newerActivity = await tx.message.findFirst({
      where: {
        conversationId: message.conversationId,
        deletedAt: null,
        sender: { not: 'SYSTEM' },
        timestamp: { gt: message.timestamp }
      },
      select: { id: true }
    });

    await tx.conversation.updateMany({
      where: {
        id: message.conversationId,
        OR: [
          { lastMessageAt: null },
          { lastMessageAt: { lte: message.timestamp } }
        ]
      },
      data: {
        lastMessageAt: message.timestamp,
        awaitingAiResponse: false,
        awaitingSince: null
      }
    });
    await tx.scheduledReply.updateMany({
      where: {
        conversationId: message.conversationId,
        status: 'PENDING',
        ...(newerActivity ? { createdAt: { lte: message.timestamp } } : {})
      },
      data: { status: 'CANCELLED' }
    });
    await tx.scheduledMessage.updateMany({
      where: {
        conversationId: message.conversationId,
        messageType: { in: [...FOLLOW_UP_TYPES] },
        status: 'PENDING',
        ...(newerActivity ? { createdAt: { lte: message.timestamp } } : {})
      },
      data: { status: 'CANCELLED' }
    });

    return {
      message: resolved,
      accountId,
      personaId: message.conversation.personaId
    };
  });

  if (!finalized) return false;

  try {
    broadcast(finalized.accountId, {
      id: finalized.message.id,
      conversationId: finalized.message.conversationId,
      sender: 'HUMAN',
      content: finalized.message.content,
      humanSource: 'PHONE',
      platformMessageId: finalized.message.platformMessageId,
      timestamp: finalized.message.timestamp.toISOString()
    });
  } catch (error) {
    console.error(
      `[manychat-echo-finalizer] realtime broadcast failed for ${finalized.message.id}:`,
      error instanceof Error ? error.message : 'unknown error'
    );
  }

  if (
    finalized.message.isVoiceNote &&
    finalized.message.voiceNoteUrl &&
    !finalized.message.mediaProcessedAt
  ) {
    await enqueueMedia({
      accountId: finalized.accountId,
      personaId: finalized.personaId,
      conversationId: finalized.message.conversationId,
      messageId: finalized.message.id,
      mediaType: 'audio',
      sourceUrl: finalized.message.voiceNoteUrl,
      durationSeconds: null
    }).catch((error) => {
      console.error(
        `[manychat-echo-finalizer] media processing failed for ${finalized.message.id}:`,
        error instanceof Error ? error.message : 'unknown error'
      );
    });
  }

  return true;
}

/** Resolve expired provisional echoes with a bounded, retry-safe cron batch. */
export async function finalizeManyChatEchoAttributions(
  options: {
    limit?: number;
    now?: Date;
    db?: FinalizerDb;
    broadcast?: typeof broadcastNewMessage;
    enqueueMedia?: typeof enqueueInboundMediaProcessing;
  } = {}
): Promise<ManyChatEchoFinalizerResult> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const candidates = await db.message.findMany({
    where: {
      sender: 'HUMAN',
      deletedAt: null,
      echoAttributionPendingUntil: { lte: now },
      echoAttributionFinalizedAt: null
    },
    orderBy: { echoAttributionPendingUntil: 'asc' },
    take: limit,
    select: { id: true, conversationId: true }
  });

  const result: ManyChatEchoFinalizerResult = {
    examined: candidates.length,
    finalizedHuman: 0,
    skipped: 0,
    failed: 0
  };

  for (const candidate of candidates) {
    try {
      const finalized = await finalizeManyChatEchoAttribution({
        messageId: candidate.id,
        conversationId: candidate.conversationId,
        now,
        db,
        broadcast: options.broadcast,
        enqueueMedia: options.enqueueMedia
      });
      if (finalized) result.finalizedHuman++;
      else result.skipped++;
    } catch (error) {
      result.failed++;
      console.error(
        `[manychat-echo-finalizer] failed to finalize ${candidate.id}:`,
        error instanceof Error ? error.message : 'unknown error'
      );
    }
  }

  return result;
}
