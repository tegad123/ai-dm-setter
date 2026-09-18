export interface ManyChatEchoConversation {
  source?: string | null;
  manyChatOpenerMessage?: string | null;
  manyChatFiredAt?: Date | null;
}

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
