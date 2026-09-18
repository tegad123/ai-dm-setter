import { MessageDeliveryStatus, Prisma } from '@prisma/client';

export interface AiHistoryMessageTruth {
  sender: string;
  deliveryStatus?: MessageDeliveryStatus | string | null;
  echoAttributionPendingUntil?: Date | string | null;
}

/**
 * ManyChat rows may enter the database before Meta has acknowledged a send.
 * Only explicit provider or Meta evidence is safe to present as conversation
 * history. Historical rows with no status stay out even when their legacy
 * platformMessageId is populated because that column previously also held
 * ManyChat provider ids.
 */
export function isMessageEligibleForAiHistory(
  message: AiHistoryMessageTruth
): boolean {
  if (message.echoAttributionPendingUntil != null) return false;
  if (message.sender !== 'MANYCHAT') return true;

  return (
    message.deliveryStatus === MessageDeliveryStatus.PROVIDER_REPORTED ||
    message.deliveryStatus === MessageDeliveryStatus.META_CONFIRMED
  );
}

export function filterAiEligibleMessageHistory<T extends AiHistoryMessageTruth>(
  messages: T[]
): T[] {
  return messages.filter(isMessageEligibleForAiHistory);
}

/** Prisma fragment matching the same rule at read time. */
export const AI_HISTORY_DELIVERY_WHERE = {
  echoAttributionPendingUntil: null,
  OR: [
    { sender: { not: 'MANYCHAT' } },
    {
      sender: 'MANYCHAT',
      deliveryStatus: {
        in: [
          MessageDeliveryStatus.PROVIDER_REPORTED,
          MessageDeliveryStatus.META_CONFIRMED
        ]
      }
    }
  ]
} satisfies Prisma.MessageWhereInput;
