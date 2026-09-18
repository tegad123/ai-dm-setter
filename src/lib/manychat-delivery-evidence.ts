import prisma from '@/lib/prisma';
import type { Message } from '@prisma/client';
import { MANYCHAT_ECHO_PROVIDER_CORRELATION_MS } from '@/lib/manychat-echo-classifier';

const ECHO_MATCH_WINDOW_MS = 10 * 60_000;

export interface PersistMetaEchoResult {
  message: Message;
  classification: 'MANYCHAT' | 'HUMAN';
  disposition: 'CREATED' | 'RECONCILED' | 'EXISTING';
}

/**
 * Persist a native business-side Meta echo under the same conversation lock
 * used by /manychat-message.
 *
 * This is the atomic boundary for the two possible arrival orders:
 * provider callback first attaches the Meta mid to that MANYCHAT row; Meta echo
 * first creates one confirmed MANYCHAT row or one provisional HUMAN/PHONE row
 * which a later provider callback can reclassify. The lock is held through the
 * fallback insert so both callbacks cannot create competing rows.
 */
export async function persistMetaEchoWithManyChatReconciliation(params: {
  conversationId: string;
  messageText: string;
  platformMessageId?: string;
  classifyAsManyChat: boolean;
  audioUrl?: string;
  receivedAt?: Date;
  deferHumanAttribution?: boolean;
}): Promise<PersistMetaEchoResult> {
  const content = params.messageText.trim();
  const platformMessageId = params.platformMessageId?.trim() || null;
  const receivedAt = params.receivedAt ?? new Date();
  const windowStart = new Date(receivedAt.getTime() - ECHO_MATCH_WINDOW_MS);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-message:${params.conversationId}`}, 0))`;

    if (platformMessageId) {
      const alreadyLinked = await tx.message.findFirst({
        where: {
          conversationId: params.conversationId,
          platformMessageId
        }
      });
      if (alreadyLinked) {
        // Older Meta-history backfill attributed every account-side Instagram
        // message to AI. When the bounded caller has positively identified the
        // exact ManyChat opener, repair that stale attribution in place so a
        // queued first reply is not mistaken for an already-answered turn.
        if (
          params.classifyAsManyChat &&
          alreadyLinked.sender === 'AI' &&
          alreadyLinked.content.trim() === content
        ) {
          const message = await tx.message.update({
            where: { id: alreadyLinked.id },
            data: {
              sender: 'MANYCHAT',
              deliveryStatus: 'META_CONFIRMED',
              deliveryConfirmedAt:
                alreadyLinked.deliveryConfirmedAt ?? receivedAt,
              deliveryFailedAt: null,
              deliveryErrorCode: null,
              systemPromptVersion: 'manychat-automation',
              msgSource: 'MANYCHAT_FLOW'
            }
          });
          return {
            message,
            classification: 'MANYCHAT',
            disposition: 'RECONCILED'
          };
        }
        return {
          message: alreadyLinked,
          classification:
            alreadyLinked.sender === 'MANYCHAT' ? 'MANYCHAT' : 'HUMAN',
          disposition: 'EXISTING'
        };
      }
    }

    const providerCandidates = await tx.message.findMany({
      where: {
        conversationId: params.conversationId,
        sender: 'MANYCHAT',
        deletedAt: null,
        deliveryStatus: 'PROVIDER_REPORTED',
        platformMessageId: null,
        timestamp: { gte: windowStart, lte: receivedAt }
      },
      orderBy: { timestamp: 'desc' }
    });
    const providerMatch = providerCandidates.find(
      (candidate) => candidate.content.trim() === content
    );
    if (providerMatch && platformMessageId) {
      const message = await tx.message.update({
        where: { id: providerMatch.id },
        data: {
          platformMessageId,
          deliveryStatus: 'META_CONFIRMED',
          deliveryConfirmedAt: receivedAt,
          deliveryFailedAt: null,
          deliveryErrorCode: null
        }
      });
      return {
        message,
        classification: 'MANYCHAT',
        disposition: 'RECONCILED'
      };
    }
    if (providerMatch) {
      // A content-only admin event is not Meta delivery proof. Keep the
      // provider acknowledgement intact and wait for a native event carrying
      // an actual Meta mid before promoting it to META_CONFIRMED.
      return {
        message: providerMatch,
        classification: 'MANYCHAT',
        disposition: 'EXISTING'
      };
    }

    const classification = params.classifyAsManyChat ? 'MANYCHAT' : 'HUMAN';
    const message = await tx.message.create({
      data: {
        conversationId: params.conversationId,
        sender: classification,
        content: params.messageText,
        timestamp: receivedAt,
        platformMessageId,
        deliveryStatus: platformMessageId ? 'META_CONFIRMED' : null,
        deliveryConfirmedAt: platformMessageId ? receivedAt : null,
        // Every unknown business-side echo starts unresolved. Normal echoes are
        // due immediately; a ManyChat-window echo gets a short provider
        // correlation window. The shared finalizer commits genuine-human side
        // effects and the final attribution marker in one transaction.
        echoAttributionPendingUntil:
          classification === 'HUMAN'
            ? params.deferHumanAttribution && platformMessageId
              ? new Date(
                  receivedAt.getTime() + MANYCHAT_ECHO_PROVIDER_CORRELATION_MS
                )
              : receivedAt
            : null,
        echoAttributionFinalizedAt: null,
        humanSource: classification === 'HUMAN' ? 'PHONE' : null,
        isVoiceNote: Boolean(params.audioUrl),
        voiceNoteUrl: params.audioUrl ?? null,
        systemPromptVersion:
          classification === 'MANYCHAT' ? 'manychat-automation' : null,
        msgSource: classification === 'MANYCHAT' ? 'MANYCHAT_FLOW' : 'UNKNOWN'
      }
    });
    return { message, classification, disposition: 'CREATED' };
  });
}
