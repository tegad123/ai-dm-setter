export interface ManyChatRoutingMessage {
  id?: string | null;
  sender: string;
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
export function isManyChatFirstReplyTurn(
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
  const receipt = evidence.handoffReceipt;
  if (receipt?.status === 'ALREADY_HANDLED') return false;
  if (
    receipt?.leadMessageId &&
    receipt.leadMessageId !== evidence.currentLeadMessageId
  ) {
    return false;
  }

  return true;
}
