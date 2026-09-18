export type MessageDeliveryStatus =
  | 'PLANNED'
  | 'PROVIDER_REPORTED'
  | 'META_CONFIRMED'
  | 'FAILED';

interface MessageDeliveryEvidence {
  sender?: string | null;
  msgSource?: string | null;
  platformMessageId?: string | null;
  providerMessageId?: string | null;
  deliveryStatus?: MessageDeliveryStatus | null;
}

/**
 * Historical ManyChat rows predate explicit delivery states. The old
 * /manychat-message endpoint sometimes placed a ManyChat provider id in
 * platformMessageId, so that legacy field cannot prove Meta delivery. Treat it
 * as provider-reported unless the new explicit status says META_CONFIRMED.
 */
export function effectiveManyChatDeliveryStatus(
  message: MessageDeliveryEvidence
): MessageDeliveryStatus | null {
  const isManyChat =
    message.sender?.toUpperCase() === 'MANYCHAT' ||
    message.msgSource === 'MANYCHAT_FLOW';

  if (!isManyChat) return message.deliveryStatus ?? null;
  if (message.deliveryStatus) return message.deliveryStatus;
  return message.platformMessageId ? 'PROVIDER_REPORTED' : 'PLANNED';
}

export function countsAsConversationMessage(
  message: MessageDeliveryEvidence
): boolean {
  const status = effectiveManyChatDeliveryStatus(message);
  return status !== 'PLANNED' && status !== 'FAILED';
}

export function manyChatDeliveryLabel(
  message: MessageDeliveryEvidence
): string | null {
  switch (effectiveManyChatDeliveryStatus(message)) {
    case 'PLANNED':
      return 'Planned context · not sent';
    case 'PROVIDER_REPORTED':
      return 'Reported by ManyChat · awaiting Meta confirmation';
    case 'META_CONFIRMED':
      return 'Meta confirmed';
    case 'FAILED':
      return 'Delivery failed';
    default:
      return null;
  }
}
