import type { Prisma } from '@prisma/client';

export const AUTO_CLEARED_STALE_REVIEW_EVENT = 'auto_cleared_stale_review';

export interface AwaitingHumanReviewState {
  awaitingHumanReview?: boolean | null;
  aiActive?: boolean | null;
  distressDetected?: boolean | null;
}

export interface AutoClearedStaleReviewEvent {
  eventType: typeof AUTO_CLEARED_STALE_REVIEW_EVENT;
  conversationId: string;
  leadMessageId: string;
  leadMessagePreview: string;
  clearedAt: string;
  reason: string;
}

export function shouldAutoClearAwaitingHumanReview(
  state: AwaitingHumanReviewState
): boolean {
  return Boolean(
    state.awaitingHumanReview && state.aiActive && !state.distressDetected
  );
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function appendAutoClearedStaleReviewEvent(
  capturedDataPoints: Prisma.JsonValue | null | undefined,
  event: AutoClearedStaleReviewEvent
): Prisma.InputJsonValue {
  const base = isJsonRecord(capturedDataPoints)
    ? { ...capturedDataPoints }
    : {};
  const existingEvents = Array.isArray(base.reviewEvents)
    ? base.reviewEvents
    : [];

  return {
    ...base,
    reviewEvents: [...existingEvents.slice(-19), event]
  } as Prisma.InputJsonObject;
}
