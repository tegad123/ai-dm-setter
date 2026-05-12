// ---------------------------------------------------------------------------
// script-step-progression.ts
// ---------------------------------------------------------------------------
// Step-progression enforcement helpers for the daetradez 22-step script
// (and any operator script with a call-proposal stage).
//
// Two production failures motivate this module:
//
//  1. The script serializer dumps ALL of an account's script steps into
//     the system prompt every turn. The LLM sees Step 16 (call proposal)
//     while still on Step 2 and pattern-matches its way there, collapsing
//     a 22-step qualification flow into 4 exchanges (@daniel_elumelu
//     2026-05-08). The fix injects ONLY the current step + next step.
//
//  2. ScriptStep.completionRule is null for parsed scripts (the parser
//     doesn't synthesise rules), so isStepComplete defaults to TRUE for
//     every step and computeSystemStage just returns the last step.
//     Without a code-level gate, "the LLM thinks the call is appropriate"
//     is the only thing standing between a lukewarm lead and a premature
//     pitch. This module adds a hard gate keyed on capturedDataPoints.
//
// All helpers here are pure (no DB). Callers are ai-engine,
// script-serializer, and voice-quality-gate.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CapturedDataPoints shape compatibility
// ---------------------------------------------------------------------------
// Two shapes coexist in Conversation.capturedDataPoints:
//   - structured (script-state-recovery): { key: { value, confidence } }
//   - flat (runtime-judgment captures): { key: "string" }
// hasCapturedDataPoint accepts both so the prereq gate doesn't care
// which pipeline wrote the value.
// ---------------------------------------------------------------------------

import { equivalentCapturedDataPointKeys } from '@/lib/captured-data-keys';

function normalizeCapturedDataPointKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function capturedDataPointRaw(
  points: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  if (!points) return undefined;

  for (const candidate of equivalentCapturedDataPointKeys(key)) {
    if (Object.prototype.hasOwnProperty.call(points, candidate)) {
      return points[candidate];
    }
  }

  const normalizedKeys = new Set(
    equivalentCapturedDataPointKeys(key).map(normalizeCapturedDataPointKey)
  );
  for (const [candidateKey, value] of Object.entries(points)) {
    if (normalizedKeys.has(normalizeCapturedDataPointKey(candidateKey))) {
      return value;
    }
  }

  return undefined;
}

export function hasCapturedDataPoint(
  points: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  const raw = capturedDataPointRaw(points, key);
  if (raw === null || raw === undefined) return false;
  if (typeof raw === 'string') return raw.trim().length > 0;
  if (typeof raw === 'number') return Number.isFinite(raw);
  if (typeof raw === 'boolean') return raw === true;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapped = raw as Record<string, unknown>;
    if (!('value' in wrapped)) return false;
    const v = wrapped.value;
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim().length > 0;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'boolean') return v === true;
    return Boolean(v);
  }
  return false;
}

function capturedPointValue(
  points: Record<string, unknown> | null | undefined,
  key: string
): unknown {
  const raw = capturedDataPointRaw(points, key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const wrapped = raw as Record<string, unknown>;
    return 'value' in wrapped ? wrapped.value : raw;
  }
  return raw;
}

function capturedPointRecord(
  points: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const raw = capturedDataPointRaw(points, key);
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function capturedPointSourceStepNumber(
  point: Record<string, unknown> | null
): number | null {
  const raw = point?.sourceStepNumber;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function capturedPointHasNumericValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return /\b\$?\s*\d+(?:[.,]\d+)?\s*[km]?\b/i.test(value.trim());
}

function hasCapturedDataPointFromStep(params: {
  points: Record<string, unknown> | null | undefined;
  keys: string[];
  stepNumber: number;
  requireNumeric?: boolean;
  expectedStepAsked?: boolean;
}): boolean {
  const hasBranchHistory = branchHistoryEvents(params.points).length > 0;
  for (const key of params.keys) {
    if (!hasCapturedDataPoint(params.points, key)) continue;
    const point = capturedPointRecord(params.points, key);
    const value = point ? point.value : capturedPointValue(params.points, key);
    if (params.requireNumeric && !capturedPointHasNumericValue(value)) {
      continue;
    }

    const sourceStepNumber = capturedPointSourceStepNumber(point);
    if (sourceStepNumber === params.stepNumber) return true;

    // Recovery may first persist a numeric target-income answer while the
    // cursor is already on the follow-up/deep-why step. If durable history
    // proves the target-income step was reached or the conversation has
    // already moved beyond it, trust the numeric value even when its source
    // metadata points one or more steps later.
    if (
      params.requireNumeric &&
      hasBranchHistory &&
      sourceStepNumber !== null &&
      sourceStepNumber > params.stepNumber &&
      stepReachedOrPassedByBranchHistory(params.points, params.stepNumber)
    ) {
      return true;
    }

    // In live pipeline runs, branchHistory/source metadata can lag behind
    // the transcript even though the scripted ask has actually fired. If
    // the AI history proves the expected ask happened, a numeric value in
    // the right captured slot is sufficient unless it is explicitly sourced
    // before the expected step.
    if (
      params.requireNumeric &&
      params.expectedStepAsked &&
      (sourceStepNumber === null || sourceStepNumber >= params.stepNumber)
    ) {
      return true;
    }

    // Durable branchHistory proves the expected step was reached, but older
    // capture writers sometimes stored flat camelCase values without source
    // metadata. Accept those no-source values only when the durable ledger
    // already pins this exact step as selected/completed; explicit wrong-source
    // values still fail so current-vs-target amount fields do not bleed
    // together.
    if (
      hasBranchHistory &&
      sourceStepNumber === null &&
      stepReachedOrPassedByBranchHistory(params.points, params.stepNumber)
    ) {
      return true;
    }

    // Legacy conversations/tests may have flat capturedDataPoints and no
    // durable branchHistory yet. Preserve that fallback only when the
    // conversation has no durable step ledger to contradict the value.
    if (!hasBranchHistory && sourceStepNumber === null) return true;
  }
  return false;
}

export function incomeGoalSatisfiedByExpectedStep(
  points: Record<string, unknown> | null | undefined,
  stepNumber = 9,
  evidence?: { expectedStepAsked?: boolean }
): boolean {
  return hasCapturedDataPointFromStep({
    points,
    keys: ['incomeGoal', 'income_goal'],
    stepNumber,
    requireNumeric: true,
    expectedStepAsked: evidence?.expectedStepAsked === true
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function branchHistoryEvents(
  points: Record<string, unknown> | null | undefined
): Record<string, unknown>[] {
  const raw = asRecord(points)?.branchHistory;
  return Array.isArray(raw)
    ? raw
        .map((event) => asRecord(event))
        .filter((event): event is Record<string, unknown> => event !== null)
    : [];
}

const BUY_IN_SIGNAL =
  /\b(buy[\s-]?in|bought\s+in|commit(?:ted|ment)?|on\s+board|agree(?:d|ment)?)\b/i;
const POSITIVE_BRANCH_SIGNAL =
  /\b(clear|confirm(?:ed|ation)?|yes|yeah|yep|affirm(?:ed|ative)?|accept(?:ed)?|ready|committed|positive|go\s+ahead|proceed)\b/i;
const NEGATIVE_BRANCH_SIGNAL =
  /\b(no|not|unclear|hesitant|hesitation|objection|decline(?:d)?|negative|unsure|not\s+ready)\b/i;

const DEEP_WHY_STEP_SIGNAL =
  /\b(deep\s+why|deeper\s+why|desired\s+outcome|personal\s+(?:why|reason)|emotional\s+(?:why|reason)|reason\s+behind\s+(?:the\s+)?goal|why\s+(?:it|this|that)\s+(?:is|matters)|family\s+freedom|time\s+freedom)\b/i;

function deepWhySatisfiedByBranchHistory(
  points: Record<string, unknown> | null | undefined
): boolean {
  return branchHistoryEvents(points).some((event) => {
    if (event.eventType !== 'step_completed') return false;
    const stepTitle =
      typeof event.stepTitle === 'string' ? event.stepTitle : '';
    const selectedBranchLabel =
      typeof event.selectedBranchLabel === 'string'
        ? event.selectedBranchLabel
        : '';
    return DEEP_WHY_STEP_SIGNAL.test(`${stepTitle} ${selectedBranchLabel}`);
  });
}

function stepCompletedByBranchHistory(
  points: Record<string, unknown> | null | undefined,
  stepNumber: number
): boolean {
  return branchHistoryEvents(points).some((event) => {
    if (event.eventType !== 'step_completed') return false;
    const eventStepNumber =
      typeof event.stepNumber === 'number'
        ? event.stepNumber
        : Number(event.stepNumber);
    return eventStepNumber === stepNumber;
  });
}

function stepReachedByBranchHistory(
  points: Record<string, unknown> | null | undefined,
  stepNumber: number
): boolean {
  return branchHistoryEvents(points).some((event) => {
    if (
      event.eventType !== 'branch_selected' &&
      event.eventType !== 'step_completed'
    ) {
      return false;
    }
    const eventStepNumber =
      typeof event.stepNumber === 'number'
        ? event.stepNumber
        : Number(event.stepNumber);
    return eventStepNumber === stepNumber;
  });
}

function stepReachedOrPassedByBranchHistory(
  points: Record<string, unknown> | null | undefined,
  stepNumber: number
): boolean {
  return branchHistoryEvents(points).some((event) => {
    if (
      event.eventType !== 'branch_selected' &&
      event.eventType !== 'step_completed'
    ) {
      return false;
    }
    const eventStepNumber =
      typeof event.stepNumber === 'number'
        ? event.stepNumber
        : Number(event.stepNumber);
    return Number.isFinite(eventStepNumber) && eventStepNumber >= stepNumber;
  });
}

function buyInConfirmedByBranchHistory(
  points: Record<string, unknown> | null | undefined,
  stepNumber: number
): boolean {
  return branchHistoryEvents(points).some((event) => {
    if (event.eventType !== 'step_completed') return false;
    const eventStepNumber =
      typeof event.stepNumber === 'number'
        ? event.stepNumber
        : Number(event.stepNumber);
    if (eventStepNumber !== stepNumber) return false;

    const selectedBranchLabel =
      typeof event.selectedBranchLabel === 'string'
        ? event.selectedBranchLabel
        : '';
    const stepTitle =
      typeof event.stepTitle === 'string' ? event.stepTitle : '';
    const combined = `${stepTitle} ${selectedBranchLabel}`;

    if (NEGATIVE_BRANCH_SIGNAL.test(selectedBranchLabel)) return false;
    return (
      (BUY_IN_SIGNAL.test(selectedBranchLabel) &&
        POSITIVE_BRANCH_SIGNAL.test(selectedBranchLabel)) ||
      (BUY_IN_SIGNAL.test(stepTitle) &&
        POSITIVE_BRANCH_SIGNAL.test(selectedBranchLabel)) ||
      (BUY_IN_SIGNAL.test(combined) && POSITIVE_BRANCH_SIGNAL.test(combined))
    );
  });
}

function prereqSatisfiedByCapturedState(
  points: Record<string, unknown> | null | undefined,
  prereq: Pick<CallProposalPrereq, 'id' | 'stepNumber' | 'acceptableKeys'>,
  evidence?: { incomeGoalAsked?: boolean }
): boolean {
  if (
    prereq.id === 'buy_in_confirmed' &&
    buyInConfirmedByBranchHistory(points, prereq.stepNumber)
  ) {
    return true;
  }

  if (
    prereq.id === 'desired_outcome_or_deep_why' &&
    deepWhySatisfiedByBranchHistory(points)
  ) {
    return true;
  }

  if (prereq.id === 'income_goal') {
    return incomeGoalSatisfiedByExpectedStep(points, prereq.stepNumber, {
      expectedStepAsked: evidence?.incomeGoalAsked === true
    });
  }

  if (
    prereq.id === 'belief_break_delivered' &&
    stepCompletedByBranchHistory(points, prereq.stepNumber)
  ) {
    return true;
  }

  return prereq.acceptableKeys.some((key) => {
    if (key === 'beliefBreakDelivered' || key === 'belief_break_delivered') {
      return capturedPointValue(points, key) === 'complete';
    }
    return hasCapturedDataPoint(points, key);
  });
}

// ---------------------------------------------------------------------------
// Call-proposal prereq gate
// ---------------------------------------------------------------------------

/**
 * Each prereq has a list of acceptable keys — ANY captured key in the
 * list satisfies the prereq. Models the "obstacle OR early_obstacle"
 * and "deepWhy OR desiredOutcome" cases from the daetradez spec.
 */
export interface CallProposalPrereq {
  /** Stable id used in regen directives + audit logs. */
  id: string;
  /** Human label for the regen directive shown to the LLM. */
  label: string;
  /** Step number the operator script asks this in (1-indexed). */
  stepNumber: number;
  /** Any-of: at least one of these keys must be captured. */
  acceptableKeys: string[];
}

/**
 * Daetradez script call-proposal prerequisites — the eight data points
 * that MUST exist on the conversation before Step 16 can fire. If any
 * is missing when the AI emits call-proposal language, the gate blocks
 * the reply and forces a regen back to the first missing prereq.
 *
 * Order matches script step order so the regen directive can point to
 * the earliest missing step.
 */
export const CALL_PROPOSAL_PREREQS: CallProposalPrereq[] = [
  {
    id: 'work_background',
    label: "lead's job / current work situation",
    stepNumber: 5,
    acceptableKeys: ['workBackground', 'work_background', 'job']
  },
  {
    id: 'monthly_income',
    label:
      "lead's monthly income (or explicit skip per Step 7 judge condition)",
    stepNumber: 7,
    acceptableKeys: [
      'monthlyIncome',
      'monthly_income',
      'incomeMonthly',
      'monthlyIncomeSkipped',
      'monthly_income_skipped'
    ]
  },
  {
    id: 'replace_or_supplement',
    label: 'whether trading is meant to replace the job or supplement it',
    stepNumber: 8,
    acceptableKeys: ['replaceOrSupplement', 'replace_or_supplement']
  },
  {
    id: 'income_goal',
    label: "lead's monthly income goal from trading",
    stepNumber: 9,
    acceptableKeys: ['incomeGoal', 'income_goal']
  },
  {
    id: 'desired_outcome_or_deep_why',
    label:
      "lead's deeper why / desired outcome (the personal reason behind the goal)",
    stepNumber: 10,
    acceptableKeys: ['desiredOutcome', 'desired_outcome', 'deepWhy', 'deep_why']
  },
  {
    id: 'obstacle',
    label: "lead's main obstacle (specific, not a one-word answer)",
    stepNumber: 12,
    acceptableKeys: ['obstacle', 'early_obstacle', 'earlyObstacle']
  },
  {
    id: 'belief_break_delivered',
    label: 'belief-break / reframe message delivered (Step 13)',
    stepNumber: 13,
    acceptableKeys: ['beliefBreakDelivered', 'belief_break_delivered']
  },
  {
    id: 'buy_in_confirmed',
    label: 'buy-in confirmed (Step 14 — clear yes to the reframe)',
    stepNumber: 14,
    acceptableKeys: ['buyInConfirmed', 'buy_in_confirmed']
  }
];

/**
 * Returns the prereqs (in script-step order) that have NO captured
 * value yet. Empty array means all prereqs are satisfied and call
 * proposal is allowed.
 */
export function checkCallProposalPrereqs(
  points: Record<string, unknown> | null | undefined,
  evidence?: { incomeGoalAsked?: boolean }
): CallProposalPrereq[] {
  return CALL_PROPOSAL_PREREQS.filter(
    (prereq) => !prereqSatisfiedByCapturedState(points, prereq, evidence)
  );
}

// ---------------------------------------------------------------------------
// Call-proposal attempt detection
// ---------------------------------------------------------------------------

/**
 * Heuristic detection that the AI's reply is attempting to propose a
 * call (Step 16 / Step 17). Used by the gate to know when to apply the
 * prereq check. Conservative: false-negative is preferred (let
 * legitimate proposals through after prereqs are met) over false-
 * positive (gate blocking unrelated language).
 */
const CALL_PROPOSAL_PATTERNS: RegExp[] = [
  // "set up a (quick) call/chat/time with..." — matches the daetradez
  // Step 16 default branch ("set up a time with my right hand guy Anthony").
  /\bset\s+up\s+a\s+(quick\s+)?(call|chat|convo|conversation|zoom|time)\b/i,
  // "hop on / jump on / get on a (quick) call/chat" and the simpler
  // "book(ing) / schedule a call/chat".
  /\b(book(ing)?|schedule|hop(ping)?\s*on|jump(ing)?\s*on|get\s*you\s*on|get\s*on)\s+a?\s*(quick\s+)?(call|chat|convo|conversation|zoom)\b/i,
  // Bare "quick call / 15-min chat" anywhere in the message.
  /\b(quick|15[\s-]?min(ute)?)\s+(call|chat|convo)\b/i,
  // "call/chat with my right-hand / Anthony" — direct closer mentions.
  /\b(call|chat|time)\s+with\s+(my\s+(right.?hand|partner|head\s+coach|business\s+partner|closer)|anthony)\b/i,
  // Closer-handoff phrases that don't include "call" but clearly route
  // toward the booking handoff. Covers Step 16 ("set up a time with my
  // right hand guy Anthony to break down a roadmap"), Step 20 ("locked
  // in with my head coach Anthony"), and the Step 16-alt branch
  // ("set you up with my right hand guy").
  /\bset\s+(you\s+)?up\s+(a\s+time\s+)?with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i,
  /\blocked\s+in\s+with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i,
  // Typeform / booking-link delivery is the scheduling trigger.
  /\b(typeform|booking\s+link|application\s+link)\b/i
];

export function detectCallProposalAttempt(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  return CALL_PROPOSAL_PATTERNS.some((p) => p.test(reply));
}

// ---------------------------------------------------------------------------
// Belief-break detection
// ---------------------------------------------------------------------------
// Step 13 (belief break / reframe) is critical to the daetradez script's
// authority shift. Two distinct messages signal it landed:
//   (a) Psychology / Discipline branch: "99% of traders ... actually
//       don't know what the real problem is" plus the systems-vs-
//       discipline reframe.
//   (b) Beginner branch: "Brother that's totally normal ... you're not
//       carrying all the bad habits..."
// We watch the AI's emitted history and require the full multi-message
// belief break to land before capturedDataPoints.beliefBreakDelivered
// reaches "complete". A single "99% of traders" opener is only bubble1.

const BELIEF_BREAK_TRIGGER_PATTERNS: RegExp[] = [
  // Psychology/Discipline branch
  /\b99%\s+of\s+traders\b/i,
  /\bdon'?t\s+know\s+what\s+the\s+real\s+problem\s+is\b/i,
  /\bdiscipline\s+takes\s+time\s+to\s+build\b/i,
  /\bsystems?\s+you\s+have\s+in\s+place\b/i,
  // Beginner / Overwhelmed branch
  /\bthat'?s\s+totally\s+normal\b.{0,80}\b(bad\s+habits|first\s+step)\b/i,
  /\bnot\s+carrying\s+all\s+the\s+bad\s+habits\b/i,
  /\bgood\s+spot\s+to\s+be\s+in\s+because\b/i
];

export function detectBeliefBreakInMessage(message: string): boolean {
  if (!message || typeof message !== 'string') return false;
  return BELIEF_BREAK_TRIGGER_PATTERNS.some((p) => p.test(message));
}

export function detectBeliefBreakDelivered(
  aiMessages: Array<{ content: string | null | undefined }>
): boolean {
  if (!Array.isArray(aiMessages)) return false;
  for (const m of aiMessages) {
    if (
      typeof m?.content === 'string' &&
      detectBeliefBreakInMessage(m.content)
    ) {
      return true;
    }
  }
  return false;
}

export type BeliefBreakDeliveryStage = 'bubble1' | 'bubble2' | 'complete';

const BELIEF_BREAK_BUBBLE_1 = /\b99%\s+of\s+traders\b/i;
const BELIEF_BREAK_BUBBLE_2 =
  /\bdiscipline\s+takes\s+time\s+to\s+build\b|\bperson\s+behind\s+them\b/i;
const BELIEF_BREAK_BUBBLE_3 =
  /\bwhat'?s\s+really\s+the\s+bottleneck\b|\bsystems?\s+you\s+have\s+in\s+place\b/i;
const BELIEF_BREAK_FINAL_ASK =
  /\bwhat\s+would\s+that\s+do\s+for\s+your\s+trading\b|\bwhat\s+would\s+that\s+do\b/i;

export function detectBeliefBreakDeliveryStage(
  aiMessages: Array<{ content: string | null | undefined }>
): BeliefBreakDeliveryStage | null {
  if (!Array.isArray(aiMessages)) return null;
  const joined = aiMessages
    .map((m) => m.content || '')
    .join('\n')
    .toLowerCase();
  if (!BELIEF_BREAK_BUBBLE_1.test(joined)) return null;
  if (!BELIEF_BREAK_BUBBLE_2.test(joined)) return 'bubble1';
  if (!BELIEF_BREAK_BUBBLE_3.test(joined)) return 'bubble2';
  return BELIEF_BREAK_FINAL_ASK.test(joined) ? 'complete' : 'bubble2';
}

// ---------------------------------------------------------------------------
// Current-step scoping
// ---------------------------------------------------------------------------

/**
 * Compact step shape the serializer + ai-engine pass into the prompt
 * builder. Keeps script-serializer.ts decoupled from Prisma types.
 */
export interface CompactScriptAction {
  actionType: string;
  content?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  waitDuration?: number | null;
}

export interface CompactScriptBranch {
  branchLabel: string;
  conditionDescription?: string | null;
  actions: CompactScriptAction[];
}

export interface CompactScriptStep {
  stepNumber: number;
  title: string;
  objective?: string | null;
  canonicalQuestion?: string | null;
  directActions: CompactScriptAction[];
  branches: CompactScriptBranch[];
}

const ACTION_TAG: Record<string, string> = {
  send_message: 'MSG',
  ask_question: 'ASK',
  send_voice_note: 'VOICE NOTE',
  send_link: 'LINK',
  send_video: 'VIDEO',
  form_reference: 'FORM',
  runtime_judgment: 'JUDGE',
  wait_for_response: 'WAIT',
  wait_duration: 'WAIT'
};

function formatCompactAction(
  action: CompactScriptAction,
  context?: { previousAction?: CompactScriptAction | null }
): string {
  const tag = ACTION_TAG[action.actionType] || action.actionType.toUpperCase();
  switch (action.actionType) {
    case 'send_message':
      if (isRuntimePlaceholderOnly(action.content)) {
        const directive = (action.content || '').replace(
          /^\s*\{\{\s*|\s*\}\}\s*$/g,
          ''
        );
        return `[${tag}] RUNTIME MESSAGE DIRECTIVE (do NOT output the braces or directive text literally): ${directive}. Write a natural message that satisfies this instruction using the lead's context. If the directive explicitly says to add/include/use an exact quoted phrase, include that phrase exactly.`;
      }
      if (/\{\{[^}]+\}\}/.test(action.content || '')) {
        return `[${tag}] REQUIRED MESSAGE (send exact wording; substitute variables from lead context; do not output braces or placeholder text; do not paraphrase non-variable words): ${action.content || '(empty)'}`;
      }
      return `[${tag}] REQUIRED MESSAGE (send verbatim, do not paraphrase or reorder): ${action.content || '(empty)'}`;
    case 'ask_question':
      const sameReplyPrefix =
        context?.previousAction?.actionType === 'send_message'
          ? 'ask immediately after the preceding [MSG], in the same reply; '
          : '';
      if (/\{\{[^}]+\}\}/.test(action.content || '')) {
        return `[${tag}] REQUIRED QUESTION (${sameReplyPrefix}use this exact question, substituting the variable with what the lead actually said): ${action.content || '(empty)'}`;
      }
      return `[${tag}] REQUIRED QUESTION (${sameReplyPrefix}use this exact wording): ${action.content || '(empty)'}`;
    case 'runtime_judgment':
      return `[${tag}] ${action.content || 'Use your judgment'}`;
    case 'send_link':
    case 'send_video':
      if (action.linkUrl) {
        return `[${tag}] REQUIRED LINK: Send this URL: ${action.linkUrl}. Do not alter, shorten, or paraphrase this URL.`;
      }
      return `[${tag}] ${action.content || '(URL not yet configured)'}`;
    case 'wait_for_response':
      return `[${tag}] Wait for response`;
    case 'wait_duration':
      return `[${tag}] PAUSE: Send the previous message as its own bubble, wait ${action.waitDuration ?? 0} seconds, then continue to the next message.`;
    default:
      return `[${tag}] ${action.content || ''}`;
  }
}

function formatCompactActions(
  actions: CompactScriptAction[],
  indent: string
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const previousAction = actions[i - 1] || null;
    const nextAction = actions[i + 1] || null;

    if (
      action.actionType === 'send_message' &&
      nextAction?.actionType === 'ask_question'
    ) {
      lines.push(
        `${indent}[TURN] REQUIRED SAME-REPLY SEQUENCE: No [WAIT] appears between this [MSG] and [ASK], so send both in the same reply. Use the [MSG] as the opening and the [ASK] as the closing question.`
      );
    }

    lines.push(`${indent}${formatCompactAction(action, { previousAction })}`);
  }
  return lines;
}

function renderStepLines(step: CompactScriptStep, indent = '  '): string[] {
  const lines: string[] = [];
  lines.push(`${indent}Step ${step.stepNumber}: ${step.title}`);
  if (step.objective && step.objective.trim().length > 0) {
    lines.push(`${indent}Objective: ${step.objective.trim()}`);
  }
  if (step.canonicalQuestion && step.canonicalQuestion.trim().length > 0) {
    lines.push(`${indent}Canonical question: ${step.canonicalQuestion.trim()}`);
  }
  if (step.directActions.length > 0) {
    lines.push(...formatCompactActions(step.directActions, `${indent}  `));
  }
  for (const branch of step.branches) {
    const cond = branch.conditionDescription
      ? ` (${branch.conditionDescription})`
      : '';
    lines.push(`${indent}  IF ${branch.branchLabel}${cond}:`);
    lines.push(...formatCompactActions(branch.actions, `${indent}    `));
  }
  return lines;
}

/**
 * Renders the focused step block: CURRENT + NEXT only. Replaces the
 * legacy "all 22 steps" dump that lets the LLM pattern-match its way
 * to step 16. Returns null when there's nothing to show.
 */
export function buildCurrentStepBlock(
  currentStep: CompactScriptStep | null,
  nextStep: CompactScriptStep | null
): string | null {
  if (!currentStep && !nextStep) return null;

  const parts: string[] = [
    '## Script Framework — CURRENT STEP ONLY',
    '',
    "You are working through a multi-step qualification script. Below is your CURRENT step and a brief preview of the NEXT step. Subsequent steps are intentionally hidden — DO NOT improvise your way to a later stage of the script. Complete the current step, wait for the lead's reply, then advance to the next step on the next turn.",
    '',
    'IMPORTANT: When a [MSG] action has explicit content, use that content verbatim or near-verbatim — do not paraphrase into a different shape. When [ASK] has explicit content, use that exact question (light wording adjustments OK to match flow). A [WAIT] action is what separates turns. If [MSG] is followed immediately by [ASK] with no [WAIT] between them, send BOTH in the same reply: [MSG] as the opening and [ASK] as the closing question. Do not skip a step\'s [JUDGE], [MSG], or [ASK] just because the lead\'s last message could "pattern-match" a later stage.',
    ''
  ];

  if (currentStep) {
    parts.push('CURRENT STEP:');
    parts.push(...renderStepLines(currentStep, '  '));
  }

  if (nextStep) {
    parts.push('');
    parts.push(
      "NEXT STEP (preview — fire only AFTER current step's [WAIT] resolves):"
    );
    parts.push(...renderStepLines(nextStep, '  '));
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Silent-branch enforcement (Step 4 "Obstacle given — detailed and emotional"
// pattern)
// ---------------------------------------------------------------------------
// Some script branches end with [MSG] + [WAIT] and have NO [ASK]. The
// operator's intent is "acknowledge what the lead just shared and SIT IN
// THE MOMENT — the lead will keep talking on their own". When the AI
// improvises a follow-up question on those branches, it kills the
// emotional disclosure mid-flight (@daniel_elumelu Turn 2/3 incident
// 2026-05-08). The helpers below let the gate detect:
//
//   1. The current step contains at least one branch shaped like
//      [MSG] + [WAIT] with no [ASK] (a "silent branch").
//   2. The list of scripted [ASK] question texts across all branches in
//      the current step — used to flag improvised off-script questions.
// ---------------------------------------------------------------------------

export interface StepActionShape {
  /**
   * True when at least one branch in the step has [MSG]/[WAIT] actions
   * but NO [ASK] action. Operator's intent on that branch is "send the
   * acknowledgment, end on a statement, do not append a question".
   */
  hasSilentBranch: boolean;
  /**
   * True when at least one branch in the step has any [ASK] action.
   * Used to relax the no-question rule when the step does want a
   * question on the branch the LLM is taking.
   */
  hasAnyAskAction: boolean;
  /** Concatenated [ASK] content strings across branches (for off-script comparison). */
  scriptedQuestionContents: string[];
  /** Direct current-step [MSG] contents that must be sent verbatim. */
  requiredMessageContents: string[];
  /** Branch labels that are silent (for prompt directive + audit log). */
  silentBranchLabels: string[];
}

interface MinimalStep {
  stepNumber: number;
  actions: Array<{
    actionType: string;
    content?: string | null;
  }>;
  branches: Array<{
    branchLabel: string;
    actions: Array<{
      actionType: string;
      content?: string | null;
    }>;
  }>;
}

export function isRuntimePlaceholderOnly(content: string | null | undefined) {
  return (
    typeof content === 'string' && /^\s*\{\{[\s\S]+?\}\}\s*$/.test(content)
  );
}

/**
 * Pure-data: derives the action shape for a given step number. Pass an
 * already-loaded script (from script-serializer's query) so this stays
 * synchronous and DB-free.
 */
export function getStepActionShape(
  script: { steps: MinimalStep[] } | null,
  stepNumber: number
): StepActionShape | null {
  if (!script) return null;
  const step = script.steps.find((s) => s.stepNumber === stepNumber);
  if (!step) return null;

  const allBranches: Array<{
    label: string;
    actions: Array<{ actionType: string; content?: string | null }>;
  }> = [];
  if (step.actions.length > 0) {
    allBranches.push({ label: '__direct__', actions: step.actions });
  }
  for (const branch of step.branches) {
    allBranches.push({ label: branch.branchLabel, actions: branch.actions });
  }

  const silentBranchLabels: string[] = [];
  const scriptedQuestionContents: string[] = [];
  const requiredMessageContents: string[] = [];
  let hasAnyAskAction = false;

  const allStepActions = collectAllStepActions(step);

  for (const action of allStepActions) {
    if (
      action.actionType === 'send_message' &&
      typeof action.content === 'string' &&
      action.content.trim().length > 0 &&
      !isRuntimePlaceholderOnly(action.content)
    ) {
      requiredMessageContents.push(action.content.trim());
    }
  }

  for (const branch of allBranches) {
    const askActions = branch.actions.filter(
      (a) => a.actionType === 'ask_question'
    );
    const msgActions = branch.actions.filter(
      (a) => a.actionType === 'send_message'
    );
    const waitActions = branch.actions.filter(
      (a) => a.actionType === 'wait_for_response'
    );
    if (askActions.length > 0) {
      hasAnyAskAction = true;
      for (const a of askActions) {
        if (typeof a.content === 'string' && a.content.trim().length > 0) {
          scriptedQuestionContents.push(a.content.trim());
        }
      }
    } else if (
      msgActions.length > 0 &&
      waitActions.length > 0 &&
      branch.label !== '__direct__'
    ) {
      // Silent branch: operator wrote acknowledgment + wait, no question.
      silentBranchLabels.push(branch.label);
    }
  }

  return {
    hasSilentBranch: silentBranchLabels.length > 0,
    hasAnyAskAction,
    scriptedQuestionContents,
    requiredMessageContents,
    silentBranchLabels
  };
}

export function collectAllStepActions(
  step: MinimalStep | null | undefined
): Array<{ actionType: string; content?: string | null }> {
  if (!step) return [];
  const actions: Array<{ actionType: string; content?: string | null }> = [];
  actions.push(...(step.actions ?? []));
  for (const branch of step.branches ?? []) {
    actions.push(...(branch.actions ?? []));
  }
  return actions;
}

export function countConversationTurns(
  messages: Array<{ sender: string | null | undefined }>
): number {
  let turns = 0;
  for (const msg of messages) {
    if (msg.sender === 'LEAD') turns++;
  }
  return turns;
}

// ---------------------------------------------------------------------------
// Step-10 (Deep Why) enforcement
// ---------------------------------------------------------------------------
// Step 10 — "Desired Outcome — Deep Why" — captures the lead's emotional
// reason behind their income goal. Without this, the call proposal lands
// without a hook AND the script's belief-break + soft-pitch beats lose
// their leverage. Production drift (@tegaumukoro_ 2026-05-08): AI was
// jumping from Step 9 (income goal captured) directly to Step 12
// (obstacle identification) because the LLM picked up Step 12's
// "if obstacle already stored → skip to Step 13" rule and conflated
// the early_obstacle (captured at Step 2) with the deliberate Step 12
// obstacle ask.
//
// The detector + gate below force Step 10 to fire BEFORE any Step 12+
// content is allowed once incomeGoal is captured.

/**
 * Phrases that signal the AI is trying to advance past Step 10.
 *   - obstacle re-ask shapes (Step 12)
 *   - belief-break / reframe openers (Step 13)
 *   - buy-in confirmation language (Step 14)
 *   - urgency ask (Step 15)
 *   - call-proposal language (Step 16) — also covered by
 *     detectCallProposalAttempt; included here for completeness.
 */
const STEP_12_PLUS_PATTERNS: RegExp[] = [
  // Step 12: explicit obstacle re-ask
  /\bwhat\s+(do\s+you\s+feel|would\s+you\s+say)\s+is\s+(the\s+)?main\s+(thing|obstacle)\s+holding\s+you\s+back\b/i,
  /\bmain\s+(thing|obstacle)\s+(stopping|holding)\s+you\b/i,
  // Step 13: belief-break openers
  /\b99%\s+of\s+traders\b/i,
  /\bdon'?t\s+know\s+what\s+the\s+real\s+problem\s+is\b/i,
  /\bsystems?\s+you\s+have\s+in\s+place\b/i,
  /\bthat'?s\s+totally\s+normal\b.{0,80}\bbad\s+habits\b/i,
  // Step 14: buy-in confirmation phrasing
  /\bwould\s+(that|having)\s+(kind\s+of\s+)?(structure|system|guidance)\s+(help|change)\b/i,
  // Step 15: urgency ask shapes
  /\bis\s+now\s+the\s+time\s+to\s+(actually\s+)?overcome\b/i
];

export function detectStep12PlusContent(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  if (STEP_12_PLUS_PATTERNS.some((p) => p.test(reply))) return true;
  // Step 16 call-proposal language is its own category but also blocks
  // Step 10 when fired prematurely.
  return detectCallProposalAttempt(reply);
}

/**
 * Returns true when the AI's reply attempts to advance past Step 10
 * but the lead's emotional why has not been captured. Combined check:
 *   - reply contains Step 12+ shaped content
 *   - capturedDataPoints has incomeGoal (Step 9 done)
 *   - capturedDataPoints does NOT have deepWhy / desiredOutcome (Step 10 skipped)
 */
export function detectStep10Skipped(
  reply: string,
  capturedDataPoints: Record<string, unknown> | null | undefined
): boolean {
  if (!detectStep12PlusContent(reply)) return false;
  const incomeGoalPresent = incomeGoalSatisfiedByExpectedStep(
    capturedDataPoints,
    9
  );
  if (!incomeGoalPresent) return false;
  const deepWhyPresent =
    hasCapturedDataPoint(capturedDataPoints, 'deepWhy') ||
    hasCapturedDataPoint(capturedDataPoints, 'deep_why') ||
    hasCapturedDataPoint(capturedDataPoints, 'desiredOutcome') ||
    hasCapturedDataPoint(capturedDataPoints, 'desired_outcome') ||
    deepWhySatisfiedByBranchHistory(capturedDataPoints);
  return !deepWhyPresent;
}

// ---------------------------------------------------------------------------
// Mandatory-ask enforcement (unsafe skip guard)
// ---------------------------------------------------------------------------
// These checks block unsafe jumps where the LLM skips Step 6/7/8 only
// because capturedDataPoints happen to contain values. Durable recovery
// can now also write a step_completed branchHistory event when the lead
// volunteered the exact data in the same reply that completed a prior
// step. That ledger entry is treated as satisfying the requirement.

export interface MandatoryAskRequirement {
  stepNumber: number;
  /** Human label for the regen directive. */
  label: string;
  /**
   * Phrase fragments that signal the [ASK] for this step fired in AI
   * history. Each fragment is treated as a regex (with `.{0,N}` etc.
   * supported) and falls back to plain substring match if regex parse
   * fails. ANY fragment matching ANY AI message satisfies the check.
   */
  askPhraseFragments: string[];
  /**
   * Optional skip-key list. If any of these capturedDataPoints keys is
   * present (and truthy), the requirement is treated as satisfied even
   * if the [ASK] hasn't fired. Used for explicit judge-condition skips
   * (e.g. Step 7's "skip if job makes it obvious they earn well" sets
   * monthlyIncomeSkipped=true).
   */
  judgeSkipKeys?: string[];
}

/**
 * Steps whose [ASK] must fire before Step 9+ content is allowed. These
 * are the discovery steps the operator script asks about the lead's job
 * situation — they get skipped most often when the lead volunteers
 * info inline with another answer.
 */
export const MANDATORY_ASK_STEPS: MandatoryAskRequirement[] = [
  {
    stepNumber: 6,
    label: 'Step 6 (Job Acknowledgment) — "How long you been doing that?"',
    askPhraseFragments: [
      'how long you been',
      'how long have you been',
      "how long\\s+(have\\s+)?you'?ve\\s+been"
    ]
  },
  {
    stepNumber: 7,
    label:
      'Step 7 (Monthly Income) — "How much is your job bringing in monthly?"',
    askPhraseFragments: [
      'how much is your job',
      'bringing in on a monthly',
      'on a monthly basis',
      'how much\\b.{0,20}\\bmonth(ly)?\\b',
      'what.{0,15}you make.{0,10}month',
      'monthly income'
    ],
    judgeSkipKeys: ['monthlyIncomeSkipped', 'monthly_income_skipped']
  },
  {
    stepNumber: 8,
    label: 'Step 8 (Replace vs Supplement) — "Replace your job or supplement?"',
    askPhraseFragments: [
      'replacing your job',
      'replacing your job completely',
      'replace your job',
      'replace.*job.*trading',
      'replace.{0,15}completely with trading',
      'extra income on the side',
      'supplement.*income',
      'supplement',
      'replace.*completely.*trading',
      'replace.{0,30}\\bor\\b.{0,30}\\bextra\\b'
    ]
  }
];

/**
 * Returns true if ANY AI message in history matches ANY of the phrase
 * fragments. Each fragment is tried as a regex first (supports
 * `.{0,N}` quantifier syntax), falling back to case-insensitive
 * substring match.
 */
export function detectAskFiredInHistory(
  aiMessages: Array<{ content: string | null | undefined } | string>,
  fragments: string[]
): boolean {
  const messages: string[] = aiMessages
    .map((m) => (typeof m === 'string' ? m : (m?.content ?? '')))
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  for (const msg of messages) {
    const lower = msg.toLowerCase();
    for (const fragment of fragments) {
      try {
        const re = new RegExp(fragment, 'i');
        if (re.test(msg)) return true;
      } catch {
        if (lower.includes(fragment.toLowerCase())) return true;
      }
    }
  }
  return false;
}

/**
 * Returns the mandatory-ask requirements (in step order) that have NOT
 * fired in AI history AND have not been explicitly skipped via
 * judgeSkipKeys in capturedDataPoints. Empty array means all required
 * asks have fired.
 */
export function checkMandatoryAsksFired(
  aiMessages: Array<{ content: string | null | undefined } | string>,
  capturedDataPoints: Record<string, unknown> | null | undefined
): MandatoryAskRequirement[] {
  return MANDATORY_ASK_STEPS.filter((req) => {
    if (detectAskFiredInHistory(aiMessages, req.askPhraseFragments)) {
      return false;
    }
    if (stepCompletedByBranchHistory(capturedDataPoints, req.stepNumber)) {
      return false;
    }
    if (req.judgeSkipKeys && req.judgeSkipKeys.length > 0) {
      const skipped = req.judgeSkipKeys.some((k) =>
        hasCapturedDataPoint(capturedDataPoints, k)
      );
      if (skipped) return false;
    }
    return true;
  });
}

/**
 * Returns the missing mandatory-ask requirements when the AI's reply
 * is generating Step 9+ content but Steps 6/7/8 [ASK]s haven't fired.
 * Returns null when the reply doesn't infer Step 9+ content (gate is
 * inactive in early discovery).
 *
 * Step 9 income-goal-from-trading question has distinctive phrasings:
 *   - "how much would you need to be making"
 *   - "how much money are you trying to make with trading"
 *   - "how much.*from trading"
 *   - "monthly basis" combined with "trading"
 */
const STEP_9_PATTERNS: RegExp[] = [
  /\bhow\s+much\s+(would|do)\s+you\s+(need|want)\s+to\s+be\s+making\b/i,
  /\bhow\s+much\s+(money)?\s*(are\s+you|do\s+you)\s+(trying|wanting|hoping)\s+to\s+make\b.{0,40}\b(trading|markets?)\b/i,
  /\bhow\s+much.{0,40}\b(from\s+trading|from\s+the\s+markets?)\b/i,
  /\bmake\s+from\s+trading\b/i,
  /\b(income|target|goal)\s+from\s+trading\b/i
];

function detectStep9OrLaterContent(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  if (STEP_9_PATTERNS.some((p) => p.test(reply))) return true;
  // Step 12+ patterns also imply we're past Step 8.
  if (detectStep12PlusContent(reply)) return true;
  // Capital question = Step 18 = past 8.
  if (detectCapitalQuestionAttempt(reply)) return true;
  return false;
}

export function detectMandatoryAskSkipped(
  reply: string,
  aiMessages: Array<{ content: string | null | undefined } | string>,
  capturedDataPoints: Record<string, unknown> | null | undefined
): MandatoryAskRequirement[] | null {
  if (!detectStep9OrLaterContent(reply)) return null;
  const missing = checkMandatoryAsksFired(aiMessages, capturedDataPoints);
  return missing.length > 0 ? missing : null;
}

// ---------------------------------------------------------------------------
// Capital-question premature detection (Step 18 skip guard)
// ---------------------------------------------------------------------------
// Capital question is the daetradez script's Step 18 ("Qualification — DQ
// Check"). It MUST NOT fire during discovery — the prereq chain is:
//   deepWhy / desiredOutcome captured (Step 10)
//   obstacle / early_obstacle captured (Step 12)
//   beliefBreakDelivered = true (Step 13)
//   buyInConfirmed = true (Step 14)
//   callInterestConfirmed / callProposalAccepted = true (Step 17 "Yes")
//
// Production drift (@tegaumukoro_ 2026-05-08, third skip incident today):
// AI fired "real quick, what's your capital situation like for the markets
// right now?" right after the lead's deep-why answer — Step 9 → Step 18
// directly, skipping 9 steps. Earlier fixes only caught Step 12+ patterns
// (Step 10 gate) but capital-question phrasing is a distinct shape that
// the obstacle / belief-break / buy-in regex set didn't cover.

const CAPITAL_QUESTION_PATTERNS: RegExp[] = [
  /\bcapital\s+situation\b/i,
  /\bwhat'?s\s+your\s+capital\b/i,
  /\bhow\s+much\s+(do\s+you\s+have\s+)?(set\s+aside|saved|put\s+aside)\b/i,
  /\bcapital.{0,20}\b(markets|trading|invest|started?)\b/i,
  /\bhow\s+much\s+(capital|money|funds?)\s+(do\s+you\s+have|you\s+working\s+with|are\s+you\s+working\s+with)\b/i,
  /\bwhat\s+(amount|level)\s+of\s+capital\b/i,
  // "budget" used in any investment/start-up context. Catches "what
  // budget can you put toward", "budget for getting started", "budget
  // to invest", etc.
  /\bbudget\b.{0,40}\b(put\s+toward|get\s+started|invest|trade|allocat|spare)\b/i,
  /\b(what'?s|how\s+much\s+is)\s+your\s+budget\b/i,
  /\bhow\s+much\s+can\s+you\s+(invest|put\s+(in|toward)|afford|spend)\b/i
];

export function detectCapitalQuestionAttempt(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  return CAPITAL_QUESTION_PATTERNS.some((p) => p.test(reply));
}

/**
 * Capital-question prerequisites (Step 18). Mirrors call-proposal prereqs
 * but adds the call-acceptance signal — capital can only be asked AFTER
 * the lead has affirmed the call proposal.
 */
export interface CapitalQuestionPrereq {
  id: string;
  label: string;
  stepNumber: number;
  acceptableKeys: string[];
}

export const CAPITAL_QUESTION_PREREQS: CapitalQuestionPrereq[] = [
  {
    id: 'desired_outcome_or_deep_why',
    label: "lead's deeper why / desired outcome (Step 10)",
    stepNumber: 10,
    acceptableKeys: ['desiredOutcome', 'desired_outcome', 'deepWhy', 'deep_why']
  },
  {
    id: 'obstacle',
    label: "lead's main obstacle (Step 12 — specific, not surface)",
    stepNumber: 12,
    acceptableKeys: ['obstacle', 'early_obstacle', 'earlyObstacle']
  },
  {
    id: 'belief_break_delivered',
    label: 'belief-break / reframe message delivered (Step 13)',
    stepNumber: 13,
    acceptableKeys: ['beliefBreakDelivered', 'belief_break_delivered']
  },
  {
    id: 'buy_in_confirmed',
    label: 'buy-in confirmed (Step 14)',
    stepNumber: 14,
    acceptableKeys: ['buyInConfirmed', 'buy_in_confirmed']
  },
  {
    id: 'call_proposal_accepted',
    label: 'call proposal accepted by the lead (Step 17 "Yes" branch)',
    stepNumber: 17,
    acceptableKeys: [
      'callInterestConfirmed',
      'call_interest_confirmed',
      'callProposalAccepted',
      'call_proposal_accepted'
    ]
  }
];

export function checkCapitalQuestionPrereqs(
  points: Record<string, unknown> | null | undefined
): CapitalQuestionPrereq[] {
  return CAPITAL_QUESTION_PREREQS.filter(
    (prereq) => !prereqSatisfiedByCapturedState(points, prereq)
  );
}

/**
 * Returns true when the AI's reply contains a capital-question shape
 * AND any of the five Step 18 prereqs is missing. Combines the pattern
 * detector with the prereq check so the gate can hard-fail in one
 * call.
 */
export function detectCapitalQuestionPremature(
  reply: string,
  capturedDataPoints: Record<string, unknown> | null | undefined
): boolean {
  if (!detectCapitalQuestionAttempt(reply)) return false;
  return checkCapitalQuestionPrereqs(capturedDataPoints).length > 0;
}

// ---------------------------------------------------------------------------
// Step-distance violation (architectural skip guard)
// ---------------------------------------------------------------------------
// Three distinct skips caught today (Step 10, Step 12, Step 18) prove the
// LLM will keep finding new ways to jump ahead. Rather than enumerate
// every future-step pattern, this generic check maps the reply's content
// to the highest matching step number and hard-fails when that step is
// MORE THAN 3 ahead of the AI's actual current step. Architectural fix —
// catches all skip attempts regardless of which specific shape the LLM
// improvises.

interface StepPatternMapping {
  stepNumber: number;
  patterns: RegExp[];
  /** Human label for the regen directive. */
  label: string;
}

/**
 * Patterns that signal a reply belongs to a specific script step. A
 * single reply may match multiple — inferStepFromReply returns the
 * HIGHEST matching step number so a Step 18 capital question doesn't
 * get masked by an earlier-step phrase coincidence.
 *
 * Add new patterns here when a new skip class is identified.
 */
const STEP_PATTERN_MAP: StepPatternMapping[] = [
  {
    stepNumber: 9,
    label: 'Step 9 — Income Goal from Trading',
    patterns: [
      /\bhow\s+much\s+(would|do)\s+you\s+(need|want)\s+to\s+be\s+making\b/i,
      /\bhow\s+much\s+(money)?\s*(are\s+you|do\s+you)\s+(trying|wanting|hoping)\s+to\s+make\b.{0,40}\b(trading|markets?)\b/i,
      /\bhow\s+much.{0,40}\b(from\s+trading|from\s+the\s+markets?)\b/i,
      /\bmake\s+from\s+trading\b/i,
      /\b(income|target|goal)\s+from\s+trading\b/i
    ]
  },
  {
    stepNumber: 10,
    label: 'Step 10 — Deep Why',
    patterns: [
      /\bwhy\s+is\s+(.{0,60}?)\s+(so\s+)?important\s+to\s+you\b/i,
      /\bwhat'?s\s+(it|that)\s+about\s+(.{0,40}?)\s+that\s+(matters|drives|pushes)\b/i
    ]
  },
  {
    stepNumber: 12,
    label: 'Step 12 — Obstacle Identification',
    patterns: [
      /\bwhat\s+(do\s+you\s+feel|would\s+you\s+say)\s+is\s+(the\s+)?main\s+(thing|obstacle)\s+holding\s+you\s+back\b/i,
      /\bmain\s+(thing|obstacle)\s+(stopping|holding)\s+you\b/i
    ]
  },
  {
    stepNumber: 13,
    label: 'Step 13 — Belief Break',
    patterns: [
      /\b99%\s+of\s+traders\b/i,
      /\bdon'?t\s+know\s+what\s+the\s+real\s+problem\s+is\b/i,
      /\bsystems?\s+you\s+have\s+in\s+place\b/i,
      /\bthat'?s\s+totally\s+normal\b.{0,80}\bbad\s+habits\b/i
    ]
  },
  {
    stepNumber: 14,
    label: 'Step 14 — Buy-In Confirmation',
    patterns: [
      /\bwould\s+(that|having)\s+(kind\s+of\s+)?(structure|system|guidance)\s+(help|change)\b/i
    ]
  },
  {
    stepNumber: 15,
    label: 'Step 15 — Urgency',
    patterns: [/\bis\s+now\s+the\s+time\s+to\s+(actually\s+)?overcome\b/i]
  },
  {
    stepNumber: 16,
    label: 'Step 16 — Call Proposal',
    patterns: [
      /\bset\s+up\s+a\s+(quick\s+)?(call|chat|convo|conversation|zoom|time)\b/i,
      /\b(book(ing)?|schedule|hop(ping)?\s*on|jump(ing)?\s*on|get\s*you\s*on|get\s*on)\s+a?\s*(quick\s+)?(call|chat|convo|conversation|zoom)\b/i,
      /\b(call|chat|time)\s+with\s+(my\s+(right.?hand|partner|head\s+coach|business\s+partner|closer)|anthony)\b/i,
      /\bset\s+(you\s+)?up\s+(a\s+time\s+)?with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i
    ]
  },
  {
    stepNumber: 17,
    label: 'Step 17 — Booking Link',
    patterns: [
      /\b(typeform|booking\s+link|application\s+link)\b/i,
      /\blocked\s+in\s+with\s+(my\s+)?(right.?hand|head\s+coach|partner|anthony|closer)\b/i
    ]
  },
  {
    stepNumber: 18,
    label: 'Step 18 — Capital / DQ Check',
    patterns: CAPITAL_QUESTION_PATTERNS
  }
];

/**
 * Returns the highest step number whose patterns match the reply, or
 * null if no patterns match. Multi-match: a Step 18 capital question
 * always wins over an earlier-step coincidence.
 */
export function inferStepFromReply(reply: string): number | null {
  if (!reply || typeof reply !== 'string') return null;
  let highest: number | null = null;
  for (const mapping of STEP_PATTERN_MAP) {
    if (mapping.patterns.some((p) => p.test(reply))) {
      if (highest === null || mapping.stepNumber > highest) {
        highest = mapping.stepNumber;
      }
    }
  }
  return highest;
}

/**
 * Returns the matched step pattern label for the highest-step match,
 * or null. Used by the regen override to name the offending shape in
 * the directive.
 */
export function inferStepLabelFromReply(reply: string): string | null {
  if (!reply || typeof reply !== 'string') return null;
  let bestMapping: StepPatternMapping | null = null;
  for (const mapping of STEP_PATTERN_MAP) {
    if (mapping.patterns.some((p) => p.test(reply))) {
      if (!bestMapping || mapping.stepNumber > bestMapping.stepNumber) {
        bestMapping = mapping;
      }
    }
  }
  return bestMapping?.label ?? null;
}

/**
 * Detects when a reply's content jumps MORE THAN `maxLookahead` steps
 * past the AI's current step. Returns the inferred step (the offending
 * step number) when violated, or null otherwise.
 *
 * Default lookahead = 3 (current + next + buffer). Operator scripts
 * with multi-bubble [MSG] + [ASK] patterns may legitimately straddle
 * +1 or +2; a +3 or higher leap is always a skip.
 */
export function detectStepDistanceViolation(
  reply: string,
  currentStepNumber: number | null | undefined,
  maxLookahead = 3
): number | null {
  if (typeof currentStepNumber !== 'number' || currentStepNumber <= 0) {
    return null;
  }
  const inferred = inferStepFromReply(reply);
  if (inferred === null) return null;
  if (inferred > currentStepNumber + maxLookahead) return inferred;
  return null;
}

// ---------------------------------------------------------------------------
// Acknowledgment-opener detection
// ---------------------------------------------------------------------------
// When a reply starts with an emotional acknowledgment phrase AND the
// current step contains a silent branch, that's a strong signal the AI
// took the silent branch — but if the reply also contains a `?`, the
// AI is violating the operator's "sit in the moment" instruction.

const ACKNOWLEDGMENT_OPENER_PATTERNS: RegExp[] = [
  /^that'?s\s+(real|heavy|tough|deep|crazy|wild|a\s+lot)\b/i,
  /^(i\s+)?hear\s+you\b/i,
  /^(i\s+)?feel\s+you\b/i,
  /^respect\s+(that|you)\b/i,
  /^appreciate\s+(you|that)\b/i,
  /^damn\s+bro\b/i,
  /^that\s+takes\s+real\b/i,
  /^genuinely\s+(respect|appreciate|hear)\b/i,
  /^thank\s+you\s+for\s+(sharing|opening)\b/i,
  /^(makes\s+sense|gotcha)\b/i
];

export function detectAcknowledgmentOpener(reply: string): boolean {
  if (!reply || typeof reply !== 'string') return false;
  const trimmed = reply.trim();
  return ACKNOWLEDGMENT_OPENER_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Question detection helpers
// ---------------------------------------------------------------------------

export function countQuestionMarks(reply: string): number {
  if (!reply || typeof reply !== 'string') return 0;
  return (reply.match(/\?/g) || []).length;
}

export function containsQuestion(reply: string): boolean {
  return countQuestionMarks(reply) > 0;
}

// ---------------------------------------------------------------------------
// Off-script question detection (Jaccard word overlap)
// ---------------------------------------------------------------------------
// When the current step has scripted [ASK] content AND the AI emits a
// question, compare their word sets. Low overlap = AI is improvising a
// different question. Fires as a SOFT signal (not hard) to allow
// reasonable paraphrase while penalising inventing pain-future-pacing
// questions that aren't in the script anywhere.

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'does',
  'for',
  'from',
  'have',
  'has',
  'i',
  'if',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'with',
  'you',
  'your',
  'how',
  'why',
  'who',
  'which',
  'whose',
  'about',
  'after',
  'all',
  'any',
  'been',
  'being',
  'can',
  'could',
  'did',
  'down',
  'each',
  'few',
  'had',
  'he',
  'her',
  'here',
  'him',
  'his',
  'just',
  'like',
  'm',
  'more',
  'most',
  'no',
  'not',
  'now',
  'off',
  'one',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'some',
  'such',
  'than',
  'them',
  'then',
  'there',
  'these',
  'those',
  'through',
  'too',
  'up',
  'very',
  'will',
  'would',
  'bro',
  'man',
  'tho',
  'yeah',
  'yo'
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  setA.forEach((w) => {
    if (setB.has(w)) intersection++;
  });
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Returns the maximum Jaccard similarity between the reply's question
 * sentences and any scripted [ASK] content. Used to flag improvised
 * off-script questions when similarity is below a threshold (e.g. 0.2).
 */
export function maxQuestionSimilarityToScript(
  reply: string,
  scriptedQuestions: string[]
): number {
  if (scriptedQuestions.length === 0) return 1; // no script to compare against
  const replyQuestions = reply
    .split(/(?<=[.?!])\s+/)
    .filter((s) => s.includes('?'));
  if (replyQuestions.length === 0) return 1;
  let maxSim = 0;
  for (const replyQ of replyQuestions) {
    for (const scriptQ of scriptedQuestions) {
      const sim = jaccardSimilarity(replyQ, scriptQ);
      if (sim > maxSim) maxSim = sim;
    }
  }
  return maxSim;
}

/**
 * Returns the array index of the step that the AI should be working
 * on right now. Heuristic, robust to missing completionRule:
 *
 *   1. If the snapshot's currentScriptStep > 1 AND that step exists in
 *      the script, use it. (script-state-recovery is the source of
 *      truth when it has signal.)
 *   2. Else fall back to a floor: the AI message count (each scripted
 *      [ASK]+[WAIT] pair consumes one AI turn, so floor = AI turns
 *      sent so far + 1, capped at script length).
 *   3. Always at least 1 (Step 1).
 *
 * The result is a stepNumber, NOT a zero-indexed array index.
 */
export function inferCurrentStepNumber(params: {
  snapshotCurrentStep: number | null | undefined;
  totalSteps: number;
  aiMessageCount: number;
}): number {
  const { snapshotCurrentStep, totalSteps, aiMessageCount } = params;
  const lastStep = Math.max(1, totalSteps);
  const floor = Math.min(lastStep, Math.max(1, aiMessageCount + 1));
  if (
    typeof snapshotCurrentStep !== 'number' ||
    snapshotCurrentStep <= 0 ||
    snapshotCurrentStep > lastStep
  ) {
    return floor;
  }
  // Stale-snapshot guard (bug-26): with completionRule defaulting to
  // INCOMPLETE for parsed scripts, computeSystemStage returns Step 1
  // even when the AI has progressed several turns past it. When the
  // snapshot says Step 1 but AI turns have happened, trust the
  // AI-turn floor instead.
  if (snapshotCurrentStep === 1 && aiMessageCount >= 2) {
    return floor;
  }
  // Snapshot is trustworthy (> 1) — cap at AI-turn floor so a faulty
  // all-complete reading can't push the AI past where the conversation
  // has actually been.
  return Math.min(snapshotCurrentStep, floor);
}
