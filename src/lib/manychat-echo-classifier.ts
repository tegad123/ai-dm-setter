export interface ManyChatEchoConversation {
  source?: string | null;
  manyChatOpenerMessage?: string | null;
  manyChatFiredAt?: Date | null;
}

export type InstagramMetaHistorySender = 'LEAD' | 'AI' | 'MANYCHAT';

// Post-send provider callbacks normally arrive immediately. Two minutes keeps
// the webhook non-blocking while giving either callback ordering time to
// converge. The minute cron makes the practical maximum about three minutes.
export const MANYCHAT_ECHO_PROVIDER_CORRELATION_MS = 2 * 60 * 1000;

export function isWithinManyChatEchoCorrelationWindow(
  conversation: ManyChatEchoConversation,
  now = new Date()
): boolean {
  if (conversation.source !== 'MANYCHAT') return false;

  const firedAt = conversation.manyChatFiredAt?.getTime();
  return (
    typeof firedAt === 'number' &&
    now.getTime() >= firedAt - 5 * 60 * 1000 &&
    now.getTime() <= firedAt + 2 * 60 * 60 * 1000
  );
}

/**
 * Classify an echo before the provider callback has had a chance to correlate
 * it. Keep this intentionally narrow: arbitrary business-side messages remain
 * HUMAN until /manychat-message supplies provider evidence.
 */
export function looksLikeManyChatAutomationEcho(
  conversation: ManyChatEchoConversation,
  messageText: string,
  platformMessageId?: string,
  now = new Date()
): boolean {
  if (conversation.source !== 'MANYCHAT') return false;
  const trimmed = messageText.trim();
  if (!trimmed || !platformMessageId?.trim()) return false;

  if (!isWithinManyChatEchoCorrelationWindow(conversation, now)) return false;

  const opener = conversation.manyChatOpenerMessage?.trim();
  if (opener && trimmed === opener) return true;

  return [
    /\bthis\s+is\s+gonna\s+make\s+you\s+dangerous\b/i,
    /\bminutes?\s+of\s+sauce\b/i,
    /\bdid\s+you\s+give\s+it\s+a\s+watch\b/i
  ].some((pattern) => pattern.test(trimmed));
}

/**
 * Attribute one Instagram message recovered from Meta history.
 *
 * The participant id is the stable direction signal for Instagram history:
 * the known lead id is lead-side and every other identified participant is
 * account-side. The Facebook Page id is deliberately not used here because an
 * Instagram history item can identify the business with its Instagram account
 * id instead.
 *
 * Only the exact configured opener may be promoted from account-side history to
 * ManyChat, and only while the existing bounded echo classifier accepts its
 * native Meta id and timestamp. Other account-side history keeps the legacy AI
 * attribution.
 */
export function classifyInstagramMetaHistoryMessage(params: {
  conversation: ManyChatEchoConversation;
  messageText: string;
  platformMessageId: string;
  fromId?: string | null;
  platformUserId: string;
  timestamp: Date;
}): InstagramMetaHistorySender {
  if (params.fromId === params.platformUserId) return 'LEAD';

  const opener = params.conversation.manyChatOpenerMessage?.trim();
  const exactOpener = Boolean(opener) && params.messageText.trim() === opener;
  if (
    exactOpener &&
    looksLikeManyChatAutomationEcho(
      params.conversation,
      params.messageText,
      params.platformMessageId,
      params.timestamp
    )
  ) {
    return 'MANYCHAT';
  }

  return 'AI';
}
