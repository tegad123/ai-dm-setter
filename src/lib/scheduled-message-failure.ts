import { classifyMetaDeliveryError } from './meta-delivery-errors';

export const SCHEDULED_MESSAGE_MAX_ATTEMPTS = 3;

export function decideScheduledMessageFailure(
  error: unknown,
  attempts: number
) {
  const deliveryError = classifyMetaDeliveryError(error);
  const failedAttempt = attempts + 1;
  // Internal errors retain the existing bounded retries. An explicit Meta
  // rejection without a transient signal (including ownership/action blocks)
  // cannot be repaired by resending the same request next minute.
  const nonRetryableMetaRejection =
    !deliveryError.retryable &&
    (deliveryError.metaCode !== null || deliveryError.httpStatus !== null);
  const terminal =
    nonRetryableMetaRejection ||
    failedAttempt >= SCHEDULED_MESSAGE_MAX_ATTEMPTS;
  return {
    status: terminal ? ('FAILED' as const) : ('PENDING' as const),
    attempts: terminal ? SCHEDULED_MESSAGE_MAX_ATTEMPTS : failedAttempt,
    notifyOperator: terminal,
    errorMeaning: terminal
      ? nonRetryableMetaRejection
        ? deliveryError.meaning
        : `Delivery attempts exhausted. Operator review is required. Last error: ${deliveryError.rawMessage}`
      : deliveryError.meaning
  };
}
