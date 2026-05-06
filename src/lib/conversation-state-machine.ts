import prisma from '@/lib/prisma';
import type { ConversationOutcome } from '@prisma/client';

function capturedPointValue(points: unknown, key: string): unknown {
  if (!points || typeof points !== 'object') return null;
  const raw = (points as Record<string, unknown>)[key];
  if (!raw || typeof raw !== 'object') return raw ?? null;
  if ('value' in raw) return (raw as { value?: unknown }).value ?? null;
  return raw;
}

function hasExplicitCapitalDisqualification(conversation: {
  capitalVerificationStatus?: string | null;
  capturedDataPoints?: unknown;
}): boolean {
  if (conversation.capitalVerificationStatus === 'VERIFIED_UNQUALIFIED') {
    return true;
  }
  const thresholdMet = capturedPointValue(
    conversation.capturedDataPoints,
    'capitalThresholdMet'
  );
  const verifiedCapital = capturedPointValue(
    conversation.capturedDataPoints,
    'verifiedCapitalUsd'
  );
  return thresholdMet === false || verifiedCapital === 0;
}

// ---------------------------------------------------------------------------
// Conversation Outcome Transitions
// ---------------------------------------------------------------------------

/**
 * Evaluate and update the conversation outcome based on message patterns.
 *
 * Called after each AI message is sent to determine if the conversation
 * has transitioned to a new outcome (e.g., ONGOING → BOOKED).
 */
export async function updateConversationOutcome(
  conversationId: string
): Promise<string> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 20,
        select: {
          sender: true,
          content: true,
          timestamp: true,
          stage: true
        }
      },
      lead: {
        select: { stage: true }
      }
    }
  });

  if (!conversation) return 'ONGOING';

  const { messages, lead } = conversation;
  const currentOutcome = conversation.outcome;

  // Don't downgrade terminal outcomes
  if (['BOOKED', 'SOFT_EXIT'].includes(currentOutcome)) {
    return currentOutcome;
  }

  if (
    currentOutcome === 'UNQUALIFIED_REDIRECT' &&
    hasExplicitCapitalDisqualification(conversation)
  ) {
    return currentOutcome;
  }

  let newOutcome: ConversationOutcome =
    currentOutcome === 'UNQUALIFIED_REDIRECT' ? 'ONGOING' : currentOutcome;

  // Check for BOOKED — lead stage or booking stage reached
  if (
    lead.stage === 'BOOKED' ||
    lead.stage === 'SHOWED' ||
    lead.stage === 'CLOSED_WON'
  ) {
    newOutcome = 'BOOKED';
  }
  // Check for UNQUALIFIED — lead explicitly unqualified
  else if (
    lead.stage === 'UNQUALIFIED' &&
    hasExplicitCapitalDisqualification(conversation)
  ) {
    newOutcome = 'UNQUALIFIED_REDIRECT';
  } else if (lead.stage === 'UNQUALIFIED') {
    console.warn(
      `[state-machine] PREMATURE_UNQUALIFIED_REDIRECT_BLOCKED for ${conversationId}: lead.stage=UNQUALIFIED without explicit below-threshold capital`
    );
  }
  // Check for LEFT_ON_READ — no lead response after 2+ AI messages
  else if (messages.length >= 2) {
    const recentSenders = messages.slice(0, 3).map((m) => m.sender);
    const allAI = recentSenders.every((s) => s === 'AI' || s === 'HUMAN');
    if (allAI) {
      // Check time since last message
      const lastMsg = messages[0];
      const hoursSinceLastMsg =
        (Date.now() - new Date(lastMsg.timestamp).getTime()) / (1000 * 60 * 60);

      if (hoursSinceLastMsg > 48) {
        newOutcome = 'LEFT_ON_READ';
      }
    }
  }
  // Check for objection-related outcomes
  else {
    const lastLeadMsg = messages.find((m) => m.sender === 'LEAD');
    if (lastLeadMsg) {
      const text = lastLeadMsg.content.toLowerCase();
      if (
        text.includes("can't afford") ||
        text.includes('too expensive') ||
        text.includes('not in my budget')
      ) {
        newOutcome = 'SOFT_OBJECTION';
      } else if (
        text.includes('how much') ||
        text.includes('what does it cost') ||
        text.includes('pricing')
      ) {
        newOutcome = 'PRICE_QUESTION_DEFLECTED';
      } else if (
        text.includes('not interested') ||
        text.includes('no thanks') ||
        text.includes('stop messaging')
      ) {
        newOutcome = 'RESISTANT_EXIT';
      }
    }
  }

  // Update if changed
  if (newOutcome !== currentOutcome) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { outcome: newOutcome as any }
    });
    console.log(
      `[state-machine] Conversation ${conversationId} outcome: ${currentOutcome} → ${newOutcome}`
    );
  }

  return newOutcome;
}

// ---------------------------------------------------------------------------
// Stage Timestamp Recording
// ---------------------------------------------------------------------------

/**
 * Record the first time a conversation reaches a given stage.
 * Only writes once per stage (idempotent).
 *
 * Also backfills all EARLIER stages in the SOP sequence when called for a
 * later stage. The AI engine emits the stage of the current reply (e.g.
 * "CAPITAL_QUALIFICATION") but doesn't always re-emit prior stages it has
 * already passed through. Without backfill the sidebar shows zero checkmarks
 * even when the conversation is several stages deep — see andreierz on
 * 2026-05-06 (systemStage=CAPITAL_QUALIFICATION but every timestamp null).
 */
const SOP_STAGE_ORDER = [
  'OPENING',
  'SITUATION_DISCOVERY',
  'GOAL_EMOTIONAL_WHY',
  'URGENCY',
  'SOFT_PITCH_COMMITMENT',
  'FINANCIAL_SCREENING',
  'BOOKING'
] as const;

const STAGE_FIELD_MAP: Record<string, string> = {
  // New 7-stage SOP sequence
  OPENING: 'stageOpeningAt',
  SITUATION_DISCOVERY: 'stageSituationDiscoveryAt',
  GOAL_EMOTIONAL_WHY: 'stageGoalEmotionalWhyAt',
  URGENCY: 'stageUrgencyAt',
  SOFT_PITCH_COMMITMENT: 'stageSoftPitchCommitmentAt',
  FINANCIAL_SCREENING: 'stageFinancialScreeningAt',
  BOOKING: 'stageBookingAt',
  // Legacy stage names (backward compat — alias to new fields)
  GREETING: 'stageOpeningAt',
  QUALIFICATION: 'stageQualificationAt',
  VISION_BUILDING: 'stageVisionBuildingAt',
  PAIN_IDENTIFICATION: 'stagePainIdentificationAt',
  SOLUTION_OFFER: 'stageSolutionOfferAt',
  // CAPITAL_QUALIFICATION is a sub-stage between FINANCIAL_SCREENING and
  // BOOKING — when reached, every SOP stage through FINANCIAL_SCREENING is
  // implicitly complete.
  CAPITAL_QUALIFICATION: 'stageFinancialScreeningAt'
};

export async function recordStageTimestamp(
  conversationId: string,
  stage: string
): Promise<void> {
  const field = STAGE_FIELD_MAP[stage];
  if (!field) return;

  // Determine which earlier SOP stages to also backfill. If the stage isn't
  // in the SOP sequence (e.g. legacy/sub-stage), only backfill its own field.
  const stageIndex = SOP_STAGE_ORDER.indexOf(
    stage as (typeof SOP_STAGE_ORDER)[number]
  );
  const stagesToFill =
    stageIndex >= 0 ? SOP_STAGE_ORDER.slice(0, stageIndex + 1) : [stage];
  // Special-case: CAPITAL_QUALIFICATION implies all SOP stages through
  // FINANCIAL_SCREENING (index 5) are complete.
  const finalStagesToFill =
    stage === 'CAPITAL_QUALIFICATION'
      ? SOP_STAGE_ORDER.slice(0, 6)
      : stagesToFill;

  const fieldsToCheck = finalStagesToFill
    .map((s) => STAGE_FIELD_MAP[s])
    .filter(Boolean);

  // Pull the whole row — Prisma's `select` types reject dynamic-key objects
  // (Record<string, true>), and the read cost difference vs. a narrow select
  // is negligible compared to the write/index hit.
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId }
  });
  if (!convo) return;

  const now = new Date();
  const updates: Record<string, Date> = {};
  for (const f of fieldsToCheck) {
    if (!(convo as Record<string, unknown>)[f]) updates[f] = now;
  }

  if (Object.keys(updates).length === 0) return;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: updates
  });
  console.log(
    `[state-machine] Conversation ${conversationId} reached stage ${stage}; backfilled fields: ${Object.keys(updates).join(', ')}`
  );
}

// ---------------------------------------------------------------------------
// Back-fill Effectiveness Tracking
// ---------------------------------------------------------------------------

/**
 * After a LEAD message comes in, back-fill effectiveness metrics on the
 * previous AI message(s) that preceded it.
 *
 * - gotResponse: true (the lead replied)
 * - responseTimeSeconds: time between AI msg and lead reply
 * - leadContinuedConversation: true if lead has sent 2+ messages since AI msg
 */
export async function backfillEffectivenessTracking(
  conversationId: string
): Promise<void> {
  // Get the two most recent messages (the lead's new message + the AI message before it)
  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: 'desc' },
    take: 5,
    select: {
      id: true,
      sender: true,
      timestamp: true,
      gotResponse: true
    }
  });

  if (recentMessages.length < 2) return;

  const leadMsg = recentMessages[0];
  if (leadMsg.sender !== 'LEAD') return;

  // Find the most recent AI message before this lead message
  const aiMsg = recentMessages.find(
    (m) => (m.sender === 'AI' || m.sender === 'HUMAN') && m.gotResponse === null
  );

  if (!aiMsg) return;

  const responseTime = Math.round(
    (new Date(leadMsg.timestamp).getTime() -
      new Date(aiMsg.timestamp).getTime()) /
      1000
  );

  // Count how many lead messages came after the AI message
  const leadMsgCount = await prisma.message.count({
    where: {
      conversationId,
      sender: 'LEAD',
      timestamp: { gt: aiMsg.timestamp }
    }
  });

  await prisma.message.update({
    where: { id: aiMsg.id },
    data: {
      gotResponse: true,
      responseTimeSeconds: Math.max(0, responseTime),
      leadContinuedConversation: leadMsgCount >= 2
    }
  });
}
