/**
 * Lead Scoring Engine — QualifyDMs
 *
 * Computes two scores after every message exchange:
 *   1. qualityScore (0-100) on Lead — "How likely is this person to buy?"
 *   2. priorityScore (0-100) on Conversation — "How urgently should we respond?"
 *
 * The engine runs AFTER every AI reply and every incoming lead message.
 * Scores feed back into the AI prompt so the AI adapts its approach
 * based on lead temperature in real-time.
 *
 * SCORING DIMENSIONS (qualityScore):
 *   Engagement    (0-25) — Are they actively participating?
 *   Funnel Stage  (0-25) — How far through qualification?
 *   Intent        (0-20) — Are they showing buying signals?
 *   Objections    (0-15) — Have they raised AND resolved objections?
 *   Profile       (0-15) — Do we have qualifying data on them?
 *
 * PRIORITY DIMENSIONS (priorityScore):
 *   Lead temperature × recency × unread status × funnel position
 */

import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoringInput {
  conversationId: string;
  leadId: string;
  accountId: string;
}

export interface ScoringResult {
  qualityScore: number;
  priorityScore: number;
  temperatureLabel: 'COLD' | 'WARM' | 'HOT' | 'ON_FIRE';
  intentTag: 'HIGH_INTENT' | 'RESISTANT' | 'UNQUALIFIED' | 'NEUTRAL';
  scoringBreakdown: {
    engagement: number;
    funnelStage: number;
    intent: number;
    objections: number;
    profile: number;
  };
  shouldEscalateToHuman: boolean;
  escalationReason: string | null;
}

// ---------------------------------------------------------------------------
// Stage Weights — ordered by funnel progression
// ---------------------------------------------------------------------------

const STAGE_WEIGHTS: Record<string, number> = {
  // New 7-stage SOP sequence (canonical)
  OPENING: 3,
  SITUATION_DISCOVERY: 7,
  GOAL_EMOTIONAL_WHY: 12,
  URGENCY: 16,
  SOFT_PITCH_COMMITMENT: 20,
  FINANCIAL_SCREENING: 23,
  BOOKING: 25,
  // Legacy stage names (backward compat for historical data)
  GREETING: 2,
  QUALIFICATION: 5,
  VISION_BUILDING: 8,
  PAIN_IDENTIFICATION: 11,
  SOLUTION_OFFER: 17,
  CAPITAL_QUALIFICATION: 19
};

// ---------------------------------------------------------------------------
// Intent Signal Keywords
// ---------------------------------------------------------------------------

const HIGH_INTENT_SIGNALS = [
  'sign me up',
  'how do i start',
  "i'm ready",
  "let's do it",
  'book',
  'when can we',
  "i'm in",
  "let's go",
  'take my money',
  'send me the link',
  "what's next",
  'how do i join',
  'i want in',
  'where do i sign',
  'yes',
  'absolutely',
  'for sure',
  'definitely',
  'sounds perfect',
  'i need this',
  'this is exactly what i need',
  "when's the next call"
];

const MEDIUM_INTENT_SIGNALS = [
  'tell me more',
  'how does it work',
  'what do you offer',
  'sounds interesting',
  'curious',
  "what's included",
  'how much',
  "what's the investment",
  'can you explain',
  "i've been thinking",
  'what results'
];

const NEGATIVE_INTENT_SIGNALS = [
  'not interested',
  'stop messaging',
  'leave me alone',
  'unsubscribe',
  'scam',
  "don't contact me",
  'waste of time',
  "can't afford",
  'no money',
  'too expensive',
  'not for me',
  'not right now',
  'maybe later'
];

const OBJECTION_KEYWORDS: Record<string, string[]> = {
  trust: [
    'scam',
    'legit',
    'real',
    'trust',
    'proof',
    'too good to be true',
    'skeptical'
  ],
  money: ['afford', 'expensive', 'cost', 'price', 'budget', 'broke', 'money'],
  time: ['busy', 'no time', "don't have time", 'schedule', 'later'],
  prior_failure: [
    'tried before',
    "didn't work",
    'lost money',
    'burned',
    'failed'
  ],
  partner: ['wife', 'husband', 'partner', 'spouse', 'talk to'],
  thinking: ['think about it', 'let me think', 'need to think', 'consider']
};

// ---------------------------------------------------------------------------
// Main Scoring Function
// ---------------------------------------------------------------------------

export async function computeLeadScore(
  input: ScoringInput
): Promise<ScoringResult> {
  // 1. Fetch all data needed for scoring in one query
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    include: {
      messages: {
        orderBy: { timestamp: 'asc' }
      },
      lead: true
    }
  });

  if (!conversation || !conversation.lead) {
    return defaultScoringResult();
  }

  const { lead, messages } = conversation;
  const leadMessages = messages.filter((m) => m.sender === 'LEAD');
  const aiMessages = messages.filter((m) => m.sender === 'AI');
  const allLeadText = leadMessages
    .map((m) => m.content.toLowerCase())
    .join(' ');
  const latestStage = getLatestStage(messages);
  const now = new Date();

  // 2. Compute each dimension
  const engagement = computeEngagement(
    leadMessages,
    aiMessages,
    messages,
    now,
    conversation.lastMessageAt
  );
  const funnelStage = computeFunnelStage(latestStage, conversation);
  const intent = computeIntent(leadMessages, allLeadText, latestStage);
  const objections = computeObjections(allLeadText, latestStage);
  const profile = computeProfile(lead, leadMessages);

  // 3. Sum to qualityScore (0-100)
  const qualityScore = clamp(
    Math.round(engagement + funnelStage + intent + objections + profile),
    0,
    100
  );

  // 4. Compute priorityScore (0-100)
  const priorityScore = computePriority(
    qualityScore,
    conversation.unreadCount,
    conversation.lastMessageAt,
    latestStage,
    leadMessages,
    now
  );

  // 5. Derive temperature label (cold-start aware)
  const scoredLeadCount = await prisma.lead.count({
    where: { accountId: conversation.lead.accountId, qualityScore: { gt: 0 } }
  });
  const isColdStart = scoredLeadCount < 50;
  const temperatureLabel = getTemperatureLabel(qualityScore, isColdStart);

  // 6. Derive intent tag
  const intentTag = getIntentTag(intent, allLeadText, qualityScore);

  // 7. Check human escalation triggers
  const { shouldEscalate, reason } = checkEscalationTriggers(
    messages,
    leadMessages,
    allLeadText,
    qualityScore,
    latestStage,
    conversation.lastMessageAt,
    now
  );

  // 8. Persist scores to database
  await persistScores(
    input,
    qualityScore,
    priorityScore,
    intentTag,
    latestStage
  );

  return {
    qualityScore,
    priorityScore,
    temperatureLabel,
    intentTag,
    scoringBreakdown: {
      engagement: Math.round(engagement),
      funnelStage: Math.round(funnelStage),
      intent: Math.round(intent),
      objections: Math.round(objections),
      profile: Math.round(profile)
    },
    shouldEscalateToHuman: shouldEscalate,
    escalationReason: reason
  };
}

// ---------------------------------------------------------------------------
// Dimension 1: ENGAGEMENT (max 25)
// ---------------------------------------------------------------------------

function computeEngagement(
  leadMessages: any[],
  aiMessages: any[],
  allMessages: any[],
  now: Date,
  lastMessageAt: Date | null
): number {
  let score = 0;

  // 1a. Response rate — what % of AI messages got a lead reply? (max 8)
  if (aiMessages.length > 0) {
    let repliedCount = 0;
    for (const aiMsg of aiMessages) {
      const gotReply = allMessages.some(
        (m) => m.sender === 'LEAD' && m.timestamp > aiMsg.timestamp
      );
      if (gotReply) repliedCount++;
    }
    const responseRate = repliedCount / aiMessages.length;
    score += responseRate * 8;
  }

  // 1b. Message volume — more messages = more engaged (max 7)
  const leadMsgCount = leadMessages.length;
  if (leadMsgCount >= 15) score += 7;
  else if (leadMsgCount >= 10) score += 5.5;
  else if (leadMsgCount >= 6) score += 4;
  else if (leadMsgCount >= 3) score += 2.5;
  else if (leadMsgCount >= 1) score += 1;

  // 1c. Average message length — longer replies = higher engagement (max 5)
  if (leadMessages.length > 0) {
    const avgLen =
      leadMessages.reduce((sum: number, m: any) => sum + m.content.length, 0) /
      leadMessages.length;
    if (avgLen >= 120) score += 5;
    else if (avgLen >= 70) score += 3.5;
    else if (avgLen >= 30) score += 2;
    else score += 0.5;
  }

  // 1d. Recency — how fresh is this conversation? (max 5)
  if (lastMessageAt) {
    const hoursSince =
      (now.getTime() - new Date(lastMessageAt).getTime()) / (1000 * 60 * 60);
    if (hoursSince < 1) score += 5;
    else if (hoursSince < 4) score += 4;
    else if (hoursSince < 12) score += 3;
    else if (hoursSince < 24) score += 2;
    else if (hoursSince < 72) score += 1;
    // > 72 hours = 0 recency points
  }

  return Math.min(25, score);
}

// ---------------------------------------------------------------------------
// Dimension 2: FUNNEL STAGE (max 25)
// ---------------------------------------------------------------------------

function computeFunnelStage(latestStage: string, conversation: any): number {
  let score = STAGE_WEIGHTS[latestStage] || 0;

  // Bonus: velocity — did they progress through stages faster than average?
  const stageTimestamps = [
    conversation.stageQualificationAt,
    conversation.stageVisionBuildingAt,
    conversation.stagePainIdentificationAt,
    conversation.stageUrgencyAt,
    conversation.stageSolutionOfferAt,
    conversation.stageBookingAt
  ].filter(Boolean);

  if (stageTimestamps.length >= 3) {
    // If they've hit 3+ stages, they're progressing well
    const firstStage = new Date(stageTimestamps[0]).getTime();
    const lastStage = new Date(
      stageTimestamps[stageTimestamps.length - 1]
    ).getTime();
    const hoursToProgress = (lastStage - firstStage) / (1000 * 60 * 60);

    // Fast progression bonus (under 2 hours for 3+ stages)
    if (hoursToProgress < 2 && hoursToProgress > 0) {
      score = Math.min(25, score + 3);
    }
  }

  return Math.min(25, score);
}

// ---------------------------------------------------------------------------
// Dimension 3: INTENT SIGNALS (max 20)
// ---------------------------------------------------------------------------

function computeIntent(
  leadMessages: any[],
  allLeadText: string,
  latestStage: string
): number {
  let score = 0;

  // 3a. High intent keywords (max 10)
  const highMatches = HIGH_INTENT_SIGNALS.filter((kw) =>
    allLeadText.includes(kw)
  ).length;
  score += Math.min(10, highMatches * 2.5);

  // 3b. Medium intent keywords (max 5)
  const medMatches = MEDIUM_INTENT_SIGNALS.filter((kw) =>
    allLeadText.includes(kw)
  ).length;
  score += Math.min(5, medMatches * 1.5);

  // 3c. Negative intent penalty (max -8)
  const negMatches = NEGATIVE_INTENT_SIGNALS.filter((kw) =>
    allLeadText.includes(kw)
  ).length;
  score -= Math.min(8, negMatches * 2);

  // 3d. Stage-based intent boost (max 5)
  const advancedStages = [
    'BOOKING',
    'FINANCIAL_SCREENING',
    'SOFT_PITCH_COMMITMENT',
    // Legacy stage (backward compat)
    'SOLUTION_OFFER'
  ];
  if (advancedStages.includes(latestStage)) {
    score += 5;
  }

  // 3e. Question asking — leads who ask questions are engaged (max 3)
  const questionCount = leadMessages.filter((m: any) =>
    m.content.includes('?')
  ).length;
  score += Math.min(3, questionCount * 0.75);

  return clamp(score, 0, 20);
}

// ---------------------------------------------------------------------------
// Dimension 4: OBJECTION HANDLING (max 15)
// ---------------------------------------------------------------------------

function computeObjections(allLeadText: string, latestStage: string): number {
  let score = 5; // Base: no objections = neutral-positive

  // Detect objections raised
  const objectionsDetected: string[] = [];
  for (const [type, keywords] of Object.entries(OBJECTION_KEYWORDS)) {
    if (keywords.some((kw) => allLeadText.includes(kw))) {
      objectionsDetected.push(type);
    }
  }

  if (objectionsDetected.length === 0) {
    // No objections at all — smooth sailing
    return Math.min(15, score + 3);
  }

  // Objections raised shows engagement (+2 per objection, max 4)
  score += Math.min(4, objectionsDetected.length * 2);

  // If conversation continued past objection to advanced stages = resolved (+6)
  const resolvedStages = [
    // New 7-stage SOP sequence
    'GOAL_EMOTIONAL_WHY',
    'URGENCY',
    'SOFT_PITCH_COMMITMENT',
    'FINANCIAL_SCREENING',
    'BOOKING',
    // Legacy stages (backward compat)
    'VISION_BUILDING',
    'PAIN_IDENTIFICATION',
    'SOLUTION_OFFER',
    'CAPITAL_QUALIFICATION'
  ];
  if (resolvedStages.includes(latestStage)) {
    score += 6; // Resolved objections = very positive
  } else {
    // Stuck in objection handling = slight negative
    score -= 2;
  }

  return clamp(score, 0, 15);
}

// ---------------------------------------------------------------------------
// Dimension 5: PROFILE COMPLETENESS (max 15)
// ---------------------------------------------------------------------------

function computeProfile(lead: any, leadMessages: any[]): number {
  let score = 0;

  // 5a. Has a name (not just a username) (+3)
  if (lead.name && lead.name !== lead.handle && lead.name.length > 2) {
    score += 3;
  }

  // 5b. Trigger type — comments show higher public intent than DMs (+3)
  if (lead.triggerType === 'COMMENT') {
    score += 3;
  } else {
    score += 1.5; // DM still shows some intent
  }

  // 5c. Geography is a target market (+3)
  if (
    lead.geography === 'US' ||
    lead.geography === 'UK' ||
    lead.geography === 'Canada' ||
    lead.geography === 'Australia'
  ) {
    score += 3;
  } else if (lead.geography) {
    score += 1; // At least we know where they are
  }

  // 5d. Experience level available (+2)
  if (lead.experience) {
    score += 2;
  }

  // 5e. Income level available (+2)
  if (lead.incomeLevel) {
    if (lead.incomeLevel === 'high') score += 3;
    else if (lead.incomeLevel === 'mid') score += 2;
    else score += 0.5;
  }

  // 5f. Has shared personal context in messages — indicates trust (+2)
  const personalContextSignals = [
    'i work',
    'my job',
    'i make',
    'my business',
    'i earn',
    'my income',
    'i have'
  ];
  const allText = leadMessages
    .map((m: any) => m.content.toLowerCase())
    .join(' ');
  const sharedContext = personalContextSignals.filter((s) =>
    allText.includes(s)
  ).length;
  if (sharedContext >= 2) score += 2;
  else if (sharedContext >= 1) score += 1;

  return Math.min(15, score);
}

// ---------------------------------------------------------------------------
// Priority Score (0-100) — "Who needs attention RIGHT NOW?"
// ---------------------------------------------------------------------------

function computePriority(
  qualityScore: number,
  unreadCount: number,
  lastMessageAt: Date | null,
  latestStage: string,
  leadMessages: any[],
  now: Date
): number {
  let score = 0;

  // Base: quality score contributes 50% of priority
  score += qualityScore * 0.5;

  // Unread messages = needs attention (+20 max)
  if (unreadCount > 0) {
    score += Math.min(20, unreadCount * 7);
  }

  // Recency of last message (+15 max) — fresher = higher priority
  if (lastMessageAt) {
    const minutesSince =
      (now.getTime() - new Date(lastMessageAt).getTime()) / (1000 * 60);
    if (minutesSince < 5)
      score += 15; // Just messaged
    else if (minutesSince < 30)
      score += 12; // Within half hour
    else if (minutesSince < 120)
      score += 8; // Within 2 hours
    else if (minutesSince < 720) score += 4; // Within 12 hours
    // Older = 0 additional priority
  }

  // High-value funnel position bonus (+15 max)
  const criticalStages = [
    'BOOKING',
    'FINANCIAL_SCREENING',
    'SOFT_PITCH_COMMITMENT'
  ];
  const importantStages = [
    'URGENCY',
    'GOAL_EMOTIONAL_WHY',
    // Legacy stages (backward compat for historical messages)
    'SOLUTION_OFFER',
    'CAPITAL_QUALIFICATION',
    'PAIN_IDENTIFICATION'
  ];
  if (criticalStages.includes(latestStage)) {
    score += 15; // About to book — highest priority
  } else if (importantStages.includes(latestStage)) {
    score += 10;
  }

  return clamp(Math.round(score), 0, 100);
}

// ---------------------------------------------------------------------------
// Temperature Label
// ---------------------------------------------------------------------------

function getTemperatureLabel(
  score: number,
  isColdStart = false
): 'COLD' | 'WARM' | 'HOT' | 'ON_FIRE' {
  // Cold-start: use lower thresholds when the account has < 50 scored
  // conversations. LLM confidence scores are poorly calibrated on small
  // datasets — high thresholds on a cold system either block everything
  // good (reviewer fatigue) or pass everything bad. Lower the bar initially
  // and raise it as the corpus grows.
  if (isColdStart) {
    if (score >= 65) return 'ON_FIRE';
    if (score >= 45) return 'HOT';
    if (score >= 25) return 'WARM';
    return 'COLD';
  }
  if (score >= 80) return 'ON_FIRE';
  if (score >= 55) return 'HOT';
  if (score >= 30) return 'WARM';
  return 'COLD';
}

// ---------------------------------------------------------------------------
// Intent Tag
// ---------------------------------------------------------------------------

function getIntentTag(
  intentScore: number,
  allLeadText: string,
  qualityScore: number
): 'HIGH_INTENT' | 'RESISTANT' | 'UNQUALIFIED' | 'NEUTRAL' {
  const negMatches = NEGATIVE_INTENT_SIGNALS.filter((kw) =>
    allLeadText.includes(kw)
  ).length;

  if (qualityScore >= 65 && intentScore >= 12) return 'HIGH_INTENT';
  if (negMatches >= 3) return 'UNQUALIFIED';
  if (negMatches >= 1 && intentScore < 5) return 'RESISTANT';
  return 'NEUTRAL';
}

// ---------------------------------------------------------------------------
// Human Escalation Triggers
// ---------------------------------------------------------------------------

function checkEscalationTriggers(
  allMessages: any[],
  leadMessages: any[],
  allLeadText: string,
  qualityScore: number,
  latestStage: string,
  lastMessageAt: Date | null,
  now: Date
): { shouldEscalate: boolean; reason: string | null } {
  // Trigger 1: Lead explicitly asks to speak to a human
  // Signals are niche-agnostic. Tenant-specific owner-name signals
  // (e.g. "talk to <founder>") should be added via tenant config, not
  // hardcoded here — otherwise "talk to daniel" leaks DAE into every
  // tenant's escalation logic.
  const humanRequestSignals = [
    'talk to a real person',
    'speak to someone',
    'are you a bot',
    'are you real',
    'talk to a human',
    'real person',
    'is this ai',
    'are you ai',
    'this is automated',
    'talk to the owner',
    'talk to your manager',
    'speak to the founder'
  ];
  const lastLeadMsg =
    leadMessages[leadMessages.length - 1]?.content?.toLowerCase() || '';
  if (humanRequestSignals.some((s) => lastLeadMsg.includes(s))) {
    return { shouldEscalate: true, reason: 'Lead requested human contact' };
  }

  // Trigger 2: Hot lead stalling — score > 70 but no progress for 6+ hours
  if (qualityScore > 70 && lastMessageAt) {
    const hoursSince =
      (now.getTime() - new Date(lastMessageAt).getTime()) / (1000 * 60 * 60);
    if (
      hoursSince > 6 &&
      ['BOOKING', 'FINANCIAL_SCREENING', 'SOFT_PITCH_COMMITMENT'].includes(
        latestStage
      )
    ) {
      return {
        shouldEscalate: true,
        reason: 'Hot lead stalling at critical stage — needs human touch'
      };
    }
  }

  // Trigger 3: AI sent 3+ messages without any lead response (potential confusion)
  const lastMessages = allMessages.slice(-4);
  const consecutiveAI = lastMessages.filter((m) => m.sender === 'AI').length;
  if (
    consecutiveAI >= 3 &&
    lastMessages[lastMessages.length - 1]?.sender === 'AI'
  ) {
    return {
      shouldEscalate: true,
      reason: 'AI sent 3+ unanswered messages — lead may be confused or lost'
    };
  }

  // Trigger 4: Lead sent a very long message (150+ chars) suggesting complex situation
  if (lastLeadMsg.length > 300) {
    return {
      shouldEscalate: true,
      reason:
        'Lead sent detailed message — may need personalized human response'
    };
  }

  // Trigger 5: Pricing question that keeps repeating
  const priceMentions = leadMessages.filter((m: any) =>
    /how much|price|cost|investment|what.*(pay|charge)/i.test(m.content)
  ).length;
  if (priceMentions >= 3) {
    return {
      shouldEscalate: true,
      reason: "Lead asked about pricing 3+ times — AI deflection isn't working"
    };
  }

  return { shouldEscalate: false, reason: null };
}

// ---------------------------------------------------------------------------
// Persist Scores to Database
// ---------------------------------------------------------------------------

async function persistScores(
  input: ScoringInput,
  qualityScore: number,
  priorityScore: number,
  intentTag: string,
  latestStage: string
): Promise<void> {
  try {
    // Update Lead qualityScore
    await prisma.lead.update({
      where: { id: input.leadId },
      data: { qualityScore }
    });

    // Update Conversation priorityScore + intentTag + analysis timestamp
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        priorityScore,
        leadIntentTag: intentTag as any,
        lastAIAnalysis: new Date()
      }
    });

    // Auto-tag the lead based on score thresholds
    await autoTagLead(
      input.accountId,
      input.leadId,
      qualityScore,
      intentTag,
      latestStage
    );
  } catch (error) {
    console.error('[ScoringEngine] Failed to persist scores:', error);
    // Non-fatal — don't crash the conversation flow if scoring persistence fails
  }
}

// ---------------------------------------------------------------------------
// Auto-Tagging
// ---------------------------------------------------------------------------

async function autoTagLead(
  accountId: string,
  leadId: string,
  qualityScore: number,
  intentTag: string,
  latestStage: string
): Promise<void> {
  const tagsToApply: string[] = [];

  // Temperature tags
  if (qualityScore >= 80) tagsToApply.push('ON_FIRE');
  else if (qualityScore >= 55) tagsToApply.push('HOT_LEAD');

  // Intent tags
  if (intentTag === 'HIGH_INTENT') tagsToApply.push('HIGH_INTENT');
  if (intentTag === 'UNQUALIFIED') tagsToApply.push('UNQUALIFIED');

  // Stage-based tags
  if (latestStage === 'BOOKING') tagsToApply.push('READY_TO_BOOK');

  for (const tagName of tagsToApply) {
    try {
      // Upsert tag (create if it doesn't exist for this account)
      const tag = await prisma.tag.upsert({
        where: { accountId_name: { accountId, name: tagName } },
        create: {
          accountId,
          name: tagName,
          isAuto: true,
          color: getTagColor(tagName)
        },
        update: {}
      });

      // Apply tag to lead (skip if already exists)
      await prisma.leadTag.upsert({
        where: { leadId_tagId: { leadId, tagId: tag.id } },
        create: {
          leadId,
          tagId: tag.id,
          appliedBy: 'AI',
          confidence: qualityScore / 100
        },
        update: { confidence: qualityScore / 100 }
      });
    } catch {
      // Skip tag errors silently — non-critical
    }
  }
}

function getTagColor(tagName: string): string {
  const colors: Record<string, string> = {
    ON_FIRE: '#EF4444',
    HOT_LEAD: '#F97316',
    HIGH_INTENT: '#22C55E',
    UNQUALIFIED: '#6B7280',
    READY_TO_BOOK: '#8B5CF6'
  };
  return colors[tagName] || '#3B82F6';
}

// ---------------------------------------------------------------------------
// Backfill Message Effectiveness Metrics
// ---------------------------------------------------------------------------

/**
 * Run AFTER a lead sends a message to backfill effectiveness data
 * on the previous AI message. This powers the self-optimizing loop.
 */
export async function backfillMessageEffectiveness(
  conversationId: string,
  leadMessageTimestamp: Date
): Promise<void> {
  try {
    // Find the most recent AI message before this lead reply
    const lastAIMessage = await prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'AI',
        timestamp: { lt: leadMessageTimestamp }
      },
      orderBy: { timestamp: 'desc' }
    });

    if (!lastAIMessage) return;

    // Calculate response time
    const responseTimeSeconds = Math.round(
      (leadMessageTimestamp.getTime() -
        new Date(lastAIMessage.timestamp).getTime()) /
        1000
    );

    // Check if lead continued conversation (2+ messages after AI's message)
    const subsequentLeadMessages = await prisma.message.count({
      where: {
        conversationId,
        sender: 'LEAD',
        timestamp: { gt: lastAIMessage.timestamp }
      }
    });

    await prisma.message.update({
      where: { id: lastAIMessage.id },
      data: {
        gotResponse: true,
        responseTimeSeconds,
        leadContinuedConversation: subsequentLeadMessages >= 2
      }
    });
  } catch (error) {
    console.error(
      '[ScoringEngine] Failed to backfill message effectiveness:',
      error
    );
  }
}

// ---------------------------------------------------------------------------
// SOP Feedback Generator — what the AI learns from scores
// ---------------------------------------------------------------------------

/**
 * Generates a scoring context string that gets injected into the AI's
 * system prompt so it can adapt its approach based on lead temperature.
 */
export function generateScoringContextForPrompt(result: ScoringResult): string {
  const lines: string[] = [];

  lines.push(`## LEAD SCORING INTELLIGENCE`);
  lines.push(
    `- Quality Score: ${result.qualityScore}/100 (${result.temperatureLabel})`
  );
  lines.push(`- Priority: ${result.priorityScore}/100`);
  lines.push(`- Intent: ${result.intentTag}`);
  lines.push(
    `- Breakdown: Engagement ${result.scoringBreakdown.engagement}/25, Funnel ${result.scoringBreakdown.funnelStage}/25, Intent ${result.scoringBreakdown.intent}/20, Objections ${result.scoringBreakdown.objections}/15, Profile ${result.scoringBreakdown.profile}/15`
  );
  lines.push('');

  // Dynamic AI behavior instructions based on score
  if (result.temperatureLabel === 'ON_FIRE') {
    lines.push(
      `## SCORING DIRECTIVE: ON_FIRE LEAD (${result.qualityScore}/100)`
    );
    lines.push(
      `This lead is extremely hot. Do NOT over-qualify or ask unnecessary questions.`
    );
    lines.push(
      `Move toward booking immediately. Be direct: "I have a slot open [time] — want me to lock you in?"`
    );
    lines.push(
      `Every extra message is a chance for them to cool off. Close NOW.`
    );
  } else if (result.temperatureLabel === 'HOT') {
    lines.push(`## SCORING DIRECTIVE: HOT LEAD (${result.qualityScore}/100)`);
    lines.push(
      `This lead is engaged and showing strong signals. Continue building urgency and value.`
    );
    lines.push(
      `Start transitioning toward the booking pitch. Don't rush, but don't stall either.`
    );
    lines.push(
      `Deploy proof points and social proof to push them over the edge.`
    );
  } else if (result.temperatureLabel === 'WARM') {
    lines.push(`## SCORING DIRECTIVE: WARM LEAD (${result.qualityScore}/100)`);
    lines.push(
      `This lead is interested but not yet convinced. Focus on understanding their specific pain.`
    );
    lines.push(
      `Use vision building — paint the picture of their life after solving this problem.`
    );
    lines.push(`Don't pitch yet. Build trust, uncover their emotional why.`);
  } else {
    lines.push(`## SCORING DIRECTIVE: COLD LEAD (${result.qualityScore}/100)`);
    lines.push(`This lead needs warming up. Don't push — they'll disengage.`);
    lines.push(
      `Focus purely on building rapport. Ask casual questions about their situation.`
    );
    lines.push(
      `If the tenant has a free value asset (e.g. bootcamp link, guide, case study) configured in promptConfig.assetLinks or knowledgeAssets, offer it to earn trust before any qualification. Otherwise focus on rapport only.`
    );
  }

  if (result.intentTag === 'RESISTANT') {
    lines.push('');
    lines.push(
      `⚠️ RESISTANT LEAD: This person has shown skepticism or negative signals.`
    );
    lines.push(
      `Do NOT pitch. Acknowledge their concerns directly. Offer to answer any questions with zero pressure.`
    );
    lines.push(
      `If they remain resistant after 2 more exchanges, gracefully close: "No worries at all. Door's always open."`
    );
  }

  if (result.shouldEscalateToHuman) {
    lines.push('');
    lines.push(`🚨 ESCALATION RECOMMENDED: ${result.escalationReason}`);
    lines.push(
      `Consider handing this conversation to a human. If you continue, be extra careful and acknowledge any confusion.`
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLatestStage(messages: any[]): string {
  // Walk messages backward to find the most recent stage classification
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].stage) {
      return messages[i].stage;
    }
  }
  return 'GREETING';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function defaultScoringResult(): ScoringResult {
  return {
    qualityScore: 0,
    priorityScore: 0,
    temperatureLabel: 'COLD',
    intentTag: 'NEUTRAL',
    scoringBreakdown: {
      engagement: 0,
      funnelStage: 0,
      intent: 0,
      objections: 0,
      profile: 0
    },
    shouldEscalateToHuman: false,
    escalationReason: null
  };
}
