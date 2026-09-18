export interface ManyChatRoutingMessage {
  id?: string | null;
  sender: string;
  content?: string | null;
  deliveryStatus?: string | null;
}

export interface ManyChatHandoffRoutingReceipt {
  leadMessageId?: string | null;
  status?: string | null;
}

export interface ManyChatFirstReplyRoutingEvidence {
  conversationSource?: string | null;
  openerMessage?: string | null;
  currentLeadMessageId?: string | null;
  conversationHistory: ManyChatRoutingMessage[];
  currentScriptStep?: number | null;
  handoffReceipt?: ManyChatHandoffRoutingReceipt | null;
}

/**
 * Decide whether the current lead message is the first real answer to a
 * stored ManyChat opener.
 *
 * Elapsed time is deliberately absent. A person can answer an opener hours or
 * days later and that message is still the first reply. Conversely, a recent
 * manyChatFiredAt timestamp is not enough to restart Step 1 after the
 * conversation has already advanced. Persisted message, script-state, and
 * receipt evidence are the authority.
 */
export function isManyChatFirstReplyCandidate(
  evidence: ManyChatFirstReplyRoutingEvidence
): boolean {
  if ((evidence.conversationSource ?? '').toUpperCase() !== 'MANYCHAT') {
    return false;
  }
  if (!evidence.openerMessage?.trim() || !evidence.currentLeadMessageId) {
    return false;
  }

  const externalHistory = evidence.conversationHistory.filter((message) =>
    ['LEAD', 'AI', 'HUMAN', 'MANYCHAT'].includes(message.sender)
  );
  const latest = externalHistory.at(-1);
  if (
    latest?.sender !== 'LEAD' ||
    latest.id !== evidence.currentLeadMessageId
  ) {
    return false;
  }

  // A prior setter response proves the handoff already advanced. A second
  // lead message proves this is a continuation or re-engagement, even if the
  // setter failed to answer the first one.
  if (
    externalHistory.some(
      (message) => message.sender === 'AI' || message.sender === 'HUMAN'
    )
  ) {
    return false;
  }
  const leadMessages = externalHistory.filter(
    (message) => message.sender === 'LEAD'
  );
  if (
    leadMessages.length !== 1 ||
    leadMessages[0]?.id !== evidence.currentLeadMessageId
  ) {
    return false;
  }

  // Do not restart Step 1 when durable script state says the conversation has
  // already progressed, even if historical message rows are incomplete.
  if (
    typeof evidence.currentScriptStep === 'number' &&
    evidence.currentScriptStep > 1
  ) {
    return false;
  }
  return true;
}

/**
 * A stored opener string is only planned context because the Follow-to-DM
 * callback runs before ManyChat's send node. Treat the current lead message as
 * an answer to that opener only when durable evidence ties the turn together:
 * either the queued handoff receipt owns this exact lead message, or a visible
 * ManyChat opener row has explicit provider/Meta evidence.
 */
export function isManyChatFirstReplyTurn(
  evidence: ManyChatFirstReplyRoutingEvidence
): boolean {
  if (!isManyChatFirstReplyCandidate(evidence)) return false;

  const receipt = evidence.handoffReceipt;
  if (receipt?.status === 'ALREADY_HANDLED') return false;
  const receiptOwnsCurrentLeadMessage =
    Boolean(receipt?.leadMessageId) &&
    receipt?.leadMessageId === evidence.currentLeadMessageId;

  const opener = evidence.openerMessage!.trim();
  const verifiedOpenerExists = evidence.conversationHistory.some(
    (message) =>
      message.sender === 'MANYCHAT' &&
      message.content?.trim() === opener &&
      (message.deliveryStatus === 'PROVIDER_REPORTED' ||
        message.deliveryStatus === 'META_CONFIRMED')
  );

  return receiptOwnsCurrentLeadMessage || verifiedOpenerExists;
}
