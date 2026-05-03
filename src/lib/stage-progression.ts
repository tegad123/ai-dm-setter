import type { LeadStage, Platform } from '@prisma/client';
import { transitionLeadStage } from '@/lib/lead-stage';

export type CapitalOutcome =
  | 'passed'
  | 'failed'
  | 'hedging'
  | 'ambiguous'
  | 'not_asked'
  | 'not_evaluated';

type AwayModeAccount = {
  awayMode?: boolean | null;
  awayModeInstagram?: boolean | null;
  awayModeFacebook?: boolean | null;
};

const STAGE_TO_LEAD_STAGE: Record<string, LeadStage> = {
  // Current 7-stage SOP sequence.
  OPENING: 'ENGAGED',
  SITUATION_DISCOVERY: 'QUALIFYING',
  DISCOVERY: 'QUALIFYING',
  GOAL_EMOTIONAL_WHY: 'QUALIFYING',
  GOAL_WHY: 'QUALIFYING',
  URGENCY: 'QUALIFYING',
  SOFT_PITCH_COMMITMENT: 'QUALIFIED',
  SOFT_PITCH: 'QUALIFIED',
  FINANCIAL_SCREENING: 'QUALIFYING',
  FINANCIAL: 'QUALIFYING',
  BOOKING: 'CALL_PROPOSED',
  BOOKING_TZ_ASK: 'CALL_PROPOSED',
  BOOKING_CONFIRM: 'CALL_PROPOSED',
  POST_UNQUALIFIED_CONVERSATION_GUARD: 'UNQUALIFIED',

  // Legacy stage names and old suggestion snapshots.
  GREETING: 'ENGAGED',
  QUALIFICATION: 'QUALIFYING',
  VISION_BUILDING: 'QUALIFYING',
  PAIN_IDENTIFICATION: 'QUALIFYING',
  SOLUTION_OFFER: 'QUALIFYING',
  CAPITAL_QUALIFICATION: 'QUALIFYING',
  NEW_LEAD: 'ENGAGED',
  ENGAGED: 'ENGAGED',
  QUALIFYING: 'QUALIFYING',
  QUALIFIED: 'QUALIFIED',
  CALL_PROPOSED: 'CALL_PROPOSED',
  UNQUALIFIED: 'UNQUALIFIED'
};

const STAGE_PRIORITY: Record<LeadStage, number> = {
  NEW_LEAD: 0,
  ENGAGED: 1,
  QUALIFYING: 2,
  QUALIFIED: 3,
  CALL_PROPOSED: 4,
  BOOKED: 5,
  SHOWED: 6,
  CLOSED_WON: 7,
  CLOSED_LOST: 10,
  UNQUALIFIED: 10,
  GHOSTED: 10,
  NURTURE: 10,
  NO_SHOWED: 10,
  RESCHEDULED: 10
};

function normalizeStage(stage: string | null | undefined): string | null {
  const trimmed = stage?.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

function isFinancialStage(stage: string | null): boolean {
  return (
    stage === 'FINANCIAL_SCREENING' ||
    stage === 'FINANCIAL' ||
    stage === 'CAPITAL_QUALIFICATION'
  );
}

export function resolvePlatformAwayMode(
  account: AwayModeAccount | null | undefined,
  platform: Platform | string
): boolean {
  if (platform === 'INSTAGRAM') {
    return account?.awayModeInstagram ?? account?.awayMode ?? false;
  }
  if (platform === 'FACEBOOK') {
    return account?.awayModeFacebook ?? account?.awayMode ?? false;
  }
  return account?.awayMode ?? false;
}

export function shouldMarkEngagedFromLeadMessage(
  currentStage: LeadStage | string | null | undefined,
  priorLeadMessageCount: number
): boolean {
  return currentStage === 'NEW_LEAD' && priorLeadMessageCount > 0;
}

export function mapAIStageToLeadStage(
  conversationStage: string | null | undefined,
  subStage: string | null,
  capitalOutcome: CapitalOutcome = 'not_evaluated',
  options: { warnUnknown?: boolean } = {}
): LeadStage | null {
  const normalizedStage = normalizeStage(conversationStage);
  const normalizedSubStage = normalizeStage(subStage);

  const isDownsellBranch =
    typeof normalizedSubStage === 'string' &&
    (normalizedSubStage.startsWith('WATERFALL_') ||
      normalizedSubStage === 'LOW_TICKET');

  if (isDownsellBranch || capitalOutcome === 'failed') {
    return 'UNQUALIFIED';
  }

  const mapped = normalizedStage
    ? STAGE_TO_LEAD_STAGE[normalizedStage]
    : undefined;

  if (!mapped) {
    if (options.warnUnknown && normalizedStage) {
      console.warn(
        `[stage-progression] Unknown AI stage: ${conversationStage}`
      );
    }
    return null;
  }

  if (isFinancialStage(normalizedStage) && capitalOutcome === 'passed') {
    return 'QUALIFIED';
  }

  return mapped;
}

export async function updateLeadStageFromConversation(
  leadId: string,
  currentStage: LeadStage | string,
  conversationStage: string | null | undefined,
  subStage: string | null,
  capitalOutcome: CapitalOutcome = 'not_evaluated',
  options: {
    transitionedBy?: string;
    reasonPrefix?: string;
    warnUnknown?: boolean;
  } = {}
): Promise<LeadStage | null> {
  const newStage = mapAIStageToLeadStage(
    conversationStage,
    subStage,
    capitalOutcome,
    { warnUnknown: options.warnUnknown ?? true }
  );

  if (!newStage) return null;

  const currentPriority = STAGE_PRIORITY[currentStage as LeadStage] ?? 0;
  const newPriority = STAGE_PRIORITY[newStage] ?? 0;

  if (newPriority > currentPriority && currentPriority < 10) {
    await transitionLeadStage(
      leadId,
      newStage,
      options.transitionedBy ?? 'ai',
      `${options.reasonPrefix ?? 'auto'}: conv=${conversationStage ?? 'null'}, sub=${subStage ?? 'null'}, capital=${capitalOutcome}`
    );
    console.log(
      `[stage-progression] Lead ${leadId} stage: ${currentStage} -> ${newStage} (conv=${conversationStage ?? 'null'}, sub=${subStage ?? 'null'}, capital=${capitalOutcome})`
    );
    return newStage;
  }

  return null;
}
