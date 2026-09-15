import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { containsCapitalQuestion } from '@/lib/voice-quality-gate';
import { callHaikuText } from '@/lib/haiku-text';
import {
  BOOKING_INFO_FIELD_NAMES,
  type BookingInfoFields,
  extractBookingInfoWithHaiku,
  hasAllBookingInfoFields,
  hasAnyBookingInfoField,
  isBookingInfoRequestText
} from '@/lib/booking-info-extractor';
import { removeInvalidScriptVariableResolutionKeys } from '@/lib/script-variable-resolver';
import { replyAnswersAsk } from '@/lib/answer-satisfaction';
import type { CallProposalPrereq } from '@/lib/script-step-progression';
import {
  canonicalCapturedDataPointKey,
  canonicalizeCapturedDataPointRecord,
  equivalentCapturedDataPointKeys
} from '@/lib/captured-data-keys';

export type DataPointConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type RecoveryPriority = 'HOT' | 'MEDIUM' | 'LOW';

export interface ScriptHistoryMessage {
  id?: string | null;
  suggestionId?: string | null;
  sender: string;
  content: string;
  timestamp: Date | string;
}

export interface CapturedDataPoint<T = unknown> {
  value: T;
  confidence: DataPointConfidence;
  extractedFromMessageId: string | null;
  extractionMethod: string;
  extractedAt: string;
  sourceFieldName?: string | null;
  sourceStepNumber?: number | null;
  sourceQuestion?: string | null;
}

export type CapturedDataPoints = Record<string, CapturedDataPoint | undefined>;

export interface BranchHistoryEvent {
  eventType:
    | 'branch_selected'
    | 'smart_mode_response'
    | 'step_completed'
    | 'conditional_skip_decision'
    | 'conditional_skip_warning';
  stepNumber: number;
  stepTitle: string | null;
  selectedBranchLabel: string | null;
  suggestionId: string | null;
  aiMessageId: string | null;
  aiMessageIds: string[];
  leadMessageId: string | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  stepCompletionAttempted?: boolean | null;
  stepCompletionReason?: string | null;
  previousSelectedBranch?: string | null;
  currentSelectedBranch?: string | null;
  selectedSuggestionId?: string | null;
  historyMessagesWithSelectedSuggestionId?: number | null;
  skipDestinationStepNumber?: number | null;
  skipDirective?: string | null;
  skipDecision?: 'skip' | 'continue' | null;
  skipReason?: string | null;
  skipError?: string | null;
  classifierModel?: string | null;
}

export type ScriptWithRecovery = Prisma.ScriptGetPayload<{
  include: {
    steps: {
      include: {
        actions: { include: { form: { include: { fields: true } } } };
        branches: {
          include: {
            actions: { include: { form: { include: { fields: true } } } };
          };
        };
      };
    };
  };
}>;

export type ScriptStepWithRecovery = ScriptWithRecovery['steps'][number];
export type ScriptBranchWithRecovery =
  ScriptStepWithRecovery['branches'][number];

type PersonaForRecovery = {
  minimumCapitalRequired: number | null;
  capitalVerificationPrompt: string | null;
  freeValueLink: string | null;
  downsellConfig: Prisma.JsonValue | null;
  promptConfig: Prisma.JsonValue | null;
};

export interface ScriptStateSnapshot {
  conversationId: string;
  leadId: string;
  script: ScriptWithRecovery | null;
  currentStep: ScriptStepWithRecovery | null;
  currentScriptStep: number;
  activeBranch: ScriptBranchWithRecovery | null;
  selectedBranchLabel: string | null;
  systemStage: string | null;
  capturedDataPoints: CapturedDataPoints;
  persona: PersonaForRecovery | null;
  reason: string;
  /** True when the position legitimately advanced more than one step this turn
   *  (the F5.1 1b "provable catch-up" path). The gate uses this to suppress a
   *  spurious step_distance_violation for the single turn where the tracker
   *  caught up — a legit multi-step catch-up is not a forward over-skip.
   *  Optional: treat undefined as false (early-return snapshots omit it). */
  positionJumpedThisTurn?: boolean;
}

export interface RecoveryResult {
  recovered: boolean;
  messages: string[];
  reply: string;
  stage: string;
  subStage: string | null;
  capitalOutcome:
    | 'passed'
    | 'failed'
    | 'hedging'
    | 'ambiguous'
    | 'not_asked'
    | 'not_evaluated';
  recoveryAction: string | null;
  reason: string;
  eventId: string | null;
  priority: RecoveryPriority;
  systemStage: string | null;
  currentScriptStep: number | null;
}

export interface ScriptStepSkipCheck {
  skip: boolean;
  plannedStep: ScriptStepWithRecovery | null;
  plannedStepNumber: number | null;
  plannedStepKey: string | null;
  plannedActionKind: string | null;
  missingSteps: ScriptStepWithRecovery[];
  recoveryStep: ScriptStepWithRecovery | null;
  reason: string | null;
}

const HIGH_CONFIDENCE = 'HIGH';
const RECOVERY_SUCCESS_STATUSES = [
  'SUCCEEDED',
  'PENDING_APPROVAL',
  'APPROVED_SENT'
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function nullableIsoString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function parseBranchHistoryEvent(value: unknown): BranchHistoryEvent | null {
  const record = asRecord(value);
  const eventType =
    record.eventType === 'branch_selected' ||
    record.eventType === 'smart_mode_response' ||
    record.eventType === 'step_completed' ||
    record.eventType === 'conditional_skip_decision' ||
    record.eventType === 'conditional_skip_warning'
      ? record.eventType
      : null;
  const stepNumber =
    typeof record.stepNumber === 'number'
      ? record.stepNumber
      : typeof record.stepNumber === 'string'
        ? Number.parseInt(record.stepNumber, 10)
        : NaN;

  if (!eventType || !Number.isFinite(stepNumber) || stepNumber <= 0) {
    return null;
  }

  return {
    eventType,
    stepNumber,
    stepTitle: nullableString(record.stepTitle),
    selectedBranchLabel: nullableString(record.selectedBranchLabel),
    suggestionId: nullableString(record.suggestionId),
    aiMessageId: nullableString(record.aiMessageId),
    aiMessageIds: nullableStringArray(record.aiMessageIds),
    leadMessageId: nullableString(record.leadMessageId),
    sentAt: nullableIsoString(record.sentAt),
    completedAt: nullableIsoString(record.completedAt),
    createdAt: nullableIsoString(record.createdAt) ?? new Date().toISOString(),
    stepCompletionAttempted: nullableBoolean(record.stepCompletionAttempted),
    stepCompletionReason: nullableString(record.stepCompletionReason),
    previousSelectedBranch: nullableString(record.previousSelectedBranch),
    currentSelectedBranch: nullableString(record.currentSelectedBranch),
    selectedSuggestionId: nullableString(record.selectedSuggestionId),
    historyMessagesWithSelectedSuggestionId: nullableNumber(
      record.historyMessagesWithSelectedSuggestionId
    ),
    skipDestinationStepNumber: nullableNumber(record.skipDestinationStepNumber),
    skipDirective: nullableString(record.skipDirective),
    skipDecision:
      record.skipDecision === 'skip' || record.skipDecision === 'continue'
        ? record.skipDecision
        : null,
    skipReason: nullableString(record.skipReason),
    skipError: nullableString(record.skipError),
    classifierModel: nullableString(record.classifierModel)
  };
}

export function readBranchHistoryEvents(
  points: CapturedDataPoints | Prisma.JsonValue | null | undefined
): BranchHistoryEvent[] {
  const raw = asRecord(points).branchHistory;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseBranchHistoryEvent)
    .filter((event): event is BranchHistoryEvent => event !== null);
}

function branchHistoryEventTime(event: BranchHistoryEvent): number {
  const raw =
    event.completedAt ?? event.sentAt ?? event.createdAt ?? new Date(0);
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : 0;
}

function hasEquivalentBranchHistoryEvent(
  events: BranchHistoryEvent[],
  event: BranchHistoryEvent
): boolean {
  return events.some((existing) => {
    if (
      existing.eventType !== event.eventType ||
      existing.stepNumber !== event.stepNumber
    ) {
      return false;
    }

    if (
      (event.eventType === 'branch_selected' ||
        event.eventType === 'smart_mode_response') &&
      existing.suggestionId &&
      event.suggestionId
    ) {
      return existing.suggestionId === event.suggestionId;
    }

    if (
      event.eventType === 'step_completed' &&
      existing.leadMessageId &&
      event.leadMessageId
    ) {
      return existing.leadMessageId === event.leadMessageId;
    }

    if (
      (event.eventType === 'conditional_skip_decision' ||
        event.eventType === 'conditional_skip_warning') &&
      existing.leadMessageId &&
      event.leadMessageId
    ) {
      return (
        existing.leadMessageId === event.leadMessageId &&
        existing.skipDestinationStepNumber ===
          event.skipDestinationStepNumber &&
        existing.skipDecision === event.skipDecision &&
        existing.skipError === event.skipError
      );
    }

    return (
      existing.selectedBranchLabel === event.selectedBranchLabel &&
      existing.completedAt === event.completedAt &&
      existing.sentAt === event.sentAt
    );
  });
}

function appendBranchHistoryEventToPoints(
  points: CapturedDataPoints,
  event: BranchHistoryEvent
): boolean {
  const existing = readBranchHistoryEvents(points);
  if (hasEquivalentBranchHistoryEvent(existing, event)) return false;
  (points as Record<string, unknown>).branchHistory = [...existing, event];
  return true;
}

export async function appendBranchHistoryEvent(params: {
  conversationId: string;
  event: Omit<BranchHistoryEvent, 'createdAt'> & { createdAt?: string | null };
}) {
  const row = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { capturedDataPoints: true }
  });
  const capturedDataPoints = {
    ...asRecord(row?.capturedDataPoints)
  } as CapturedDataPoints;
  const event: BranchHistoryEvent = {
    ...params.event,
    createdAt: params.event.createdAt ?? new Date().toISOString()
  };

  if (!appendBranchHistoryEventToPoints(capturedDataPoints, event)) return;

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      capturedDataPoints: capturedDataPoints as Prisma.InputJsonValue
    }
  });
}

type ConditionalStepSkipDirective = {
  sourceText: string;
  destinationStepNumber: number;
};

type ConditionalStepSkipClassifierResult = {
  decision: 'skip' | 'continue';
  destinationStepNumber: number | null;
  reason: string | null;
  error?: string | null;
  classifierModel?: string | null;
};

type ConditionalStepSkipClassifier = (params: {
  accountId: string;
  directiveText: string;
  directives: ConditionalStepSkipDirective[];
  recentConversation: ScriptHistoryMessage[];
  priorBranchHistory: BranchHistoryEvent | null;
}) => Promise<ConditionalStepSkipClassifierResult>;

const CONDITIONAL_SKIP_MODEL = 'claude-haiku-4-5-20251001';
const CONDITIONAL_SKIP_PATTERN =
  /(?:skip|go|jump|advance|proceed)\s+(?:to\s+)?(?:step\s*)?(\d+)/gi;
const CONDITIONAL_SKIP_ARROW_PATTERN = /(?:→|->|=>)\s*(?:step\s*)?(\d+)/gi;
const CONDITIONAL_SKIP_HINT_PATTERN =
  /\b(skip|go|jump|advance|proceed)\b|(?:→|->|=>)/i;

function collectRegexMatches(
  content: string,
  regex: RegExp
): ConditionalStepSkipDirective[] {
  const matches: ConditionalStepSkipDirective[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match) {
    const destinationStepNumber = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(destinationStepNumber) || destinationStepNumber <= 0) {
      match = regex.exec(content);
      continue;
    }
    matches.push({
      sourceText: match[0].trim(),
      destinationStepNumber
    });
    match = regex.exec(content);
  }
  regex.lastIndex = 0;
  return matches;
}

export function parseConditionalStepSkipDirectives(
  content: string | null | undefined
): ConditionalStepSkipDirective[] {
  if (!content?.trim()) return [];
  const directives = [
    ...collectRegexMatches(content, CONDITIONAL_SKIP_PATTERN),
    ...collectRegexMatches(content, CONDITIONAL_SKIP_ARROW_PATTERN)
  ];
  const seen = new Set<string>();
  return directives.filter((directive) => {
    const key = `${directive.destinationStepNumber}:${directive.sourceText.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasConditionalSkipHint(content: string | null | undefined): boolean {
  return !!content?.trim() && CONDITIONAL_SKIP_HINT_PATTERN.test(content);
}

function recentConversationForSkipClassifier(history: ScriptHistoryMessage[]) {
  return sortedHistory(history).slice(-10);
}

async function classifyConditionalStepSkipWithLLM(params: {
  accountId: string;
  directiveText: string;
  directives: ConditionalStepSkipDirective[];
  recentConversation: ScriptHistoryMessage[];
  priorBranchHistory: BranchHistoryEvent | null;
}): Promise<ConditionalStepSkipClassifierResult> {
  try {
    const directiveLines = params.directives
      .map(
        (directive) =>
          `- destination STEP ${directive.destinationStepNumber}: ${directive.sourceText}`
      )
      .join('\n');
    const contextLines = params.recentConversation
      .map((message) => `${message.sender}: ${message.content}`.slice(0, 600))
      .join('\n');
    const prompt = `You are a generic conditional step-skip router for an operator-authored sales script.

The operator wrote this runtime_judgment in their script:
${params.directiveText}

Parsed possible skip destinations:
${directiveLines}

Recent conversation:
${contextLines || '(none)'}

Prior branchHistory entry:
${JSON.stringify(params.priorBranchHistory ?? null)}

Decide whether the operator's runtime_judgment means the conversation should skip now, based only on the operator's script text and the recent conversation context.

Respond with ONLY compact JSON:
{"decision":"skip"|"continue","destinationStepNumber":number|null,"reason":"short reason"}`;

    const result = await callHaikuText({
      accountId: params.accountId,
      maxTokens: 120,
      temperature: 0,
      timeoutMs: 3000,
      logPrefix: '[conditional-step-skip]',
      prompt
    });
    if (!result.text) {
      return {
        decision: 'continue',
        destinationStepNumber: null,
        reason: result.error || 'empty_llm_response',
        error: result.error || 'empty_llm_response',
        classifierModel: result.model
      };
    }

    const jsonText = result.text.match(/\{[\s\S]*\}/)?.[0] ?? result.text;
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const rawDecision =
      typeof parsed.decision === 'string'
        ? parsed.decision.trim().toLowerCase()
        : null;
    const decision = rawDecision === 'skip' ? 'skip' : 'continue';
    const destinationStepNumber =
      typeof parsed.destinationStepNumber === 'number'
        ? parsed.destinationStepNumber
        : typeof parsed.destinationStepNumber === 'string'
          ? Number.parseInt(parsed.destinationStepNumber, 10)
          : null;

    return {
      decision,
      destinationStepNumber:
        Number.isFinite(destinationStepNumber) && destinationStepNumber
          ? destinationStepNumber
          : null,
      reason:
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : null,
      classifierModel: result.model
    };
  } catch (err) {
    return {
      decision: 'continue',
      destinationStepNumber: null,
      reason: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? err.message : String(err),
      classifierModel: null
    };
  }
}

function isCapturedDataPoint(value: unknown): value is CapturedDataPoint {
  return (
    !!value &&
    typeof value === 'object' &&
    'value' in value &&
    'confidence' in value
  );
}

function capturedPointForKey(
  points: CapturedDataPoints,
  key: string
): CapturedDataPoint | undefined {
  for (const candidate of equivalentCapturedDataPointKeys(key)) {
    const point = points[candidate];
    if (isCapturedDataPoint(point)) return point;
  }
  return undefined;
}

function pointValue<T = unknown>(
  points: CapturedDataPoints,
  key: string,
  requireHigh = true
): T | null {
  const point = capturedPointForKey(points, key);
  if (!point) return null;
  if (requireHigh && point.confidence !== HIGH_CONFIDENCE) return null;
  return point.value as T;
}

function pointIsHigh(points: CapturedDataPoints, key: string): boolean {
  const point = capturedPointForKey(points, key);
  return !!point && point.confidence === HIGH_CONFIDENCE;
}

function pointIsPresent(points: CapturedDataPoints, key: string): boolean {
  const point = capturedPointForKey(points, key);
  if (!point) return false;
  return point.confidence === HIGH_CONFIDENCE && point.value !== null;
}

const NUMERIC_AMOUNT_POINT_KEYS = new Set([
  'monthlyIncome',
  'incomeGoal',
  'verifiedCapitalUsd',
  'capital'
]);

function normalizePointValueForKey<T>(key: string, value: T): T | number {
  if (typeof value !== 'string') return value;
  if (!NUMERIC_AMOUNT_POINT_KEYS.has(key)) return value;

  const amount = extractAmountUSD(value);
  return amount ?? value;
}

function setPoint<T>(
  points: CapturedDataPoints,
  key: string,
  value: T,
  confidence: DataPointConfidence,
  extractedFromMessageId: string | null,
  extractionMethod: string,
  metadata?: {
    sourceFieldName?: string | null;
    sourceStepNumber?: number | null;
    sourceQuestion?: string | null;
  }
) {
  const canonicalKey = canonicalCapturedDataPointKey(key);
  const normalizedValue = normalizePointValueForKey(canonicalKey, value);
  const existing = points[canonicalKey];
  if (
    isCapturedDataPoint(existing) &&
    existing.confidence === HIGH_CONFIDENCE &&
    confidence !== HIGH_CONFIDENCE
  ) {
    return;
  }

  points[canonicalKey] = {
    value: normalizedValue,
    confidence,
    extractedFromMessageId,
    extractionMethod,
    extractedAt: new Date().toISOString(),
    ...(metadata?.sourceFieldName !== undefined
      ? { sourceFieldName: metadata.sourceFieldName }
      : {}),
    ...(metadata?.sourceStepNumber !== undefined
      ? { sourceStepNumber: metadata.sourceStepNumber }
      : {}),
    ...(metadata?.sourceQuestion !== undefined
      ? { sourceQuestion: metadata.sourceQuestion }
      : {})
  };
}

function sortedHistory(
  history: ScriptHistoryMessage[]
): ScriptHistoryMessage[] {
  // MANYCHAT messages are opening-handoff hooks (button-clicks, auto-
  // fired automation copy) — they don't represent a script step the
  // setter performed and they don't represent a lead disclosure. Every
  // existing extract* / detect* / recovery helper iterating this list
  // already filters by sender === 'AI' | 'HUMAN' | 'LEAD' explicitly,
  // which excludes MANYCHAT incidentally. Centralising the reject
  // here locks in the invariant for every CURRENT and FUTURE caller —
  // and fixes the latent priorityForSkipRecovery bug that did
  // .at(-1) without sender filtering and could pick a MANYCHAT row
  // as "latest" for HOT-vs-MEDIUM bucketing.
  return [...history]
    .filter((m) => m.sender !== 'MANYCHAT')
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

type StepCompletionAction = {
  actionType: string;
  content: string | null;
};

type StepCompletionPath = {
  selectedBranchLabel: string | null;
  actions: StepCompletionAction[];
};

type StepCompletionResult = {
  complete: boolean;
  completedAt: number;
  aiMessageId: string | null;
  aiMessageIds: string[];
  leadMessageId: string | null;
  sentAt: string | null;
  reason: string;
  selectedBranchLabel: string | null;
  selectedSuggestionId: string | null;
  historyMessagesWithSelectedSuggestionId: number | null;
};

function stepActionRef(action: {
  actionType: string;
  content: string | null;
}): StepCompletionAction {
  return {
    actionType: action.actionType,
    content: action.content
  };
}

function collectAllStepActions(
  step: ScriptStepWithRecovery
): StepCompletionAction[] {
  return [
    ...step.actions.map(stepActionRef),
    ...step.branches.flatMap((branch) => branch.actions.map(stepActionRef))
  ];
}

function dedupeStepCompletionActions(
  actions: StepCompletionAction[]
): StepCompletionAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = `${action.actionType}:${action.content?.trim() ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stepCompletionActionPaths(
  step: ScriptStepWithRecovery,
  selectedBranchLabel: string | null = null
): StepCompletionAction[][] {
  return stepCompletionPaths(step, selectedBranchLabel).map(
    (path) => path.actions
  );
}

function stepCompletionPaths(
  step: ScriptStepWithRecovery,
  selectedBranchLabel: string | null = null
): StepCompletionPath[] {
  const directActions = step.actions.map(stepActionRef);
  if (step.branches.length === 0) {
    return [
      {
        selectedBranchLabel: null,
        actions: dedupeStepCompletionActions(directActions)
      }
    ];
  }

  const branchActions = selectedBranchLabel
    ? step.branches.filter(
        (branch) => branch.branchLabel === selectedBranchLabel
      )
    : step.branches;

  if (selectedBranchLabel && branchActions.length === 0) {
    return [
      {
        selectedBranchLabel: null,
        actions: dedupeStepCompletionActions(directActions)
      }
    ];
  }

  return branchActions.map((branch) => ({
    selectedBranchLabel: branch.branchLabel,
    actions: dedupeStepCompletionActions([
      ...directActions,
      ...branch.actions.map(stepActionRef)
    ])
  }));
}

export function branchHistorySelectedLabelForStep(
  points: CapturedDataPoints,
  stepNumber: number
): string | null {
  const events = readBranchHistoryEvents(points)
    .filter(
      (event) => event.stepNumber === stepNumber && !!event.selectedBranchLabel
    )
    .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b));

  return events.at(-1)?.selectedBranchLabel ?? null;
}

export function isNoSignalRecoveryBranch(
  branch: Pick<
    ScriptBranchWithRecovery,
    'branchLabel' | 'conditionDescription'
  > | null
): boolean {
  if (!branch) return false;
  const text =
    `${branch.branchLabel} ${branch.conditionDescription ?? ''}`.toLowerCase();
  return (
    /\bno[ -]?signal\b/.test(text) || /\bno answerable content\b/.test(text)
  );
}

export function shouldHoldNoSignalRecoveryAdvance(params: {
  priorStep: number;
  computedStep: number;
  selectedBranch: Pick<
    ScriptBranchWithRecovery,
    'branchLabel' | 'conditionDescription'
  > | null;
}): boolean {
  return (
    params.computedStep > params.priorStep &&
    isNoSignalRecoveryBranch(params.selectedBranch)
  );
}

function removeNoSignalStepCompletion(
  points: CapturedDataPoints,
  stepNumber: number
): void {
  const events = readBranchHistoryEvents(points).filter(
    (event) =>
      !(event.eventType === 'step_completed' && event.stepNumber === stepNumber)
  );
  (points as Record<string, unknown>).branchHistory = events;
}

function branchHistorySelectionForStep(
  points: CapturedDataPoints,
  stepNumber: number
): BranchHistoryEvent | null {
  return (
    readBranchHistoryEvents(points)
      .filter(
        (event) =>
          // smart_mode_response is the smart-mode equivalent of branch_selected
          // (ai-engine.ts:6258-6260) and also carries the step's suggestionId,
          // so completion detection must recognize both — otherwise smart-mode
          // conversations get the same paraphrase-driven step-parking bug.
          (event.eventType === 'branch_selected' ||
            event.eventType === 'smart_mode_response') &&
          event.stepNumber === stepNumber
      )
      .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b))
      .at(-1) ?? null
  );
}

// F5.1 (2026-06-07): ALL suggestionIds the AI has used for a given step, oldest
// first. When the position is stuck, the engine re-emits a branch_selected@step
// every turn with a NEW suggestionId — so `branchHistorySelectionForStep` (which
// returns only the latest) points at the CURRENT turn's bubble, which has no lead
// reply yet, and completion never fires. Completion detection must consider every
// suggestion the step has used and accept the FIRST one that got a lead reply.
function allSuggestionIdsForStep(
  points: CapturedDataPoints,
  stepNumber: number
): string[] {
  return readBranchHistoryEvents(points)
    .filter(
      (event) =>
        (event.eventType === 'branch_selected' ||
          event.eventType === 'smart_mode_response') &&
        event.stepNumber === stepNumber &&
        typeof event.suggestionId === 'string' &&
        event.suggestionId.length > 0
    )
    .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b))
    .map((event) => event.suggestionId as string);
}

function selectedBranchLabelForStep(
  points: CapturedDataPoints,
  stepNumber: number
): string | null {
  const branchHistoryLabel = branchHistorySelectedLabelForStep(
    points,
    stepNumber
  );
  if (branchHistoryLabel) return branchHistoryLabel;

  const trace = asRecord(points.lastClassifierTrace);
  const tracedStepNumber =
    typeof trace.stepNumber === 'number'
      ? trace.stepNumber
      : typeof trace.stepNumber === 'string'
        ? Number.parseInt(trace.stepNumber, 10)
        : null;
  if (tracedStepNumber !== stepNumber) return null;

  for (const key of [
    'finalSelectedLabel',
    'llmSelectedLabel',
    'tokenSelectedLabel'
  ]) {
    const value = trace[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function completedBranchHistoryForStep(
  points: CapturedDataPoints,
  stepNumber: number,
  afterTimeMs: number
): BranchHistoryEvent | null {
  return (
    readBranchHistoryEvents(points)
      .filter((event) => {
        if (event.eventType !== 'step_completed') return false;
        if (event.stepNumber !== stepNumber || !event.completedAt) return false;
        const completedAt = Date.parse(event.completedAt);
        return Number.isFinite(completedAt) && completedAt > afterTimeMs;
      })
      .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b))
      .at(0) ?? null
  );
}

function durableMinimumStepNumber(
  points: CapturedDataPoints,
  steps: ScriptStepWithRecovery[]
): number | null {
  const maxCompletedStepNumber = readBranchHistoryEvents(points)
    .filter((event) => event.eventType === 'step_completed')
    .reduce(
      (max, event) => Math.max(max, event.stepNumber),
      Number.NEGATIVE_INFINITY
    );
  if (!Number.isFinite(maxCompletedStepNumber)) return null;
  const nextStep = steps.find(
    (step) => step.stepNumber > maxCompletedStepNumber
  );
  return nextStep?.stepNumber ?? maxCompletedStepNumber;
}

function latestCompletedBranchHistoryEvent(
  points: CapturedDataPoints
): BranchHistoryEvent | null {
  return (
    readBranchHistoryEvents(points)
      .filter(
        (event) => event.eventType === 'step_completed' && !!event.completedAt
      )
      .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b))
      .at(-1) ?? null
  );
}

function existingConditionalSkipDecision(params: {
  points: CapturedDataPoints;
  stepNumber: number;
  leadMessageId: string | null;
}): BranchHistoryEvent | null {
  if (!params.leadMessageId) return null;
  return (
    readBranchHistoryEvents(params.points)
      .filter(
        (event) =>
          event.eventType === 'conditional_skip_decision' &&
          event.stepNumber === params.stepNumber &&
          event.leadMessageId === params.leadMessageId
      )
      .sort((a, b) => branchHistoryEventTime(a) - branchHistoryEventTime(b))
      .at(-1) ?? null
  );
}

function runtimeJudgmentTextsForCompletedStep(
  step: ScriptStepWithRecovery,
  selectedBranchLabel: string | null
): string[] {
  const directActions = step.actions;
  const selectedBranches = selectedBranchLabel
    ? step.branches.filter(
        (branch) => branch.branchLabel === selectedBranchLabel
      )
    : step.branches;
  const branchActions =
    selectedBranchLabel && selectedBranches.length === 0
      ? []
      : selectedBranches.flatMap((branch) => branch.actions);

  return [...directActions, ...branchActions]
    .filter(
      (action) =>
        action.actionType === 'runtime_judgment' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    )
    .map((action) => action.content!.trim());
}

function appendConditionalSkipEvent(
  points: CapturedDataPoints,
  params: {
    eventType: 'conditional_skip_decision' | 'conditional_skip_warning';
    sourceStep: ScriptStepWithRecovery;
    completedEvent: BranchHistoryEvent;
    directiveText: string | null;
    destinationStepNumber: number | null;
    decision: 'skip' | 'continue' | null;
    reason: string | null;
    error?: string | null;
    classifierModel?: string | null;
  }
) {
  appendBranchHistoryEventToPoints(points, {
    eventType: params.eventType,
    stepNumber: params.sourceStep.stepNumber,
    stepTitle: params.sourceStep.title ?? null,
    selectedBranchLabel: params.completedEvent.selectedBranchLabel,
    suggestionId: params.completedEvent.suggestionId,
    aiMessageId: params.completedEvent.aiMessageId,
    aiMessageIds: params.completedEvent.aiMessageIds,
    leadMessageId: params.completedEvent.leadMessageId,
    sentAt: params.completedEvent.sentAt,
    completedAt: params.completedEvent.completedAt,
    createdAt: new Date().toISOString(),
    skipDestinationStepNumber: params.destinationStepNumber,
    skipDirective: params.directiveText,
    skipDecision: params.decision,
    skipReason: params.reason,
    skipError: params.error ?? null,
    classifierModel: params.classifierModel ?? CONDITIONAL_SKIP_MODEL
  });
}

export async function applyConditionalStepSkip(params: {
  accountId: string;
  script: ScriptWithRecovery | null;
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  currentStep: ScriptStepWithRecovery | null;
  classifier?: ConditionalStepSkipClassifier;
}): Promise<{
  step: ScriptStepWithRecovery | null;
  reason: string | null;
}> {
  if (!params.script || !params.currentStep) {
    return { step: params.currentStep, reason: null };
  }

  const completedEvent = latestCompletedBranchHistoryEvent(params.points);
  if (!completedEvent?.completedAt) {
    return { step: params.currentStep, reason: null };
  }

  const sourceStep = params.script.steps.find(
    (step) => step.stepNumber === completedEvent.stepNumber
  );
  if (!sourceStep || sourceStep.stepNumber >= params.currentStep.stepNumber) {
    return { step: params.currentStep, reason: null };
  }

  const existingDecision = existingConditionalSkipDecision({
    points: params.points,
    stepNumber: sourceStep.stepNumber,
    leadMessageId: completedEvent.leadMessageId
  });
  if (existingDecision?.skipDecision === 'skip') {
    const destinationStep = params.script.steps.find(
      (step) => step.stepNumber === existingDecision.skipDestinationStepNumber
    );
    if (
      destinationStep &&
      destinationStep.stepNumber > params.currentStep.stepNumber
    ) {
      return {
        step: destinationStep,
        reason: `conditional_skip_cached:${sourceStep.stepNumber}->${destinationStep.stepNumber}`
      };
    }
    return { step: params.currentStep, reason: null };
  }
  if (existingDecision?.skipDecision === 'continue') {
    return { step: params.currentStep, reason: null };
  }

  const runtimeJudgments = runtimeJudgmentTextsForCompletedStep(
    sourceStep,
    completedEvent.selectedBranchLabel
  );
  const judgmentWithDirectives = runtimeJudgments
    .map((text) => ({
      text,
      directives: parseConditionalStepSkipDirectives(text)
    }))
    .find((entry) => entry.directives.length > 0);

  if (!judgmentWithDirectives) {
    const unparsableJudgment = runtimeJudgments.find(hasConditionalSkipHint);
    if (unparsableJudgment) {
      appendConditionalSkipEvent(params.points, {
        eventType: 'conditional_skip_warning',
        sourceStep,
        completedEvent,
        directiveText: unparsableJudgment,
        destinationStepNumber: null,
        decision: null,
        reason: 'conditional_skip_pattern_not_parsed',
        error: 'conditional_skip_pattern_not_parsed'
      });
    }
    return { step: params.currentStep, reason: null };
  }

  const classifier = params.classifier ?? classifyConditionalStepSkipWithLLM;
  let classification: ConditionalStepSkipClassifierResult;
  try {
    classification = await classifier({
      accountId: params.accountId,
      directiveText: judgmentWithDirectives.text,
      directives: judgmentWithDirectives.directives,
      recentConversation: recentConversationForSkipClassifier(params.history),
      priorBranchHistory: completedEvent
    });
  } catch (err) {
    classification = {
      decision: 'continue',
      destinationStepNumber: null,
      reason: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? err.message : String(err),
      classifierModel: null
    };
  }
  const allowedDestinations = new Set(
    judgmentWithDirectives.directives.map(
      (directive) => directive.destinationStepNumber
    )
  );
  const destinationStepNumber =
    classification.destinationStepNumber ??
    (judgmentWithDirectives.directives.length === 1
      ? judgmentWithDirectives.directives[0].destinationStepNumber
      : null);
  const destinationStep =
    classification.decision === 'skip' &&
    destinationStepNumber &&
    allowedDestinations.has(destinationStepNumber)
      ? params.script.steps.find(
          (step) => step.stepNumber === destinationStepNumber
        )
      : null;
  const canSkip =
    classification.decision === 'skip' &&
    !!destinationStep &&
    destinationStep.stepNumber > params.currentStep.stepNumber;

  appendConditionalSkipEvent(params.points, {
    eventType: 'conditional_skip_decision',
    sourceStep,
    completedEvent,
    directiveText: judgmentWithDirectives.text,
    destinationStepNumber:
      Number.isFinite(destinationStepNumber) && destinationStepNumber
        ? destinationStepNumber
        : null,
    decision: canSkip ? 'skip' : 'continue',
    reason:
      classification.reason ??
      (canSkip ? 'classifier_selected_skip' : 'classifier_selected_continue'),
    error:
      classification.error ??
      (classification.decision === 'skip' && !canSkip
        ? 'invalid_or_non_forward_destination'
        : null),
    classifierModel: classification.classifierModel ?? null
  });

  if (!canSkip) return { step: params.currentStep, reason: null };

  return {
    step: destinationStep,
    reason: `conditional_skip:${sourceStep.stepNumber}->${destinationStep.stepNumber}`
  };
}

function stripTemplateVariables(text: string): string {
  return text.replace(/\{\{\s*[^}]+\s*\}\}/g, ' ');
}

function normalizeForStepCompletion(text: string): string {
  return stripTemplateVariables(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function completionTokenSet(text: string): Set<string> {
  return new Set(
    normalizeForStepCompletion(text)
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

function completionOverlap(required: string, actual: string): number {
  const requiredTokens = completionTokenSet(required);
  if (requiredTokens.size === 0) return 1;
  const actualTokens = completionTokenSet(actual);
  let matches = 0;
  for (const token of Array.from(requiredTokens)) {
    if (actualTokens.has(token)) matches++;
  }
  return matches / requiredTokens.size;
}

function actionContentMatches(
  required: string | null | undefined,
  actual: string | null | undefined
): boolean {
  if (!required || !actual) return false;
  const normalizedRequired = normalizeForStepCompletion(required);
  if (!normalizedRequired) return false;
  const normalizedActual = normalizeForStepCompletion(actual);
  if (normalizedActual.includes(normalizedRequired)) return true;
  return completionOverlap(required, actual) >= 0.35;
}

const CALL_PROPOSAL_MESSAGE_PATTERNS: RegExp[] = [
  /\bset\s+up\s+a\s+(quick\s+)?(call|chat|convo|conversation|zoom|time)\b/i,
  /\b(book(ing)?|schedule|hop(ping)?\s*on|jump(ing)?\s*on|get\s*you\s*on|get\s*on)\s+a?\s*(quick\s+)?(call|chat|convo|conversation|zoom)\b/i,
  /\b(quick|15[\s-]?min(ute)?)\s+(call|chat|convo)\b/i,
  // Leak-audit 1-5: removed the hardcoded "anthony" closer literal; the
  // generic closer terms (right hand / head coach / partner / closer) cover
  // the same intent for any tenant without leaking daetradez's closer name.
  /\b(call|chat|time)\s+with\s+(my\s+)?(right.?hand|partner|head\s+coach|business\s+partner|closer)\b/i,
  /\bset\s+(you\s+)?up\s+(a\s+time\s+)?with\s+(my\s+)?(right.?hand|head\s+coach|partner|closer)\b/i,
  /\blocked\s+in\s+with\s+(my\s+)?(right.?hand|head\s+coach|partner|closer)\b/i,
  /\b(point\s+you\s+in\s+the\s+right\s+direction|break\s+down\s+a\s+roadmap|working\s+together\s+looks\s+like|would\s+that\s+help)\b/i
];

function isCallProposalStep(step: ScriptStepWithRecovery): boolean {
  const key = normalizedStepKey(step);
  return (
    (key.includes('CALL_PROPOSAL') || key.includes('SOFT_PITCH')) &&
    !key.includes('RESPONSE')
  );
}

function isCallProposalMessage(content: string | null | undefined): boolean {
  if (!content || typeof content !== 'string') return false;
  return CALL_PROPOSAL_MESSAGE_PATTERNS.some((pattern) =>
    pattern.test(content)
  );
}

function contentIsRuntimePlaceholderOnly(
  content: string | null | undefined
): boolean {
  return (
    typeof content === 'string' && /^\s*\{\{[\s\S]+?\}\}\s*$/.test(content)
  );
}

function hasLeadReplyAfter(
  history: ScriptHistoryMessage[],
  setterMessage: ScriptHistoryMessage
): ScriptHistoryMessage | null {
  const sentAt = new Date(setterMessage.timestamp).getTime();
  return (
    history.find(
      (message) =>
        message.sender === 'LEAD' &&
        new Date(message.timestamp).getTime() > sentAt
    ) ?? null
  );
}

// Answer-satisfaction gate moved to the shared leaf module @/lib/answer-satisfaction
// (2026-07-23) so the step-completion layer and the variable-resolver layer use
// ONE hardened predicate instead of drifting copies. Imported above; re-exported
// here for existing callers/tests that import it from this module.
export { replyAnswersAsk };

function findSetterMessageForContent(
  history: ScriptHistoryMessage[],
  requiredContent: string | null | undefined,
  afterTimeMs = Number.NEGATIVE_INFINITY,
  placeholderSuggestionId: string | null = null
): ScriptHistoryMessage | null {
  if (!requiredContent) {
    return null;
  }

  if (contentIsRuntimePlaceholderOnly(requiredContent)) {
    if (placeholderSuggestionId) {
      return (
        history.find(
          (message) =>
            (message.sender === 'AI' || message.sender === 'HUMAN') &&
            message.suggestionId === placeholderSuggestionId &&
            new Date(message.timestamp).getTime() > afterTimeMs
        ) ?? null
      );
    }

    return (
      history.find(
        (message) =>
          (message.sender === 'AI' || message.sender === 'HUMAN') &&
          new Date(message.timestamp).getTime() > afterTimeMs
      ) ?? null
    );
  }

  return (
    history.find(
      (message) =>
        (message.sender === 'AI' || message.sender === 'HUMAN') &&
        new Date(message.timestamp).getTime() > afterTimeMs &&
        actionContentMatches(requiredContent, message.content)
    ) ?? null
  );
}

function waitableActionsForPath(actions: StepCompletionAction[]): {
  asks: StepCompletionAction[];
  messages: StepCompletionAction[];
  waits: StepCompletionAction[];
} {
  const asks = actions.filter(
    (action) =>
      action.actionType === 'ask_question' &&
      typeof action.content === 'string' &&
      action.content.trim().length > 0 &&
      !contentIsRuntimePlaceholderOnly(action.content)
  );
  const messages = actions.filter(
    (action) =>
      action.actionType === 'send_message' &&
      typeof action.content === 'string' &&
      action.content.trim().length > 0
  );
  const waits = actions.filter(
    (action) =>
      action.actionType === 'wait_for_response' ||
      action.actionType === 'wait_duration'
  );

  return { asks, messages, waits };
}

function waitableStepActions(step: ScriptStepWithRecovery): {
  asks: StepCompletionAction[];
  messages: StepCompletionAction[];
  waits: StepCompletionAction[];
} {
  return waitableActionsForPath(collectAllStepActions(step));
}

function stepHasHistoryCompletionSignal(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints
): boolean {
  if (isCallProposalStep(step)) return true;
  if (step.canonicalQuestion?.trim()) return true;

  const selectedBranchLabel = selectedBranchLabelForStep(
    points,
    step.stepNumber
  );

  return stepCompletionActionPaths(step, selectedBranchLabel).some(
    (actions) => {
      const { asks, messages, waits } = waitableActionsForPath(actions);
      // F5.1 Phase 6A: a judgment-after-wait step that HAS an ask is now
      // eligible for history completion — stepCompletionFromHistory can
      // complete it via the suggestionId ask-reply signal (the judgment-step
      // completion path), which stops the deep-why parking/loop. A judgment
      // path with NO ask (pure routing) stays ineligible (handled elsewhere).
      if (hasRuntimeJudgmentAfterWait(actions)) return asks.length > 0;
      return asks.length > 0 || (messages.length > 0 && waits.length > 0);
    }
  );
}

function findSetterMessagesForActions(
  history: ScriptHistoryMessage[],
  actions: StepCompletionAction[],
  afterTimeMs = Number.NEGATIVE_INFINITY,
  placeholderSuggestionId: string | null = null
): ScriptHistoryMessage[] | null {
  const sentMessages: ScriptHistoryMessage[] = [];
  let cursor = afterTimeMs;

  for (const action of actions) {
    const sent = findSetterMessageForContent(
      history,
      action.content,
      cursor,
      sentMessages.length === 0 ? placeholderSuggestionId : null
    );
    if (!sent) return null;
    sentMessages.push(sent);
    cursor = new Date(sent.timestamp).getTime();
  }

  return sentMessages;
}

function selectedSuggestionMessagesForActions(
  history: ScriptHistoryMessage[],
  actions: StepCompletionAction[],
  suggestionId: string | null,
  afterTimeMs = Number.NEGATIVE_INFINITY
): ScriptHistoryMessage[] | null {
  if (!suggestionId) return null;

  const selectedMessages = selectedSuggestionMessagesAfter(
    history,
    suggestionId,
    afterTimeMs
  );
  if (selectedMessages.length < actions.length) return null;

  return selectedMessages.slice(0, actions.length);
}

function selectedSuggestionMessagesAfter(
  history: ScriptHistoryMessage[],
  suggestionId: string | null,
  afterTimeMs: number
): ScriptHistoryMessage[] {
  if (!suggestionId) return [];
  return history.filter(
    (message) =>
      (message.sender === 'AI' || message.sender === 'HUMAN') &&
      message.suggestionId === suggestionId &&
      new Date(message.timestamp).getTime() > afterTimeMs
  );
}

function hasActionType(
  actions: StepCompletionAction[],
  actionType: string
): boolean {
  return actions.some((action) => action.actionType === actionType);
}

function hasWaitAction(actions: StepCompletionAction[]): boolean {
  return actions.some(
    (action) =>
      action.actionType === 'wait_for_response' ||
      action.actionType === 'wait_duration'
  );
}

function hasRuntimeJudgmentAfterWait(actions: StepCompletionAction[]): boolean {
  let sawWait = false;
  for (const action of actions) {
    if (
      action.actionType === 'wait_for_response' ||
      action.actionType === 'wait_duration'
    ) {
      sawWait = true;
      continue;
    }
    if (sawWait && action.actionType === 'runtime_judgment') {
      return true;
    }
  }
  return false;
}

function pathIsAutoCompletableRoutingOnly(
  actions: StepCompletionAction[]
): boolean {
  return (
    hasActionType(actions, 'runtime_judgment') &&
    !hasActionType(actions, 'ask_question') &&
    !hasWaitAction(actions)
  );
}

function autoCompletionFromSelectedRoutingBranch(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  afterTimeMs: number
): StepCompletionResult | null {
  const selectedBranchHistory = branchHistorySelectionForStep(
    points,
    step.stepNumber
  );
  const selectedBranchLabel =
    selectedBranchHistory?.selectedBranchLabel ?? null;
  if (!selectedBranchHistory || !selectedBranchLabel) return null;

  const selectionTime = branchHistoryEventTime(selectedBranchHistory);
  if (selectionTime <= afterTimeMs) return null;

  const actionPath = stepCompletionActionPaths(step, selectedBranchLabel).find(
    pathIsAutoCompletableRoutingOnly
  );
  if (!actionPath) return null;

  const sorted = sortedHistory(history);
  const selectedMessages = selectedSuggestionMessagesAfter(
    sorted,
    selectedBranchHistory.suggestionId,
    afterTimeMs
  );
  const hasOutboundAction =
    hasActionType(actionPath, 'send_message') ||
    hasActionType(actionPath, 'send_link') ||
    hasActionType(actionPath, 'send_voice_note');

  if (hasOutboundAction && selectedMessages.length === 0) {
    return incompleteStepCompletion(
      afterTimeMs,
      'routing_only_branch_waiting_for_selected_message',
      selectedBranchLabel,
      selectedBranchHistory.suggestionId,
      0
    );
  }

  const lastSelectedMessage = selectedMessages.at(-1) ?? null;
  const completedAt = lastSelectedMessage
    ? new Date(lastSelectedMessage.timestamp).getTime()
    : selectionTime;
  const sentAt = lastSelectedMessage
    ? new Date(lastSelectedMessage.timestamp).toISOString()
    : (selectedBranchHistory.sentAt ?? selectedBranchHistory.createdAt);
  const aiMessageIds = selectedMessages
    .map((message) => message.id)
    .filter((id): id is string => !!id);

  return {
    complete: true,
    completedAt,
    aiMessageId: lastSelectedMessage?.id ?? selectedBranchHistory.aiMessageId,
    aiMessageIds:
      aiMessageIds.length > 0
        ? aiMessageIds
        : selectedBranchHistory.aiMessageIds,
    leadMessageId: selectedBranchHistory.leadMessageId,
    sentAt,
    reason: 'routing_only_branch_auto_complete',
    selectedBranchLabel,
    selectedSuggestionId: selectedBranchHistory.suggestionId,
    historyMessagesWithSelectedSuggestionId: selectedMessages.length
  };
}

function incompleteStepCompletion(
  afterTimeMs: number,
  reason: string,
  selectedBranchLabel: string | null = null,
  selectedSuggestionId: string | null = null,
  historyMessagesWithSelectedSuggestionId: number | null = null
): StepCompletionResult {
  return {
    complete: false,
    completedAt: afterTimeMs,
    aiMessageId: null,
    aiMessageIds: [],
    leadMessageId: null,
    sentAt: null,
    reason,
    selectedBranchLabel,
    selectedSuggestionId,
    historyMessagesWithSelectedSuggestionId
  };
}

function callProposalCompletionFromHistory(params: {
  step: ScriptStepWithRecovery;
  history: ScriptHistoryMessage[];
  afterTimeMs: number;
  selectedBranchLabel: string | null;
  selectedSuggestionId: string | null;
  historyMessagesWithSelectedSuggestionId: number | null;
}): StepCompletionResult | null {
  if (!isCallProposalStep(params.step)) return null;

  const proposalMessage =
    params.history.find(
      (message) =>
        (message.sender === 'AI' || message.sender === 'HUMAN') &&
        new Date(message.timestamp).getTime() > params.afterTimeMs &&
        isCallProposalMessage(message.content)
    ) ?? null;
  const leadReply = proposalMessage
    ? hasLeadReplyAfter(params.history, proposalMessage)
    : null;
  if (!proposalMessage || !leadReply) return null;

  return {
    complete: true,
    completedAt: new Date(leadReply.timestamp).getTime(),
    aiMessageId: proposalMessage.id ?? null,
    aiMessageIds: proposalMessage.id ? [proposalMessage.id] : [],
    leadMessageId: leadReply.id ?? null,
    sentAt: new Date(proposalMessage.timestamp).toISOString(),
    reason: 'completed_by_call_proposal_reply',
    selectedBranchLabel: params.selectedBranchLabel,
    selectedSuggestionId: params.selectedSuggestionId,
    historyMessagesWithSelectedSuggestionId:
      params.historyMessagesWithSelectedSuggestionId
  };
}

function stepCompletionFromHistory(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  afterTimeMs = Number.NEGATIVE_INFINITY
): StepCompletionResult {
  if (history.length === 0) {
    return incompleteStepCompletion(afterTimeMs, 'no_history');
  }
  const sorted = sortedHistory(history);
  const canonicalCandidates =
    step.canonicalQuestion && step.canonicalQuestion.trim().length > 0
      ? [{ actionType: 'ask_question', content: step.canonicalQuestion }]
      : [];
  const selectedBranchLabel = selectedBranchLabelForStep(
    points,
    step.stepNumber
  );
  const selectedBranchHistory = branchHistorySelectionForStep(
    points,
    step.stepNumber
  );
  const selectedSuggestionId = selectedBranchHistory?.suggestionId ?? null;
  const historyMessagesWithSelectedSuggestionId = selectedSuggestionId
    ? sorted.filter((message) => message.suggestionId === selectedSuggestionId)
        .length
    : null;
  let lastReason =
    selectedSuggestionId && historyMessagesWithSelectedSuggestionId === 0
      ? 'selected_suggestion_id_not_present_in_recovery_history'
      : 'no_completion_match';

  for (const actions of stepCompletionActionPaths(step, selectedBranchLabel)) {
    if (hasRuntimeJudgmentAfterWait(actions)) {
      const callProposalCompletion = callProposalCompletionFromHistory({
        step,
        history: sorted,
        afterTimeMs,
        selectedBranchLabel,
        selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId
      });
      if (callProposalCompletion) {
        return callProposalCompletion;
      }

      // F5.1 Phase 6A (2026-06-08): complete JUDGMENT steps (ask + wait +
      // runtime_judgment, e.g. the deep-why step 11) that the lead has answered.
      // These were excluded from history completion entirely, so the position
      // parked on them and the AI re-asked the same question every turn (the
      // live deep-why loop). If this step has an ask AND a sent bubble (matched
      // by ANY of the step's suggestionIds, oldest-first) got a lead reply, the
      // judgment step is answered → complete it. This keeps a genuine
      // "probe once if surface" possible (the first ask+reply) but stops the
      // infinite loop. Same reliable suggestionId signal as the ask-step fix.
      const { asks: judgmentAsks } = waitableActionsForPath(actions);
      if (judgmentAsks.length > 0) {
        const judgmentSuggestionIds = allSuggestionIdsForStep(
          points,
          step.stepNumber
        );
        if (
          judgmentSuggestionIds.length === 0 &&
          typeof selectedSuggestionId === 'string'
        ) {
          judgmentSuggestionIds.push(selectedSuggestionId);
        }
        // Anti-loop backstop: if the step was branch_selected ≥2 times (each a
        // re-ask), force-complete on the EARLIEST ask+reply so it can't loop
        // forever, even if a future judgment step resists the per-ask signal.
        const reAskCount = judgmentSuggestionIds.length;
        for (const candidateSid of judgmentSuggestionIds) {
          const askBySuggestion =
            selectedSuggestionMessagesAfter(
              sorted,
              candidateSid,
              afterTimeMs
            ).at(0) ?? null;
          const leadReply = askBySuggestion
            ? hasLeadReplyAfter(sorted, askBySuggestion)
            : null;
          if (askBySuggestion && leadReply) {
            // F4 (2026-07-23): this judgment/deep-why path completed on ANY
            // lead reply, content-blind — the live 3→4 deferral advance. Gate
            // it on answer-satisfaction like the plain-ASK paths: a pure
            // question-back / deferral / pricing question does NOT complete the
            // step. BUT preserve the original anti-loop purpose — after the step
            // has been re-asked ≥2 times, force-complete regardless so a lead
            // who keeps deflecting can't park the position forever (better to
            // move on than re-ask infinitely). So: hold on a non-answer for the
            // first 1–2 asks, then the anti-loop escape releases it.
            const answered = replyAnswersAsk(leadReply.content);
            if (!answered && reAskCount < 2) {
              lastReason = 'judgment_ask_reply_did_not_answer';
              continue;
            }
            return {
              complete: true,
              completedAt: new Date(leadReply.timestamp).getTime(),
              aiMessageId: askBySuggestion.id ?? null,
              aiMessageIds: askBySuggestion.id ? [askBySuggestion.id] : [],
              leadMessageId: leadReply.id ?? null,
              sentAt: new Date(askBySuggestion.timestamp).toISOString(),
              reason: answered
                ? reAskCount >= 2
                  ? 'completed_by_judgment_ask_reply_antiloop'
                  : 'completed_by_judgment_ask_reply'
                : 'completed_by_judgment_ask_reply_antiloop_unanswered',
              selectedBranchLabel,
              selectedSuggestionId,
              historyMessagesWithSelectedSuggestionId
            };
          }
        }
      }

      lastReason =
        'wait_followed_by_runtime_judgment_requires_reclassification';
      continue;
    }

    const { asks, messages, waits } = waitableActionsForPath(actions);

    for (const action of [...asks, ...canonicalCandidates]) {
      const sent = findSetterMessageForContent(
        sorted,
        action.content,
        afterTimeMs
      );
      const leadReply = sent ? hasLeadReplyAfter(sorted, sent) : null;
      // F4/F3 gate (2026-07-22): an ASK step only completes on a reply that
      // actually answers it. A reply that is itself a question back ("how much
      // does this cost"), a pricing question, or an explicit deferral does NOT
      // complete the step and does NOT get bound as the step's answer — it
      // parks the position so the same ask is re-driven next turn.
      if (sent && leadReply && !replyAnswersAsk(leadReply.content)) {
        lastReason = 'ask_reply_did_not_answer';
        continue;
      }
      if (sent && leadReply) {
        return {
          complete: true,
          completedAt: new Date(leadReply.timestamp).getTime(),
          aiMessageId: sent.id ?? null,
          aiMessageIds: sent.id ? [sent.id] : [],
          leadMessageId: leadReply.id ?? null,
          sentAt: new Date(sent.timestamp).toISOString(),
          reason: 'completed_by_ask_reply',
          selectedBranchLabel,
          selectedSuggestionId,
          historyMessagesWithSelectedSuggestionId
        };
      }
      lastReason = sent
        ? 'ask_sent_but_no_lead_reply_after_it'
        : 'ask_message_not_found_in_history_after_cursor';
    }

    // Paraphrase-tolerant completion for ask steps (F5.1 fix, 2026-06-07).
    // The text-match loop above fails whenever the LLM PARAPHRASES the scripted
    // [ASK] (the common case) — the AI's wording won't equal the canonical
    // question, so `findSetterMessageForContent` returns null and the step
    // never completes, parking the position. This was the root cause of the
    // stuck-conversation bug (systemStage frozen while content advanced).
    //
    // Reliable, account-AGNOSTIC signal: this step has a recorded
    // `branch_selected` event with a `suggestionId`, AND the conversation
    // history contains the AI message carrying that exact suggestionId followed
    // by a lead reply. The suggestionId ties a sent bubble to the step that
    // generated it WITHOUT any text matching — so paraphrasing can't defeat it.
    // Only fires for ask/wait steps (this whole function is gated upstream by
    // stepHasHistoryCompletionSignal), so it can't over-complete passive steps.
    if (asks.length > 0) {
      // Try EVERY suggestionId this step has used (oldest first), not just the
      // latest. When the position is stuck the engine re-emits a fresh
      // branch_selected@step each turn; the latest points at the current turn's
      // bubble (no reply yet), but an EARLIER one's bubble does have a reply —
      // that's what completes the step and lets the walker finally advance.
      const candidateSuggestionIds = allSuggestionIdsForStep(
        points,
        step.stepNumber
      );
      // Fall back to the selected one if the per-step list is empty (legacy data).
      if (
        candidateSuggestionIds.length === 0 &&
        typeof selectedSuggestionId === 'string'
      ) {
        candidateSuggestionIds.push(selectedSuggestionId);
      }
      for (const candidateSid of candidateSuggestionIds) {
        const askBySuggestion =
          selectedSuggestionMessagesAfter(sorted, candidateSid, afterTimeMs).at(
            0
          ) ?? null;
        const leadReply = askBySuggestion
          ? hasLeadReplyAfter(sorted, askBySuggestion)
          : null;
        // F4/F3 gate (2026-07-22): same answer-satisfaction rule as the
        // text-match ASK path above — a pure question-back / deferral must not
        // complete the ask or bind its variable.
        if (
          askBySuggestion &&
          leadReply &&
          !replyAnswersAsk(leadReply.content)
        ) {
          lastReason = 'ask_reply_did_not_answer';
          continue;
        }
        if (askBySuggestion && leadReply) {
          return {
            complete: true,
            completedAt: new Date(leadReply.timestamp).getTime(),
            aiMessageId: askBySuggestion.id ?? null,
            aiMessageIds: askBySuggestion.id ? [askBySuggestion.id] : [],
            leadMessageId: leadReply.id ?? null,
            sentAt: new Date(askBySuggestion.timestamp).toISOString(),
            reason: 'completed_by_ask_reply_suggestion',
            selectedBranchLabel,
            selectedSuggestionId,
            historyMessagesWithSelectedSuggestionId
          };
        }
      }
    }

    if (asks.length === 0 && messages.length > 0 && waits.length) {
      const sentMessages =
        findSetterMessagesForActions(
          sorted,
          messages,
          afterTimeMs,
          selectedSuggestionId
        ) ??
        selectedSuggestionMessagesForActions(
          sorted,
          messages,
          selectedSuggestionId,
          afterTimeMs
        );
      const lastSent = sentMessages?.at(-1) ?? null;
      const leadReply = lastSent ? hasLeadReplyAfter(sorted, lastSent) : null;
      if (lastSent && leadReply) {
        return {
          complete: true,
          completedAt: new Date(leadReply.timestamp).getTime(),
          aiMessageId: lastSent.id ?? null,
          aiMessageIds:
            sentMessages
              ?.map((message) => message.id)
              .filter((id): id is string => !!id) ?? [],
          leadMessageId: leadReply.id ?? null,
          sentAt: new Date(lastSent.timestamp).toISOString(),
          reason: 'completed_by_message_wait_reply',
          selectedBranchLabel,
          selectedSuggestionId,
          historyMessagesWithSelectedSuggestionId
        };
      }
      lastReason = lastSent
        ? 'waitable_message_sent_but_no_lead_reply_after_it'
        : selectedSuggestionId
          ? 'waitable_message_not_found_for_selected_suggestion'
          : 'waitable_message_not_found_in_history_after_cursor';
    }

    const callProposalCompletion = callProposalCompletionFromHistory({
      step,
      history: sorted,
      afterTimeMs,
      selectedBranchLabel,
      selectedSuggestionId,
      historyMessagesWithSelectedSuggestionId
    });
    if (callProposalCompletion) {
      return callProposalCompletion;
    }
  }

  return incompleteStepCompletion(
    afterTimeMs,
    lastReason,
    selectedBranchLabel,
    selectedSuggestionId,
    historyMessagesWithSelectedSuggestionId
  );
}

function appendStepCompletedBranchHistoryEvent(
  points: CapturedDataPoints,
  step: ScriptStepWithRecovery,
  completion: StepCompletionResult
) {
  if (!completion.complete) return;
  const selectedBranchLabel = selectedBranchLabelForStep(
    points,
    step.stepNumber
  );
  const completedBranchLabel =
    completion.selectedBranchLabel ?? selectedBranchLabel;
  appendBranchHistoryEventToPoints(points, {
    eventType: 'step_completed',
    stepNumber: step.stepNumber,
    stepTitle: step.title ?? null,
    selectedBranchLabel: completedBranchLabel,
    suggestionId: null,
    aiMessageId: completion.aiMessageId,
    aiMessageIds: completion.aiMessageIds,
    leadMessageId: completion.leadMessageId,
    sentAt: completion.sentAt,
    completedAt: new Date(completion.completedAt).toISOString(),
    createdAt: new Date().toISOString(),
    stepCompletionAttempted: true,
    stepCompletionReason: completion.reason,
    previousSelectedBranch: completedBranchLabel,
    currentSelectedBranch: completedBranchLabel,
    selectedSuggestionId: completion.selectedSuggestionId,
    historyMessagesWithSelectedSuggestionId:
      completion.historyMessagesWithSelectedSuggestionId
  });
}

function writeStepCompletionTrace(
  points: CapturedDataPoints,
  trace: {
    stepNumber: number | null;
    stepTitle: string | null;
    stepCompletionAttempted: boolean;
    stepCompletionReason: string;
    previousSelectedBranch: string | null;
    currentSelectedBranch: string | null;
    selectedSuggestionId: string | null;
    historyMessagesWithSelectedSuggestionId: number | null;
    aiMessageId: string | null;
    leadMessageId: string | null;
  }
) {
  (points as Record<string, unknown>).lastStepCompletionTrace = {
    ...trace,
    timestamp: new Date().toISOString()
  };
}

function firstUrl(text: string | null | undefined): string | null {
  const match = (text || '').match(/\bhttps?:\/\/[^\s)]+/i);
  return match?.[0]?.replace(/[.,]+$/, '') ?? null;
}

function parseJsonObject(value: Prisma.JsonValue | null | undefined) {
  return asRecord(value ?? null);
}

function parseCapitalAmount(text: string): {
  amount: number;
  currencyExplicit: boolean;
} | null {
  const normalized = text.replace(/,/g, '');
  const match = normalized.match(
    /(?:\$|usd\s*)?(\d{1,7}(?:\.\d+)?)\s*(k|thousand|m|million)?\s*(usd|dollars?)?/i
  );
  if (!match) return null;
  let amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k' || suffix === 'thousand') amount *= 1000;
  if (suffix === 'm' || suffix === 'million') amount *= 1000000;
  const currencyExplicit = /\$|\busd\b|\bdollars?\b/i.test(match[0]);
  return { amount: Math.round(amount), currencyExplicit };
}

function hasPercentageSignal(text: string): boolean {
  return /\d\s*%|%\s*\d/.test(text);
}

function hasTradingContext(text: string): boolean {
  return /\b(tp|sl|take\s*profit|stop\s*loss|h[145]|m(?:5|15|30)|liquidity|previous\s+(?:hh|ll)|funded\s+account|payout|eur(?:usd|jpy|gbp)|gbp(?:usd|jpy)|usd(?:jpy|cad|chf)|aud(?:usd|jpy)|nzdusd|xauusd|btcusd|ethusd|pips?)\b/i.test(
    text
  );
}

function classifyCapitalReply(
  message: ScriptHistoryMessage,
  question: ScriptHistoryMessage,
  threshold: number | null
): {
  kind: 'amount' | 'affirmative' | 'disqualifier' | 'uncertain';
  amount: number | null;
  confidence: DataPointConfidence;
  method: string;
} | null {
  const text = message.content.trim();
  if (!text) return null;

  const uncertain =
    /\b(i\s+think\s+so|probably|kinda|kind\s+of|maybe|not\s+sure|i\s+can\s+get\s+it|should\s+be\s+able|working\s+on\s+it|close\s+to|not\s+yet)\b/i.test(
      text
    );
  if (uncertain) {
    return {
      kind: 'uncertain',
      amount: null,
      confidence: 'LOW',
      method: 'uncertain_capital_reply'
    };
  }

  if (
    hasExplicitCapitalConstraintSignal(text) ||
    /\b(broke|no\s+money|no\s+capital|don'?t\s+have\s+(it|money|capital|anything|much)|can'?t\s+afford|need\s+(capital|money)\s+first|lack\s+of\s+capital)\b/i.test(
      text
    )
  ) {
    return {
      kind: 'disqualifier',
      amount: 0,
      confidence: 'HIGH',
      method: 'capital_disqualifier'
    };
  }

  const parsedAmount = parseCapitalAmount(text);
  if (parsedAmount) {
    if (hasPercentageSignal(text)) return null;
    if (hasTradingContext(text)) return null;
    // Reject any message that contains words clearly NOT about personal
    // capital — prop-trader / eval / account-history phrasing. These
    // produced false-positive disqualifications for high-value leads
    // who happened to mention small numbers in trading-history context
    // (Peppe "5 funded accounts, 2 of 100k, one payout tomorrow",
    // Travis "blowing 23 evals... reach a payout"). The
    // hasTradingContext check above SHOULD catch most of these but
    // hasn't been bulletproof in production.
    if (
      /\b(eval|evals|blew|blown|blowing|lost|drawdown|account size|sizing)\b/i.test(
        text
      )
    ) {
      return null;
    }
    // Tega 2026-06-10: money framed as sitting IN a trading / forex / prop /
    // brokerage account is DEPLOYED, not liquid capital set aside to invest.
    // Mirror ai-engine's DEPLOYED_CAPITAL_PATTERN so the structured cache never
    // records capitalThresholdMet=true for "3000 in my forex account" — return
    // null (not captured) so the booking gate holds the lead in QUALIFYING and
    // the AI asks the liquid-vs-deployed clarifier. The withdrawable/set-aside
    // escape hatch ("pull it out", "set aside", "saved up") keeps legit answers.
    if (
      /\b(in|inside|sitting\s+in|tied\s+up\s+in|already\s+in|parked\s+in)\s+(?:my\s+|the\s+|a\s+|an\s+)?(forex|trading|broker(?:age)?|mt[45]|prop|funded|challenge|account|wallet|portfolio)\b/i.test(
        text
      ) &&
      !/\b(pull\s+(it|that)\s+out|withdraw|cash\s+(it\s+)?out|can\s+access|liquid|set\s+aside|saved\s+up)\b/i.test(
        text
      ) &&
      !/\b(plus|on\s+top\s+of|aside\s+from|separate\s+from)\b/i.test(text)
    ) {
      return null;
    }
    // Require explicit currency. Without "$X" / "X usd" / "X dollars",
    // a bare number in a free-form reply is too ambiguous to drive a
    // disqualification — let the AI keep asking. The caller can still
    // re-extract on a follow-up turn when the lead clarifies.
    if (!parsedAmount.currencyExplicit) return null;
    return {
      kind: 'amount',
      amount: parsedAmount.amount,
      confidence: 'HIGH',
      method: 'specific_amount_explicit_currency'
    };
  }

  const asksThreshold =
    /\bat\s+least\b/i.test(question.content) ||
    /\$\s*\d|\b\d{3,6}\s*(usd|dollars?)\b/i.test(question.content) ||
    (typeof threshold === 'number' &&
      new RegExp(`\\b${threshold}\\b`).test(
        question.content.replace(/,/g, '')
      ));
  if (
    asksThreshold &&
    /^(yes|yeah|yea|yep|yup|i\s+do|i\s+have|i'?ve\s+got|got\s+it|for\s+sure|sure|absolutely|definitely|ready|let'?s\s+go)\b/i.test(
      text
    )
  ) {
    return {
      kind: 'affirmative',
      amount: threshold,
      confidence: 'HIGH',
      method: 'binary_yes_at_threshold'
    };
  }

  return null;
}

export function hasExplicitCapitalConstraintSignal(text: string): boolean {
  return (
    /\bcapital\b.{0,30}\b(problem|issue|obstacle|holding|stopping|lack|don'?t have)\b/i.test(
      text
    ) ||
    /\b(lack of|no)\s+capital\b/i.test(text) ||
    /\bdon'?t\s+have\s+(any\s+)?capital\b/i.test(text) ||
    /\bneed\s+(to\s+(get|raise|build)\s+)?capital\s+first\b/i.test(text) ||
    /\bcapital\b.{0,20}\bknowledge\b/i.test(text)
  );
}

function extractCapitalDataPoints(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  threshold: number | null;
  durableStatus?: string | null;
  durableAmount?: number | null;
}) {
  const { points, history, threshold, durableStatus, durableAmount } = params;
  const messages = sortedHistory(history);
  let lastCapitalQuestion: ScriptHistoryMessage | null = null;
  let bestSignal:
    | (ReturnType<typeof classifyCapitalReply> & {
        message: ScriptHistoryMessage;
      })
    | null = null;

  for (const msg of messages) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      containsCapitalQuestion(msg.content)
    ) {
      lastCapitalQuestion = msg;
      continue;
    }

    if (msg.sender !== 'LEAD' || !lastCapitalQuestion) continue;
    const msgTs = new Date(msg.timestamp).getTime();
    const qTs = new Date(lastCapitalQuestion.timestamp).getTime();
    if (msgTs <= qTs) continue;

    const signal = classifyCapitalReply(msg, lastCapitalQuestion, threshold);
    if (!signal) continue;
    const candidate = { ...signal, message: msg };
    if (!bestSignal) {
      bestSignal = candidate;
      continue;
    }
    const rank = { amount: 4, disqualifier: 3, affirmative: 2, uncertain: 1 };
    const currentRank = rank[candidate.kind];
    const bestRank = rank[bestSignal.kind];
    if (
      currentRank > bestRank ||
      (currentRank === bestRank &&
        new Date(candidate.message.timestamp).getTime() >
          new Date(bestSignal.message.timestamp).getTime())
    ) {
      bestSignal = candidate;
    }
  }

  if (bestSignal) {
    if (bestSignal.kind === 'uncertain') {
      setPoint(
        points,
        'capitalAnswerType',
        bestSignal.method,
        bestSignal.confidence,
        bestSignal.message.id ?? null,
        bestSignal.method
      );
      return;
    }

    const amount =
      bestSignal.kind === 'affirmative'
        ? (threshold ?? bestSignal.amount ?? null)
        : bestSignal.amount;
    if (typeof amount === 'number') {
      const thresholdMet =
        typeof threshold === 'number' ? amount >= threshold : amount > 0;
      setPoint(
        points,
        'verifiedCapitalUsd',
        amount,
        bestSignal.confidence,
        bestSignal.message.id ?? null,
        bestSignal.method
      );
      setPoint(
        points,
        'capitalThresholdMet',
        thresholdMet,
        bestSignal.confidence,
        bestSignal.message.id ?? null,
        bestSignal.method
      );
      setPoint(
        points,
        'capitalAnswerType',
        bestSignal.method,
        bestSignal.confidence,
        bestSignal.message.id ?? null,
        bestSignal.method
      );
    }
    return;
  }

  if (
    durableStatus === 'VERIFIED_QUALIFIED' ||
    durableStatus === 'MANUALLY_OVERRIDDEN'
  ) {
    const amount = durableAmount ?? threshold ?? 0;
    setPoint(
      points,
      'verifiedCapitalUsd',
      amount,
      'HIGH',
      null,
      'durable_capital_state'
    );
    setPoint(
      points,
      'capitalThresholdMet',
      true,
      'HIGH',
      null,
      'durable_capital_state'
    );
  } else if (durableStatus === 'VERIFIED_UNQUALIFIED') {
    const hasExplicitUnqualifiedCapitalSignal = messages.some(
      (message) =>
        message.sender === 'LEAD' &&
        (hasExplicitCapitalConstraintSignal(message.content) ||
          /\b(no|zero|none)\s+(money|funds|cash|budget)\b/i.test(
            message.content
          ) ||
          /\b(can'?t|cannot)\s+afford\b/i.test(message.content) ||
          /\bdon'?t\s+have\s+(any\s+)?(money|funds|cash|budget)\b/i.test(
            message.content
          ))
    );

    if (durableAmount === null && !hasExplicitUnqualifiedCapitalSignal) {
      // Still enforce the downsell path — the DB status is authoritative.
      // Evasion-locked leads (capitalQAskedCount gate) have no explicit amount
      // but VERIFIED_UNQUALIFIED must still drive capitalThresholdMet=false.
      setPoint(
        points,
        'capitalThresholdMet',
        false,
        'HIGH',
        null,
        'durable_capital_state'
      );
      return;
    }

    setPoint(
      points,
      'verifiedCapitalUsd',
      durableAmount ?? 0,
      'HIGH',
      null,
      'durable_capital_state'
    );
    setPoint(
      points,
      'capitalThresholdMet',
      false,
      'HIGH',
      null,
      'durable_capital_state'
    );
  }
}

// Phase 7B (2026-06-09): synchronous volunteered-capital capture. Unlike
// extractCapitalDataPoints (which needs an AI capital question to anchor the
// answer), this scans EVERY lead message for an unsolicited capital statement
// ("i've got about 5k to put toward this") and persists verifiedCapitalUsd +
// capitalThresholdMet on the same turn. Guards (load-bearing — a false positive
// silently qualifies an unfunded lead):
//   • PASSIVE_CAPITAL_SIGNAL_PHRASES must match (positive capital frame)
//   • PASSIVE_NEGATIVE_CONTEXT must NOT match ("i lost 5k", "job pays", "made 5k")
//   • a numeric amount must parse
// Idempotent: skips if verifiedCapitalUsd is already set (the question-anchored
// path + durable state win). Uses the latest qualifying lead message.
function extractVolunteeredCapital(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  threshold: number | null;
}) {
  const { points, history, threshold } = params;
  // Don't override an existing capital capture (question-anchored / durable).
  if (points.verifiedCapitalUsd !== undefined) return;

  const messages = sortedHistory(history);
  let best: { amount: number; id: string | null; ts: number } | null = null;
  for (const msg of messages) {
    if (msg.sender !== 'LEAD') continue;
    const content = msg.content ?? '';
    const signalMatch = content.match(PASSIVE_CAPITAL_SIGNAL_PHRASES);
    if (!signalMatch) continue;
    if (PASSIVE_NEGATIVE_CONTEXT.test(content)) continue;
    // Deployed (non-liquid) capital is NOT volunteered investable capital.
    // "i've got 3000 in my forex account" reads as a positive capital signal
    // but the money is already deployed in a trading vehicle — skip it so the
    // lead is held for the liquid-vs-deployed clarifier instead of being
    // silently passive-qualified. Mirror ai-engine's DEPLOYED_CAPITAL_PATTERN.
    if (
      /\b(in|inside|sitting\s+in|tied\s+up\s+in|already\s+in|parked\s+in)\s+(?:my\s+|the\s+|a\s+|an\s+)?(forex|trading|broker(?:age)?|mt[45]|prop|funded|challenge|account|wallet|portfolio)\b/i.test(
        content
      ) &&
      !/\b(pull\s+(it|that)\s+out|withdraw|cash\s+(it\s+)?out|can\s+access|liquid|set\s+aside|saved\s+up)\b/i.test(
        content
      ) &&
      !/\b(plus|on\s+top\s+of|aside\s+from|separate\s+from)\b/i.test(content)
    ) {
      continue;
    }
    // Bundled-message guard (live prod 2026-06-09): a lead may state BOTH a
    // trading income goal and capital in one message ("want 15k a month, and
    // i've got 5k saved"). extractAmountUSD over the whole string grabs the
    // FIRST amount (the 15k goal) and mis-attributes it as capital. Scope the
    // amount to the CAPITAL CLAUSE — the text from the capital signal phrase
    // onward — so "5k saved" is read, not the earlier income-goal figure.
    const signalIdx = signalMatch.index ?? 0;
    const capitalClause = content.slice(signalIdx);
    // P0 (2026-07-26): clause-ONLY. The old `?? extractAmountUSD(content)`
    // fallback defeated the bundled-message guard above — when the capital
    // clause had no number ("I can spend more time with my family"), it fell
    // back to the WHOLE message and grabbed the income-goal figure. No amount
    // in the capital clause = no capital statement, full stop.
    const amount = extractAmountUSD(capitalClause);
    if (typeof amount !== 'number' || amount <= 0) continue;
    // Rate-vs-stock guard: "$10,000 a month" is an income RATE, not capital.
    // Checked on the text IMMEDIATELY AFTER the parsed amount (not the whole
    // clause) so "i've got 5k saved and want 10k a month" still binds the 5k.
    // Applies to ALL personas, not just low-ticket.
    const amountMatch = capitalClause.match(
      /\b\$?\s*(?:at\s+least\s+|need\s+|make\s+|earn\s+|around\s+|about\s+|roughly\s+|maybe\s+|like\s+|approximately\s+)?(\d+(?:[.,]\d+)?)\s*([km])?\b/i
    );
    const afterAmount = amountMatch
      ? capitalClause.slice((amountMatch.index ?? 0) + amountMatch[0].length)
      : '';
    if (
      /^\s*(?:usd\s*|dollars?\s*)?(?:(?:a|per|\/)\s*(?:month|mo|week|wk|year|yr)|monthly|weekly|yearly)\b/i.test(
        afterAmount
      )
    ) {
      continue;
    }
    const ts = new Date(msg.timestamp).getTime();
    if (!best || ts >= best.ts) {
      best = { amount, id: msg.id ?? null, ts };
    }
  }
  if (!best) return;

  const thresholdMet =
    typeof threshold === 'number' ? best.amount >= threshold : best.amount > 0;
  setPoint(
    points,
    'verifiedCapitalUsd',
    best.amount,
    'HIGH',
    best.id,
    'volunteered_capital_passive_sync'
  );
  setPoint(
    points,
    'capitalThresholdMet',
    thresholdMet,
    'HIGH',
    best.id,
    'volunteered_capital_passive_sync'
  );
  setPoint(
    points,
    'capitalAnswerType',
    'volunteered_capital_passive_sync',
    'HIGH',
    best.id,
    'volunteered_capital_passive_sync'
  );
}

function extractAffirmationAfterPrompt(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  field: string;
  promptPattern: RegExp;
  method: string;
}) {
  const { points, history, field, promptPattern, method } = params;
  let prompt: ScriptHistoryMessage | null = null;
  for (const msg of sortedHistory(history)) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      promptPattern.test(msg.content)
    ) {
      prompt = msg;
      continue;
    }
    if (!prompt || msg.sender !== 'LEAD') continue;
    if (
      new Date(msg.timestamp).getTime() <= new Date(prompt.timestamp).getTime()
    ) {
      continue;
    }
    if (
      /^(yes|yeah|yea|yep|yup|sure|bet|i'?m down|down|let'?s go|send it|drop it|sounds good)\b/i.test(
        msg.content.trim()
      )
    ) {
      setPoint(points, field, true, 'HIGH', msg.id ?? null, method);
    }
  }
}

function allScriptActions(script: ScriptWithRecovery | null) {
  if (!script) return [];
  return script.steps.flatMap((step) => [
    ...step.actions,
    ...step.branches.flatMap((branch) => branch.actions)
  ]);
}

type ScriptActionForArtifact = ReturnType<typeof allScriptActions>[number];

function actionArtifactText(action: ScriptActionForArtifact): string {
  const fieldText =
    action.form?.fields
      ?.map((field) => field.fieldValue || field.fieldLabel || '')
      .filter(Boolean)
      .join(' ') || '';
  return [action.content, action.linkUrl, action.linkLabel, fieldText]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function actionUrls(action: ScriptActionForArtifact): string[] {
  return [
    firstUrl(action.linkUrl),
    firstUrl(action.content),
    ...(action.form?.fields?.map((field) => firstUrl(field.fieldValue)) ?? [])
  ].filter(Boolean) as string[];
}

function scoreScriptArtifactUrl(
  artifactField: string | null | undefined,
  action: ScriptActionForArtifact,
  url: string
): number {
  const text = actionArtifactText(action);
  const lowerUrl = url.toLowerCase();

  if (artifactField === 'applicationFormUrl') {
    if (
      /typeform|application|form/.test(text) ||
      /typeform|form/.test(lowerUrl)
    ) {
      return 100;
    }
    return -1;
  }

  if (artifactField === 'downsellUrl') {
    if (/youtube|youtu\.be|typeform|zoom|thank-you|homework/.test(lowerUrl)) {
      return -1;
    }
    if (
      // Leak-audit 1-5: dropped "whop" and "session liquidity model" literals
      // (daetradez's downsell host/product). Generic commerce terms classify
      // a downsell URL for any tenant.
      /course|checkout|payment|purchase|module|self.?paced/.test(text) ||
      /checkout/.test(lowerUrl)
    ) {
      return 100;
    }
    return -1;
  }

  if (artifactField === 'fallbackContentUrl') {
    // Leak-audit 1-5: dropped "whop" literal; generic commerce/booking hosts.
    if (/checkout|typeform|zoom/.test(lowerUrl)) return -1;
    if (/youtube|youtu\.be|video|bootcamp|free/.test(text + ' ' + lowerUrl)) {
      return 100;
    }
    return -1;
  }

  if (artifactField === 'homeworkUrl') {
    if (
      /homework|pre.?call|thank-you-confirmation/.test(text + ' ' + lowerUrl)
    ) {
      return 100;
    }
    return -1;
  }

  return 1;
}

function resolveScriptArtifactUrl(params: {
  artifactField: string | null | undefined;
  step: ScriptStepWithRecovery | null;
  script: ScriptWithRecovery | null;
}): string | null {
  const stepActions = params.step
    ? [
        ...params.step.actions,
        ...params.step.branches.flatMap((branch) => branch.actions)
      ]
    : [];
  const seen = new Set<string>();
  const actions = [...stepActions, ...allScriptActions(params.script)].filter(
    (action) => {
      if (seen.has(action.id)) return false;
      seen.add(action.id);
      return true;
    }
  );

  const candidates = actions.flatMap((action) =>
    actionUrls(action).map((url) => ({
      url,
      score: scoreScriptArtifactUrl(params.artifactField, action, url),
      sortOrder: action.sortOrder
    }))
  );

  return (
    candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.sortOrder - b.sortOrder)[0]?.url ??
    null
  );
}

function resolveArtifactUrl(params: {
  artifactField: string | null | undefined;
  step: ScriptStepWithRecovery | null;
  script: ScriptWithRecovery | null;
  persona: PersonaForRecovery | null;
}): string | null {
  // Artifact delivery must use account-script records only. Persona config
  // and seed scripts may contain placeholders or stale URLs; the active
  // Script/ScriptAction rows are the operator-controlled source of truth.
  return resolveScriptArtifactUrl({
    artifactField: params.artifactField,
    step: params.step,
    script: params.script
  });
}

function extractArtifactDeliveryDataPoints(
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  script: ScriptWithRecovery | null,
  persona: PersonaForRecovery | null
) {
  const fields = ['applicationFormUrl', 'downsellUrl', 'fallbackContentUrl'];
  for (const field of fields) {
    const url = resolveArtifactUrl({
      artifactField: field,
      step: null,
      script,
      persona
    });
    if (!url) continue;
    const delivered = sortedHistory(history)
      .filter((m) => m.sender === 'AI' || m.sender === 'HUMAN')
      .find((m) => m.content.includes(url));
    if (delivered) {
      setPoint(
        points,
        `${field}_delivered`,
        true,
        'HIGH',
        delivered.id ?? null,
        'artifact_url_seen_in_setter_message'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step-progression data extractors (bug-30 — incomeGoal, monthlyIncome,
// workBackground, deepWhy not being captured because operator scripts may
// not have runtime_judgment {{variable}} bindings for every discovery step)
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN =
  /\b\$?\s*(?:at\s+least\s+|need\s+|make\s+|earn\s+|around\s+|about\s+|roughly\s+|maybe\s+|like\s+|approximately\s+)?(\d+(?:[.,]\d+)?)\s*([km])?\b/i;

/**
 * Extract a dollar/number amount from a string. Returns the canonical
 * dollar amount (k/m suffixes expanded) or null if no amount found.
 *   "$6k a month" → 6000
 *   "around 4k" → 4000
 *   "I make 7000" → 7000
 *   "at least 6k to replace my income" → 6000
 *   "5m" → 5000000
 */
export function extractAmountUSD(text: string): number | null {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(AMOUNT_PATTERN);
  if (!match) return null;
  const raw = match[1].replace(/,/g, '');
  const num = parseFloat(raw);
  if (!Number.isFinite(num)) return null;
  const suffix = match[2]?.toLowerCase();
  if (suffix === 'k') return Math.round(num * 1000);
  if (suffix === 'm') return Math.round(num * 1_000_000);
  return Math.round(num);
}

/**
 * Generic helper: find the most recent AI prompt matching `promptPattern`
 * and capture the LEAD's next message into the named field via the given
 * value extractor. Used for incomeGoal / monthlyIncome / workBackground
 * etc. when the operator script doesn't have a runtime_judgment with a
 * {{variable}} placeholder for the data point.
 */
function extractValueAfterPrompt<T>(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  steps?: ScriptStepWithRecovery[];
  field: string;
  promptPattern: RegExp;
  method: string;
  sourceStepNumberFallback?: number | null;
  parse: (leadContent: string) => T | null;
}) {
  const { points, history, steps, field, promptPattern, method, parse } =
    params;
  let prompt: ScriptHistoryMessage | null = null;
  for (const msg of sortedHistory(history)) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      promptPattern.test(msg.content)
    ) {
      prompt = msg;
      continue;
    }
    if (!prompt || msg.sender !== 'LEAD') continue;
    if (
      new Date(msg.timestamp).getTime() <= new Date(prompt.timestamp).getTime()
    ) {
      continue;
    }
    // F4/F6 (2026-07-23): the reply can PARSE a value yet be a non-answer — a
    // question-back that happens to contain a number ("how much do i need to
    // make 6k though?") would otherwise bind incomeGoal=6000 from a clarifying
    // question. Two guards: (1) the shared non-answer gate (deferral/pricing),
    // and (2) a stricter local interrogative check, because at this
    // prompt-anchored numeric bind site an INTERROGATIVE reply that contains a
    // number is almost always a clarifying question, not the answer — and the
    // shared gate's concrete-number shortcut would otherwise pass it. A terse
    // real answer ("6k", "2 years", "about 5k") is not interrogative and binds.
    const askContent = (msg.content ?? '').trim();
    const askCore = askContent
      .toLowerCase()
      .replace(/^(and|but|so|ok(ay)?|well|hmm+|bro|man)[\s,]+/i, '')
      .trim();
    const looksInterrogative =
      askContent.includes('?') ||
      /^(how|what|when|where|why|who|which|can|could|would|do|does|did|is|are|will|should|whats?|hows?)\b/i.test(
        askCore
      );
    if (looksInterrogative || !replyAnswersAsk(msg.content)) {
      continue;
    }
    const value = parse(msg.content);
    if (value !== null && value !== undefined && value !== '') {
      const inferredSourceStepNumber = steps?.length
        ? stepNumberForAskMessage(steps, prompt.content)
        : null;
      const fallbackSourceStepNumber = params.sourceStepNumberFallback ?? null;
      const hasFallbackSourceStep =
        fallbackSourceStepNumber !== null &&
        (steps?.some((step) => step.stepNumber === fallbackSourceStepNumber) ??
          false);
      const sourceStepNumber =
        field === 'incomeGoal' &&
        hasFallbackSourceStep &&
        fallbackSourceStepNumber !== null &&
        (inferredSourceStepNumber === null ||
          inferredSourceStepNumber < fallbackSourceStepNumber)
          ? fallbackSourceStepNumber
          : inferredSourceStepNumber;
      setPoint(points, field, value, 'HIGH', msg.id ?? null, method, {
        sourceFieldName: field,
        sourceStepNumber:
          sourceStepNumber ??
          (hasFallbackSourceStep ? fallbackSourceStepNumber : null),
        sourceQuestion: prompt.content
      });
      // After successful capture, reset prompt so we don't re-capture
      // from later messages — the FIRST lead reply after the prompt
      // is the canonical answer.
      prompt = null;
    }
  }
}

function extractDurationPhrase(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;

  const sinceMatch = normalized.match(/\bsince\s+((?:19|20)\d{2})\b/i);
  if (sinceMatch?.[1]) {
    return `since ${sinceMatch[1]}`;
  }

  // Handles: "3 years", "18 months", "a solid year", "a good year", "a couple
  // years", "a few years", "a year and a half". The "a <adjective> <unit>"
  // branch (Ali QA 2026-07-21: "a solid year" was silently dropped) treats an
  // article+adjective+unit as quantity 1. "and a half" is captured as a suffix.
  const durationMatch = normalized.match(
    /\b((?:about|around|roughly|almost|over|under|nearly|like|for)?\s*(?:(?:a|an)\s+(?:solid|good|whole)\s+(?:years?|yrs?|months?|mos?|weeks?|wks?|days?)|(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few|several)\s+(?:years?|yrs?|months?|mos?|weeks?|wks?|days?))(?:\s+and\s+a\s+half)?)\b/i
  );
  if (!durationMatch?.[1]) return null;

  // Rate guard (2026-07-26, Ali QA re-run, conv cms1omte60003l804es8z1g3t):
  // "$10,000 a month" / "10k a month" is an income RATE — the "a month" tail
  // must never bind as trading-experience duration. Same defect class as the
  // capital rate guard: a duration phrase immediately preceded by a money
  // amount is describing money-per-period, not time spent trading.
  const beforeDuration = normalized.slice(0, durationMatch.index ?? 0);
  if (
    /(\$\s*[\d,.]+\s*[km]?|\b\d[\d,.]*\s*[km]?)\s*(usd|dollars?)?\s*$/i.test(
      beforeDuration
    )
  ) {
    return null;
  }

  return durationMatch[1].replace(/\s+/g, ' ').trim();
}

function extractTradingExperienceDuration(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  script?: ScriptWithRecovery | null;
}) {
  extractValueAfterPrompt({
    ...params,
    steps: params.script?.steps ?? [],
    field: 'tradingExperienceDuration',
    method: 'duration_after_trading_experience_prompt',
    promptPattern:
      /\b(new\s+in\s+(?:the\s+)?markets?|been\s+(?:trading|in\s+(?:the\s+)?markets?)\s+for\s+a\s+while|how\s+long.{0,80}\b(trading|markets?|at\s+it)\b|what\s+got\s+you\s+interested.{0,40}\b(trading|markets?)\b)\b/i,
    parse: extractDurationPhrase
  });
}

/**
 * Extract incomeGoal from the lead's response to a Step 9 income-goal-
 * from-trading question. Patterns the AI typically uses:
 *   - "how much would you need to be making"
 *   - "how much money are you trying to make from trading"
 *   - "what are you tryna get to with trading"
 *   - "what would you want trading to bring you each month"
 *   - "what would you need from trading"
 */
function extractIncomeGoal(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  script?: ScriptWithRecovery | null;
}) {
  extractValueAfterPrompt({
    ...params,
    steps: params.script?.steps ?? [],
    field: 'incomeGoal',
    method: 'amount_after_step_9_prompt',
    sourceStepNumberFallback: 9,
    promptPattern:
      /\b(how\s+much\s+(would|do)\s+you\s+(need|want)\s+to\s+be\s+making|how\s+much\s+(money\s+)?(are\s+you|do\s+you)\s+(trying|wanting|hoping)\s+to\s+make.{0,40}\b(trading|markets?)\b|what\s+(are|do)\s+you\s+(?:(?:trying|wanting|hoping|looking)\s+to|tryna)\s+(get\s+to|make|hit|reach).{0,50}\b(trading|markets?)\b|what\s+would\s+you\s+want\s+trading\s+to\s+bring|if\s+trading.{0,80}how\s+much.{0,40}\bbring\b|how\s+much.{0,40}\bbring\s+in\s+monthly\b|how\s+much.{0,40}from\s+trading|trading\s+to\s+bring\s+you|need\s+from\s+trading|make\s+from\s+trading|replace\s+(it|my\s+(job|nursing|income))\s+fully)/i,
    parse: (content) => {
      const amount = extractAmountUSD(content);
      return amount !== null ? amount : null;
    }
  });
}

/**
 * Extract monthlyIncome (from JOB) from the lead's response to a Step 7
 * income question. Distinct from incomeGoal — Step 7 asks about CURRENT
 * job income, not goal from trading.
 */
function extractMonthlyIncomeFromJob(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  script?: ScriptWithRecovery | null;
}) {
  extractValueAfterPrompt({
    ...params,
    steps: params.script?.steps ?? [],
    field: 'monthlyIncome',
    method: 'amount_after_step_7_prompt',
    promptPattern:
      /\b(how\s+much\s+is\s+your\s+job\s+bringing\s+in|bringing\s+in\s+on\s+a\s+monthly|on\s+a\s+monthly\s+basis|monthly\s+income\s+looking|what'?s\s+your\s+monthly\s+income|how\s+much\s+(do\s+)?you\s+make\s+(monthly|per\s+month|a\s+month))/i,
    parse: (content) => {
      const amount = extractAmountUSD(content);
      return amount !== null ? amount : null;
    }
  });
}

/**
 * Extract workBackground (job title / type of work) from the lead's
 * response to a Step 5 "what do you do for work" question.
 */
function extractWorkBackground(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
}) {
  const { points, history } = params;
  const promptPattern =
    /\b(what\s+do\s+you\s+do\s+for\s+work|what'?s\s+your\s+(job|day\s+job)|how\s+do\s+you\s+make\s+(money|a\s+living)|what\s+is\s+it\s+you\s+do|what'?s\s+your\s+9.5)\b/i;
  let prompt: ScriptHistoryMessage | null = null;
  for (const msg of sortedHistory(history)) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      promptPattern.test(msg.content)
    ) {
      prompt = msg;
      continue;
    }
    if (!prompt || msg.sender !== 'LEAD') continue;
    if (
      new Date(msg.timestamp).getTime() <= new Date(prompt.timestamp).getTime()
    ) {
      continue;
    }
    // Keep the captured job as a brief noun phrase ("retail", not the
    // full sentence with tenure attached).
    const trimmed = parseWorkBackgroundPhrase(msg.content);
    if (trimmed && trimmed.length >= 2) {
      setPoint(
        points,
        'workBackground',
        trimmed,
        'HIGH',
        msg.id ?? null,
        'phrase_after_step_5_prompt',
        {
          sourceFieldName: 'workBackground',
          sourceStepNumber: 5,
          sourceQuestion: prompt.content
        }
      );
      prompt = null;
    }
  }
}

function parseExplicitWorkBackgroundDisclosure(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /\b(?:i\s+work(?:ing)?|i\s*'?m|i\s+am)\s+(?:as\s+an?\s+|as\s+|in\s+|at\s+|for\s+|an?\s+)?([^,.]+?)(?:\s*,|\s+been\b|\s+for\b|$)/i
  );
  if (!match?.[1]) return null;

  const phrase = match[1]
    .replace(/^(an?\s+|in\s+|at\s+|for\s+|the\s+|my\s+|a\s+job\s+in\s+)/i, '')
    .replace(/[.!,]+$/, '')
    .trim();

  if (
    !/\b(retail|sales|construction|nurs|engineer|teacher|driver|server|restaurant|warehouse|manager|student|school|business|self[-\s]?employed|job|work)\b/i.test(
      phrase
    )
  ) {
    return null;
  }

  return phrase.length >= 2 ? phrase.slice(0, 80) : null;
}

function extractExplicitWorkBackgroundDisclosures(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
}) {
  if (pointIsPresent(params.points, 'workBackground')) return;

  for (const msg of sortedHistory(params.history)) {
    if (msg.sender !== 'LEAD') continue;
    const value = parseExplicitWorkBackgroundDisclosure(msg.content);
    if (!value) continue;

    setPoint(
      params.points,
      'workBackground',
      value,
      'HIGH',
      msg.id ?? null,
      'explicit_work_background_disclosure',
      {
        sourceFieldName: 'workBackground',
        sourceStepNumber: 5,
        sourceQuestion: null
      }
    );
  }
}

/**
 * Extract replaceOrSupplement decision from the lead's response to a
 * Step 8 "replace or supplement" question.
 */
function extractReplaceOrSupplement(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
}) {
  const { points, history } = params;
  const promptPattern =
    /\b(replac(e|ing)\s+your\s+job|extra\s+income\s+on\s+the\s+side|supplement|replace.{0,30}\bor\b.{0,30}\bextra\b|fully\s+replace.{0,50}\bincome\b|replace.{0,50}\bincome.{0,50}\bstart\b|would\s+that\s+just\s+be\s+the\s+start)\b/i;
  let prompt: ScriptHistoryMessage | null = null;
  for (const msg of sortedHistory(history)) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      promptPattern.test(msg.content)
    ) {
      prompt = msg;
      continue;
    }
    if (!prompt || msg.sender !== 'LEAD') continue;
    if (
      new Date(msg.timestamp).getTime() <= new Date(prompt.timestamp).getTime()
    ) {
      continue;
    }
    const lower = msg.content.toLowerCase();
    let decision: 'replace' | 'supplement' | null = null;
    if (
      /\breplac(e|ing)\b|\bquit\b|\bleave\s+(my\s+)?job\b|\bfull[-\s]?time\b/i.test(
        lower
      )
    ) {
      decision = 'replace';
    } else if (
      /\bsupplement\b|\bextra\b|\bon\s+the\s+side\b|\bpart[-\s]?time\b|\bin\s+addition\b/i.test(
        lower
      )
    ) {
      decision = 'supplement';
    }
    if (decision) {
      setPoint(
        points,
        'replaceOrSupplement',
        decision,
        'HIGH',
        msg.id ?? null,
        'decision_after_step_8_prompt'
      );
      prompt = null;
    }
  }
}

// Patterns that signal a lead is stating a monthly income GOAL from trading,
// not their current job income.
// Live phrasings covered (Ali QA 2026-07-19): "my income goal is $2k/month",
// "My goal is to hit a consistent $3,500/month" — verb-less "goal is" forms,
// slash-month ("/month", "/mo") in the bare-$ alternative, and wider filler
// words ("a consistent", "an extra") between the verb and the amount.
const INCOME_GOAL_VOLUNTEERED_PATTERNS =
  /\b(need|want|make|earn|hit|reach|get\s+to|pull|bring\s+in)\s+(?:at\s+least\s+)?(?:(?:about|around|roughly|like|over|at\s+least|an?\s+(?:consistent|extra|steady|solid))\s*)?\$?[\d,]+(?:\.\d+)?k?\s*(?:a\s+month|per\s+month|monthly|\/\s*month|\/mo)\b|\$[\d,]+(?:\.\d+)?k?\s*(?:a\s+month|per\s+month|monthly|\/\s*month|\/mo)\b|\b(?:income\s+)?goal\s+is\s+(?:to\s+)?(?:\w+\s+){0,3}?\$?[\d,]+(?:\.\d+)?k?\s*(?:a\s+month|per\s+month|monthly|\/\s*month|\/mo)?\b|(?:a\s+month|per\s+month|monthly).{0,60}\b(?:goal|target|number|aim)\b/i;

// Patterns that signal a lead is stating their trading experience unprompted.
// Structure: a trading-verb anchor, then UP TO 8 words of instrument/filler
// ("forex and indices for about", "commodities and crypto"), then a duration
// core. The word-gap (Ali QA 2026-07-21) is why "I've been trading forex and
// indices for about a solid year" and "...commodities and crypto for about 3
// years" previously failed — the instrument name broke the old adjacency
// requirement. The trading-verb anchor is KEPT so unrelated durations
// ("a 9 to 5 job", "a year of college", "3 months to decide") stay excluded.
const TRADING_EXPERIENCE_VOLUNTEERED_PATTERNS =
  /\b(?:been\s+trading|i(?:'?ve|\s+have)\s+been\s+trading|been\s+in\s+(?:the\s+)?markets?|traded|trading|started\s+trading|at\s+it)\b(?:\s+\w+){0,8}?\s+(?:(?:about|around|roughly|almost|over|under|nearly|like|for)\s+)?(?:(?:a|an)\s+(?:solid|good|whole)\s+(?:years?|yrs?|months?|mos?)|(?:\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few|several)\s+(?:years?|yrs?|months?|mos?))(?:\s+and\s+a\s+half)?\b|\b\d+(?:\.\d+)?\s*(?:year|yr|month)\s+(?:trader|experience|veteran)\b|\btrading\s+since\s+(?:19|20)\d{2}\b/i;

/**
 * Anchor-free extraction of incomeGoal and tradingExperienceDuration from
 * any lead message, without requiring a prior AI scripted-ask as an anchor.
 * Called after all anchor-based extractors so it only fills fields still
 * missing (setPoint guards against overwriting HIGH-confidence existing data).
 */
function extractVolunteeredDiscoveryFields(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
}) {
  const { points, history } = params;
  const sorted = sortedHistory(history);

  for (const msg of sorted) {
    if (msg.sender !== 'LEAD') continue;
    const content = msg.content ?? '';

    // Run whenever there is no existing HIGH-confidence incomeGoal. A prior
    // LLM variable-resolution pass often sets a MEDIUM-confidence string
    // (e.g. "$2k") which does NOT satisfy the step-completion check
    // (recentPointForRequirement requires HIGH confidence). Upgrading it to a
    // HIGH numeric value extracted from the same lead message is what lets the
    // goal step auto-complete instead of re-firing the scripted question.
    const existingGoal = capturedPointForKey(points, 'incomeGoal');
    const needsHighConfidenceGoal =
      !existingGoal ||
      !capturedDataPointHasValue(existingGoal) ||
      existingGoal.confidence !== HIGH_CONFIDENCE;
    if (needsHighConfidenceGoal) {
      const goalMatch = INCOME_GOAL_VOLUNTEERED_PATTERNS.exec(content);
      if (goalMatch) {
        // Scope amount extraction to the income-goal clause (from the match
        // position onward) so earlier numbers (e.g. "3 years") don't get
        // mistakenly captured as the goal amount.
        const goalClause = content.slice(goalMatch.index);
        const amount = extractAmountUSD(goalClause);
        if (typeof amount === 'number' && amount > 0) {
          setPoint(
            points,
            'incomeGoal',
            amount,
            'HIGH',
            msg.id ?? null,
            'volunteered_incomeGoal_anchor_free'
          );
        }
      }
    }

    const existingDuration = capturedPointForKey(
      points,
      'tradingExperienceDuration'
    );
    const needsHighConfidenceDuration =
      !existingDuration ||
      !capturedDataPointHasValue(existingDuration) ||
      existingDuration.confidence !== HIGH_CONFIDENCE;
    if (needsHighConfidenceDuration) {
      if (TRADING_EXPERIENCE_VOLUNTEERED_PATTERNS.test(content)) {
        const duration = extractDurationPhrase(content);
        if (duration !== null) {
          setPoint(
            points,
            'tradingExperienceDuration',
            duration,
            'HIGH',
            msg.id ?? null,
            'volunteered_tradingExperienceDuration_anchor_free'
          );
        }
      }
    }
  }
}

function extractDataPoints(params: {
  existing: Prisma.JsonValue | null | undefined;
  history: ScriptHistoryMessage[];
  script: ScriptWithRecovery | null;
  persona: PersonaForRecovery | null;
  durableStatus?: string | null;
  durableAmount?: number | null;
}): CapturedDataPoints {
  const points = canonicalizeCapturedDataPointRecord({
    ...asRecord(params.existing)
  }) as CapturedDataPoints;
  const threshold = params.persona?.minimumCapitalRequired ?? null;

  // P0 (2026-07-26, Tega trace review): capital qualification machinery must
  // NOT run on personas that disable stage progression — their scripts have no
  // capital step, so there is nothing to verify and any capture is by
  // definition a false qualification. Live proof (Ahmed Shah,
  // cmrz6atll000ml70470dpk5dv): "my current income goal is around $10,000 a
  // month ... so I can spend more time with my family" minted
  // verifiedCapitalUsd=10000 / capitalThresholdMet=true at HIGH.
  const capitalMachineryDisabled =
    (params.persona?.promptConfig as Record<string, unknown> | null | undefined)
      ?.disableLeadStageProgression === true;

  if (!capitalMachineryDisabled) {
    extractCapitalDataPoints({
      points,
      history: params.history,
      threshold,
      durableStatus: params.durableStatus,
      durableAmount: params.durableAmount
    });
  }

  // Phase 7B (2026-06-09): capture VOLUNTEERED capital EVERY turn. The
  // question-anchored extractCapitalDataPoints above only fires when an AI
  // capital question preceded the answer. Leads frequently state capital
  // unsolicited mid-discovery ("i've got about 5k to put toward this"); without
  // this, verifiedCapitalUsd stays null until the LLM emits a high-intent stage
  // (the old async passive scan) — a chicken-and-egg that dead-ended the funnel.
  // Runs synchronously here so it's captured on the SAME turn the lead says it.
  if (!capitalMachineryDisabled) {
    extractVolunteeredCapital({ points, history: params.history, threshold });
  }

  extractAffirmationAfterPrompt({
    points,
    history: params.history,
    field: 'callInterestConfirmed',
    promptPattern:
      /\b(down|open|wanna|want|ready).{0,40}\b(call|chat|application|typeform)\b/i,
    method: 'affirmed_call_or_application_interest'
  });

  extractAffirmationAfterPrompt({
    points,
    history: params.history,
    field: 'downsellInterestConfirmed',
    // Leak-audit 1-5/7-1: dropped "whop" host + "497" price literals (both
    // daetradez-specific); generic downsell terms classify for any tenant.
    promptPattern: /\b(course|downsell|lower.ticket|self.paced)\b/i,
    method: 'affirmed_downsell_interest'
  });

  // Step-progression captures (bug-30): operator scripts may not have
  // runtime_judgment {{variable}} bindings for every discovery step.
  // These code-level extractors backfill the most common ones so the
  // call-proposal / capital-question / mandatory-ask gates have
  // accurate state.
  extractTradingExperienceDuration({
    points,
    history: params.history,
    script: params.script
  });
  extractWorkBackground({ points, history: params.history });
  extractExplicitWorkBackgroundDisclosures({
    points,
    history: params.history
  });
  extractMonthlyIncomeFromJob({
    points,
    history: params.history,
    script: params.script
  });
  extractReplaceOrSupplement({ points, history: params.history });
  extractIncomeGoal({
    points,
    history: params.history,
    script: params.script
  });
  extractVolunteeredDataForUpcomingAsks({
    points,
    history: params.history,
    script: params.script
  });
  // Anchor-free extraction: captures incomeGoal and tradingExperienceDuration
  // from ANY lead message regardless of whether the AI has already asked the
  // scripted question. Without this, when a lead packs experience + goal into
  // their opening message the anchor-based extractors above find no prior AI
  // ask to latch onto and leave these fields empty — causing the stage tracker
  // to re-fire the scripted question even though the data was already given.
  extractVolunteeredDiscoveryFields({ points, history: params.history });

  extractArtifactDeliveryDataPoints(
    points,
    params.history,
    params.script,
    params.persona
  );

  return points;
}

function bookingInfoFieldsFromPoints(
  points: CapturedDataPoints
): BookingInfoFields {
  return {
    fullName: pointValue<string>(points, 'fullName', false),
    email: pointValue<string>(points, 'email', false),
    phone: pointValue<string>(points, 'phone', false),
    timezone: pointValue<string>(points, 'timezone', false),
    dayAndTime: pointValue<string>(points, 'dayAndTime', false)
  };
}

function bookingInfoLeadMessageId(points: CapturedDataPoints): string | null {
  for (const field of BOOKING_INFO_FIELD_NAMES) {
    const point = points[field];
    if (isCapturedDataPoint(point) && point.extractedFromMessageId) {
      return point.extractedFromMessageId;
    }
  }
  return null;
}

function findBookingInfoRequestStep(params: {
  script: ScriptWithRecovery | null;
  promptContent: string;
}): ScriptStepWithRecovery | null {
  const steps = params.script?.steps ?? [];
  let fallback: ScriptStepWithRecovery | null = null;
  for (const step of steps) {
    const actions = [
      ...step.actions,
      ...step.branches.flatMap((branch) => branch.actions)
    ];
    for (const action of actions) {
      if (
        action.actionType !== 'send_message' &&
        action.actionType !== 'ask_question'
      ) {
        continue;
      }
      if (!isBookingInfoRequestText(action.content)) continue;
      fallback ??= step;
      if (actionContentMatches(action.content, params.promptContent)) {
        return step;
      }
    }
  }
  return fallback;
}

function findLatestBookingInfoReply(params: {
  history: ScriptHistoryMessage[];
  script: ScriptWithRecovery | null;
}): {
  prompt: ScriptHistoryMessage;
  leadReply: ScriptHistoryMessage;
  promptStep: ScriptStepWithRecovery | null;
} | null {
  const sorted = sortedHistory(params.history);
  const prompts = sorted.filter(
    (message) =>
      (message.sender === 'AI' || message.sender === 'HUMAN') &&
      isBookingInfoRequestText(message.content)
  );
  const prompt = prompts.at(-1) ?? null;
  if (!prompt) return null;
  const promptTime = new Date(prompt.timestamp).getTime();
  const leadReplies = sorted.filter(
    (message) =>
      message.sender === 'LEAD' &&
      new Date(message.timestamp).getTime() > promptTime
  );
  const leadReply = leadReplies.at(-1) ?? null;
  if (!leadReply) return null;
  return {
    prompt,
    leadReply,
    promptStep: findBookingInfoRequestStep({
      script: params.script,
      promptContent: prompt.content
    })
  };
}

function setBookingInfoDataPoints(params: {
  points: CapturedDataPoints;
  fields: BookingInfoFields;
  leadMessageId: string | null;
  method: string;
}) {
  for (const field of BOOKING_INFO_FIELD_NAMES) {
    const value = params.fields[field];
    if (!value) continue;
    setPoint(
      params.points,
      field,
      value,
      'HIGH',
      params.leadMessageId,
      params.method
    );
  }
}

function stepLooksLikeMissingBookingInfoFollowUp(
  step: ScriptStepWithRecovery
): boolean {
  const text = [
    step.title,
    ...step.actions.map((action) => action.content),
    ...step.branches.flatMap((branch) => [
      branch.branchLabel,
      branch.conditionDescription,
      ...branch.actions.map((action) => action.content)
    ])
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (!/\bmissing\b/.test(text)) return false;
  const fieldMentions = [
    /\b(full\s+name|name)\b/.test(text),
    /\bemail\b/.test(text),
    /\bphone\b/.test(text),
    /\b(timezone|time\s+zone)\b/.test(text),
    /\b(day\s+and\s+time|day\/time|best\s+time|time\s+works)\b/.test(text)
  ];
  return fieldMentions.filter(Boolean).length >= 3;
}

function bookingInfoSkipCompletion(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  afterTimeMs: number
): StepCompletionResult | null {
  if (!stepLooksLikeMissingBookingInfoFollowUp(step)) return null;
  if (!hasAllBookingInfoFields(bookingInfoFieldsFromPoints(points))) {
    return null;
  }

  const leadMessageId = bookingInfoLeadMessageId(points);
  const leadMessage =
    sortedHistory(history).find((message) => message.id === leadMessageId) ??
    null;
  const leadTime = leadMessage
    ? new Date(leadMessage.timestamp).getTime()
    : Date.now();
  const completedAt = Math.max(leadTime, afterTimeMs + 1);
  return {
    complete: true,
    completedAt,
    aiMessageId: null,
    aiMessageIds: [],
    leadMessageId,
    sentAt: null,
    reason: 'booking_info_complete_skip_missing_info_followup',
    selectedBranchLabel: selectedBranchLabelForStep(points, step.stepNumber),
    selectedSuggestionId: null,
    historyMessagesWithSelectedSuggestionId: null
  };
}

type CapturedDataRequirement = {
  key: string;
  aliases: string[];
};

type RecentCapturedDataPoint = {
  key: string;
  point: CapturedDataPoint;
  leadMessage: ScriptHistoryMessage;
  leadTime: number;
};

const DATA_REQUIREMENT_ALIASES: Record<string, string[]> = {
  tradingExperienceDuration: [
    'trading_experience_duration',
    'tradingExperience',
    'trading_experience',
    'marketExperience',
    'marketsExperience',
    'experienceDuration'
  ],
  tradingMotivation: [
    'trading_motivation',
    'marketMotivation',
    'marketsMotivation'
  ],
  workBackground: ['work_background', 'job', 'jobTitle', 'occupation'],
  workDuration: [
    'work_duration',
    'jobTenure',
    'job_tenure',
    'workTenure',
    'work_tenure',
    'jobDuration',
    'job_duration',
    'workExperienceDuration',
    'work_experience_duration',
    'tenureInYears',
    'tenure_in_years'
  ],
  monthlyIncome: ['monthly_income', 'jobIncome', 'currentIncome'],
  replaceOrSupplement: [
    'replace_or_supplement',
    'incomePlan',
    'jobReplacementIntent'
  ],
  incomeGoal: ['income_goal', 'desiredIncome', 'tradingIncomeGoal'],
  // F6/F3 (2026-07-23): deepWhy and desiredOutcome are DISTINCT captured
  // concepts (motivation vs tangible result) and must not satisfy each other's
  // requirement — collapsing them let one overwrite/stand-in for the other,
  // the recovery-side twin of the resolver variableAliases collapse. Keep only
  // deepWhy's own casing/underscore variants here.
  deepWhy: ['deep_why', 'goalReason', 'goal_reason'],
  desiredOutcome: ['desired_outcome'],
  obstacle: ['early_obstacle', 'earlyObstacle', 'mainObstacle'],
  capital: ['capitalAmount', 'capital_amount', 'availableCapital'],
  fullName: ['full_name', 'name'],
  email: ['emailAddress', 'email_address'],
  phone: ['phoneNumber', 'phone_number'],
  timezone: ['timeZone', 'time_zone'],
  dayAndTime: ['day_and_time', 'dayTime', 'preferredCallTime']
};

function dataRequirement(key: string): CapturedDataRequirement {
  return { key, aliases: DATA_REQUIREMENT_ALIASES[key] ?? [] };
}

function dedupeDataRequirements(
  requirements: CapturedDataRequirement[]
): CapturedDataRequirement[] {
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    if (seen.has(requirement.key)) return false;
    seen.add(requirement.key);
    return true;
  });
}

function dataRequirementsForAskContent(
  content: string | null | undefined
): CapturedDataRequirement[] {
  if (!content) return [];
  const text = content.toLowerCase();
  const requirements: CapturedDataRequirement[] = [];

  if (
    /\bhow\s+long\b.{0,80}\b(markets?|trading|trader|at\s+it)\b/i.test(
      content
    ) ||
    /\b(markets?|trading)\b.{0,80}\bhow\s+long\b/i.test(content) ||
    // The daetradez step-2 experience ask phrases it as "are you new in the
    // markets or have you been trading for a while?" — no "how long" at all.
    // Without this branch the step carries ZERO requirements, so a captured
    // tradingExperienceDuration can never auto-complete it and the bot
    // re-asks (Ali QA 2026-07-21, Hamza Ali + Ali Hamza). Mirror the anchor
    // promptPattern in extractTradingExperienceDuration.
    /\bnew\s+(?:to\s+trading|in\s+(?:the\s+)?markets?)\b/i.test(content) ||
    /\bbeen\s+(?:trading|in\s+(?:the\s+)?markets?)\s+for\s+a\s+while\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('tradingExperienceDuration'));
  }

  if (
    /\bwhat\s+got\s+you\s+interested\b.{0,50}\b(trading|markets?)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('tradingMotivation'));
  }

  if (
    /\b(what\s+do\s+you\s+do\s+for\s+work|what'?s\s+your\s+(job|day\s+job)|how\s+do\s+you\s+make\s+(money|a\s+living)|what\s+is\s+it\s+you\s+do|what'?s\s+your\s+9.5)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('workBackground'));
  }

  if (
    /\bhow\s+long\b.{0,60}\b(doing\s+that|been\s+(doing|working|at)|at\s+(that|your\s+job))\b/i.test(
      content
    ) &&
    !/\b(markets?|trading|trader)\b/i.test(content)
  ) {
    requirements.push(dataRequirement('workDuration'));
  }

  if (
    /\b(how\s+much\s+is\s+your\s+job\s+bringing\s+in|bringing\s+in\s+on\s+a\s+monthly|monthly\s+income|how\s+much\s+(do\s+)?you\s+make\s+(monthly|per\s+month|a\s+month)|what'?s\s+your\s+monthly\s+income)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('monthlyIncome'));
  }

  if (
    /\b(replac(e|ing)\s+your\s+job|supplement|extra\s+income|replace.{0,30}\bor.{0,30}extra|replace.{0,50}income)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('replaceOrSupplement'));
  }

  if (
    /\b(how\s+much\s+(would|do)\s+you\s+(need|want)\s+to\s+be\s+making|how\s+much\s+(you'?d|you\s+would)\s+need|is\s+that\s+how\s+much\s+you'?d\s+need|how\s+far\s+away\s+would\s+that\s+be|how\s+much\s+(money\s+)?(are\s+you|do\s+you)\s+(trying|wanting|hoping)\s+to\s+make.{0,50}(trading|markets?)|what\s+(are|do)\s+you\s+(trying|wanting|hoping|looking|tryna).{0,50}(trading|markets?)|from\s+trading|trading\s+to\s+bring)\b/i.test(
      content
    ) ||
    // "so what's the main goal you're chasing with trading right now?" — the
    // daetradez Goal Discovery step. Phrases the goal ask as "main goal /
    // what's your goal" rather than "how much"; still an incomeGoal ask, so a
    // volunteered income figure satisfies it and the step won't re-fire.
    /\b(main\s+goal|what'?s\s+your\s+goal|what\s+goal|goal\s+you'?re\s+(chasing|after|going\s+for)|what\s+are\s+you\s+(chasing|going\s+for|aiming\s+for))\b.{0,40}\b(trading|markets?|with\s+this)\b/i.test(
      content
    ) ||
    /\b(trading|markets?)\b.{0,40}\b(main\s+goal|what'?s\s+your\s+goal|goal\s+you'?re\s+(chasing|after))\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('incomeGoal'));
  }

  if (
    /\b(main\s+(thing|obstacle|struggle)|holding\s+you\s+back|stopping\s+you|what'?s\s+the\s+problem|what\s+are\s+you\s+struggling\s+with)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('obstacle'));
  }

  if (
    /\b(deep\s+why|deeper\s+why|why\s+(does|would|is)\s+this\s+(matter|important)|desired\s+outcome|what\s+would\s+that\s+do\s+for\s+you|why\s+do\s+you\s+want)\b/i.test(
      content
    )
  ) {
    requirements.push(dataRequirement('deepWhy'));
  }

  if (containsCapitalQuestion(content)) {
    requirements.push(dataRequirement('capital'));
  }

  if (/\bfull\s+name\b|\bfirst\s+and\s+last\b/.test(text)) {
    requirements.push(dataRequirement('fullName'));
  }
  if (/\bemail\b/.test(text)) {
    requirements.push(dataRequirement('email'));
  }
  if (/\b(phone(?:\s+number)?|cell|mobile)\b/.test(text)) {
    requirements.push(dataRequirement('phone'));
  }
  if (/\btime\s*zone\b|\btimezone\b/.test(text)) {
    requirements.push(dataRequirement('timezone'));
  }
  if (
    /\b(day\s+and\s+time|day\/time|best\s+time|what\s+time\s+works|when\s+works)\b/.test(
      text
    )
  ) {
    requirements.push(dataRequirement('dayAndTime'));
  }

  return dedupeDataRequirements(requirements);
}

function pointIsPresentForRequirement(
  points: CapturedDataPoints,
  requirement: CapturedDataRequirement
): boolean {
  return [requirement.key, ...requirement.aliases].some((key) =>
    pointIsPresent(points, key)
  );
}

function askActionsForStep(
  step: ScriptStepWithRecovery
): StepCompletionAction[] {
  return stepCompletionPaths(step).flatMap((path) =>
    path.actions.filter(
      (action) =>
        action.actionType === 'ask_question' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    )
  );
}

function stepNumberForAskMessage(
  steps: ScriptStepWithRecovery[],
  messageContent: string
): number | null {
  for (const step of steps) {
    if (
      askActionsForStep(step).some((action) =>
        actionContentMatches(action.content, messageContent)
      )
    ) {
      return step.stepNumber;
    }
  }
  return null;
}

function stepNumberForWaitablePromptMessage(
  steps: ScriptStepWithRecovery[],
  points: CapturedDataPoints,
  messageContent: string
): number | null {
  for (const step of steps) {
    const selectedBranchLabel = selectedBranchLabelForStep(
      points,
      step.stepNumber
    );
    const requirements = upcomingRequirementsAfterStep(steps, step.stepNumber);
    const canCaptureUpcomingData = requirements.length > 0;

    for (const actions of stepCompletionActionPaths(
      step,
      selectedBranchLabel
    )) {
      const { asks, messages, waits } = waitableActionsForPath(actions);
      if (asks.length > 0 || messages.length === 0 || waits.length === 0) {
        continue;
      }

      const explicitMessageMatch = messages.some((action) =>
        actionContentMatches(action.content, messageContent)
      );
      if (explicitMessageMatch) return step.stepNumber;

      const hasRuntimeMessageDirective = messages.some((action) =>
        contentIsRuntimePlaceholderOnly(action.content)
      );
      if (
        hasRuntimeMessageDirective &&
        canCaptureUpcomingData &&
        /\b(context|situation|work|job|doing\s+for\s+work|current\s+situation)\b/i.test(
          messageContent
        )
      ) {
        return step.stepNumber;
      }
    }
  }

  return null;
}

function stepNumberForPromptMessage(params: {
  steps: ScriptStepWithRecovery[];
  points: CapturedDataPoints;
  messageContent: string;
}): number | null {
  return (
    stepNumberForAskMessage(params.steps, params.messageContent) ??
    stepNumberForWaitablePromptMessage(
      params.steps,
      params.points,
      params.messageContent
    )
  );
}

function immediateLeadReplyAfterPrompt(
  messages: ScriptHistoryMessage[],
  promptIndex: number
): ScriptHistoryMessage | null {
  const prompt = messages[promptIndex];
  if (!prompt) return null;
  const promptTime = new Date(prompt.timestamp).getTime();

  for (let index = promptIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    const messageTime = new Date(message.timestamp).getTime();
    if (!Number.isFinite(messageTime) || messageTime <= promptTime) continue;
    if (message.sender === 'LEAD') return message;
    if (message.sender === 'AI' || message.sender === 'HUMAN') return null;
  }

  return null;
}

function upcomingRequirementsAfterStep(
  steps: ScriptStepWithRecovery[],
  stepNumber: number,
  // Phase 7A: widened from 3 → 10 so a lead who volunteers a qualifying value
  // (income goal / capital) many steps before its own ask is still captured —
  // the prod dead-end happened partly because the goal ask sits ~step 10 in the
  // DAE script, well outside a 3-step window. Safe to widen: the per-requirement
  // cue guard (hasRequirementSpecificVolunteeredCue), the different-amount-field
  // guard, and the income-goal immediate-next distance-gate prevent false
  // positives regardless of window size.
  lookahead = 10
): CapturedDataRequirement[] {
  const currentIndex = steps.findIndex(
    (step) => step.stepNumber === stepNumber
  );
  if (currentIndex < 0) return [];

  return dedupeDataRequirements(
    steps
      .slice(currentIndex + 1, currentIndex + 1 + lookahead)
      .flatMap((step) =>
        askActionsForStep(step).flatMap((action) =>
          dataRequirementsForAskContent(action.content)
        )
      )
  );
}

// Phase 7A helpers: locate the step that OWNS the income-goal ask, and the next
// ask-bearing step after a given step — used by the distance-gate that decides
// whether a volunteered income goal may be pre-captured (only when its own ask
// is NOT the immediate next step).
function stepAsksForRequirement(
  step: ScriptStepWithRecovery,
  key: string
): boolean {
  return askActionsForStep(step).some((action) =>
    dataRequirementsForAskContent(action.content).some((r) => r.key === key)
  );
}

function incomeGoalAskStepNumber(
  steps: ScriptStepWithRecovery[]
): number | null {
  const step = steps.find((s) => stepAsksForRequirement(s, 'incomeGoal'));
  return step?.stepNumber ?? null;
}

function nextAskStepNumberAfter(
  steps: ScriptStepWithRecovery[],
  stepNumber: number
): number | null {
  const currentIndex = steps.findIndex((s) => s.stepNumber === stepNumber);
  if (currentIndex < 0) return null;
  for (let i = currentIndex + 1; i < steps.length; i += 1) {
    if (askActionsForStep(steps[i]).length > 0) return steps[i].stepNumber;
  }
  return null;
}

// ── F5.1 Phase 8.1: SCRIPT-DERIVED call-proposal prerequisites ──────────────
// The platform is script-driven, so the "what must be captured before the AI
// can propose the call" gate must come from the ACCOUNT'S OWN script — not the
// hardcoded daetradez 8. We walk each ask-bearing step BEFORE the call-proposal
// step, map its [ASK] to the captured-data key(s) it gathers, and emit a
// CallProposalPrereq with a stable id that prereqSatisfiedByCapturedState
// already understands. A non-DAE script (e.g. goal→commit→book) yields only its
// own asks; a script with no discovery asks yields [] (booking reachable fast).

// Map a discovery data-requirement key → the prereq id + acceptableKeys that
// prereqSatisfiedByCapturedState keys off. Only keys that represent a genuine
// pre-booking discovery datapoint are included (booking-info keys like email /
// dayAndTime are collected AT booking, not prerequisites for proposing it).
const REQUIREMENT_TO_PREREQ: Record<
  string,
  { id: string; label: string; acceptableKeys: string[] }
> = {
  workBackground: {
    id: 'work_background',
    label: "lead's job / current work situation",
    acceptableKeys: ['workBackground', 'work_background', 'job']
  },
  monthlyIncome: {
    id: 'monthly_income',
    label: "lead's monthly income (or explicit skip)",
    acceptableKeys: [
      'monthlyIncome',
      'monthly_income',
      'incomeMonthly',
      'monthlyIncomeSkipped',
      'monthly_income_skipped'
    ]
  },
  replaceOrSupplement: {
    id: 'replace_or_supplement',
    label: 'whether trading is meant to replace the job or supplement it',
    acceptableKeys: ['replaceOrSupplement', 'replace_or_supplement']
  },
  incomeGoal: {
    id: 'income_goal',
    label: "lead's monthly income goal from trading",
    acceptableKeys: ['incomeGoal', 'income_goal']
  },
  deepWhy: {
    id: 'desired_outcome_or_deep_why',
    label: "lead's deeper why / desired outcome",
    acceptableKeys: ['desiredOutcome', 'desired_outcome', 'deepWhy', 'deep_why']
  },
  obstacle: {
    id: 'obstacle',
    label: "lead's main obstacle",
    acceptableKeys: ['obstacle', 'early_obstacle', 'earlyObstacle']
  }
};

/**
 * Derive the call-proposal prerequisites from an account's own script. Returns
 * a CallProposalPrereq[] (same shape as the hardcoded DAE list) so the gate can
 * use it interchangeably. Empty array ⇒ the script has no pre-booking discovery
 * asks ⇒ booking is reachable as soon as the proposal fires.
 */
export function deriveCallProposalPrereqs(
  script:
    | { steps?: ScriptStepWithRecovery[] | null }
    | ScriptWithRecovery
    | null
    | undefined
): CallProposalPrereq[] {
  const steps = script?.steps ?? [];
  if (steps.length === 0) return [];

  const proposalStep = steps.find((s) => isCallProposalStep(s));
  const cutoff = proposalStep?.stepNumber ?? Number.POSITIVE_INFINITY;

  const prereqs: CallProposalPrereq[] = [];
  const seenIds = new Set<string>();

  for (const step of steps) {
    if (step.stepNumber >= cutoff) continue;

    // (a) ask-derived discovery prereqs (work / income / income_goal / etc.)
    const asks = askActionsForStep(step);
    if (asks.length > 0) {
      const reqs = dedupeDataRequirements(
        asks.flatMap((a) => dataRequirementsForAskContent(a.content))
      );
      for (const req of reqs) {
        const mapped = REQUIREMENT_TO_PREREQ[req.key];
        if (!mapped || seenIds.has(mapped.id)) continue;
        seenIds.add(mapped.id);
        prereqs.push({
          id: mapped.id,
          label: mapped.label,
          stepNumber: step.stepNumber,
          acceptableKeys: mapped.acceptableKeys
        });
      }
    }

    // (b) structural prereqs detected by step key/title (their ask text isn't a
    // data-shaped pattern dataRequirementsForAskContent recognizes). deep_why is
    // a lead-volunteerable datapoint; belief_break / buy_in are AI-DELIVERED
    // gates satisfied via branch-history (handled in prereqSatisfiedByCapturedState).
    const key = normalizedStepKey(step);
    if (
      !seenIds.has('desired_outcome_or_deep_why') &&
      /(DEEP_WHY|DESIRED_OUTCOME)/.test(key)
    ) {
      seenIds.add('desired_outcome_or_deep_why');
      prereqs.push({
        id: 'desired_outcome_or_deep_why',
        label: "lead's deeper why / desired outcome",
        stepNumber: step.stepNumber,
        acceptableKeys: [
          'desiredOutcome',
          'desired_outcome',
          'deepWhy',
          'deep_why'
        ]
      });
    }
    if (
      !seenIds.has('belief_break_delivered') &&
      /(BELIEF|REFRAME)/.test(key)
    ) {
      seenIds.add('belief_break_delivered');
      prereqs.push({
        id: 'belief_break_delivered',
        label: 'belief-break / reframe message delivered',
        stepNumber: step.stepNumber,
        acceptableKeys: ['beliefBreakDelivered', 'belief_break_delivered']
      });
    }
    if (!seenIds.has('buy_in_confirmed') && /(BUY_?IN|BUY\s?IN)/.test(key)) {
      seenIds.add('buy_in_confirmed');
      prereqs.push({
        id: 'buy_in_confirmed',
        label: 'buy-in confirmed',
        stepNumber: step.stepNumber,
        acceptableKeys: ['buyInConfirmed', 'buy_in_confirmed']
      });
    }
  }

  return prereqs.sort((a, b) => a.stepNumber - b.stepNumber);
}

const AMOUNT_DATA_REQUIREMENT_KEYS = new Set([
  'monthlyIncome',
  'incomeGoal',
  'capital'
]);

function requirementListContainsKey(
  requirements: CapturedDataRequirement[],
  key: string
): boolean {
  return requirements.some((requirement) => requirement.key === key);
}

function currentPromptAsksForDifferentAmountField(params: {
  currentRequirements: CapturedDataRequirement[];
  requirementKey: string;
}): boolean {
  if (!AMOUNT_DATA_REQUIREMENT_KEYS.has(params.requirementKey)) return false;
  return params.currentRequirements.some(
    (requirement) =>
      requirement.key !== params.requirementKey &&
      AMOUNT_DATA_REQUIREMENT_KEYS.has(requirement.key)
  );
}

function hasAmountDisclosureContext(content: string): boolean {
  return (
    /\$/.test(content) ||
    /\b\d+(?:[.,]\d+)?\s*[km]\b/i.test(content) ||
    /\b(income|monthly|month|salary|make|earn|bringing|bring\s+in|capital|saved|set\s+aside|funds?|cash|budget|goal|want|need|from\s+trading|per\s+month|a\s+month)\b/i.test(
      content
    )
  );
}

function hasRequirementSpecificVolunteeredCue(
  requirementKey: string,
  content: string
): boolean {
  switch (requirementKey) {
    case 'monthlyIncome':
      return /\b(job|work|salary|current(?:ly)?|right\s+now|monthly\s+income|bringing|bring\s+in|make\s+(?:at\s+work|from\s+(?:my\s+)?job)|per\s+month|a\s+month|monthly)\b/i.test(
        content
      );
    case 'incomeGoal':
      return /\b(goal|target|want|need|trying|hoping|looking|tryna|would\s+like|from\s+trading|trading\s+to\s+bring|make\s+from\s+trading|replace\s+(?:it|my\s+(?:job|income))|want\s+trading|need\s+trading)\b/i.test(
        content
      );
    case 'capital':
      return /\b(capital|saved|set\s+aside|funds?|cash|budget|invest|investment|start\s+with|account\s+size|ready\s+to\s+start)\b/i.test(
        content
      );
    // F6 (2026-07-25, Tega run-2): prose requirements used to fall through to
    // `default: true` — ANY keyword-bearing volunteered clause bound to
    // whichever prose slot the upcoming step needed. Run-2 proof:
    // deep_why="leave my job" (that is LIFE-IMPACT language, not motivation).
    // Each prose slot now requires its OWN semantic cue, so "leave my job"
    // volunteers into life impact and "tired of trading time for money /
    // want to be free" into deep why — never cross-bound.
    case 'deepWhy':
    case 'deep_why':
      return /\b(because|tired\s+of|sick\s+of|hate|fed\s+up|freedom|be\s+free|matters?\s+to\s+me|reason|driving|done\s+with|why\s+i)\b/i.test(
        content
      );
    case 'lifeImpact':
    case 'life_impact':
      return /\b(quit|leave|leaving)\s+(my\s+)?(job|9.?5|nine.?to.?five)\b|\bfire\s+my\s+boss\b|\b(more\s+)?time\s+with\b|\bfamily|kids?|daughter|son|wife|husband\b|\btravel\b|\bday\s+to\s+day\b|\bbe\s+around\b|\bfull.?time\b/i.test(
        content
      );
    case 'obstacle':
      return /\b(struggl|stuck|blow(n|ing)?\s+(my\s+)?account|inconsisten|problem|holding\s+(me\s+)?back|keep\s+(losing|giving|blowing)|give\s+it\s+(all\s+)?back|revenge\s+trad|no\s+(real\s+)?(system|structure|plan)|wing(ing)?\s+it)\b/i.test(
        content
      );
    default:
      return true;
  }
}

function shouldExtractVolunteeredRequirement(params: {
  requirement: CapturedDataRequirement;
  currentRequirements: CapturedDataRequirement[];
  leadReplyContent: string;
  incomeGoalIsImmediateNext?: boolean;
}): boolean {
  if (
    requirementListContainsKey(
      params.currentRequirements,
      params.requirement.key
    )
  ) {
    return true;
  }

  // Target-income field is semantically tied to its own script question.
  // Phase 7A distance-gate: if the income-goal ask is the IMMEDIATE next step,
  // a money answer here is almost certainly the current/replace answer (or the
  // lead pre-empting the very next ask) — keep it blocked so the dedicated ask
  // fires and owns the capture (protects bug-58 / bug-53). But if the income-goal
  // ask is SEVERAL steps ahead, a clearly-cued volunteered goal ("15k a month
  // FROM TRADING", "want trading to replace…") should be captured rather than
  // dropped — otherwise the funnel dead-ends (the prod incident). Fall through to
  // the same cue + different-amount-field guards the other amount fields use.
  if (params.requirement.key === 'incomeGoal') {
    // Immediate-next (or unknown distance) → conservative: don't pre-capture,
    // let the dedicated income-goal ask fire (bug-58/bug-53 stay green).
    if (params.incomeGoalIsImmediateNext !== false) {
      return false;
    }
    // Income-goal ask is several steps ahead → capture a clearly-cued goal,
    // but never let a different amount field's answer satisfy it.
    if (
      currentPromptAsksForDifferentAmountField({
        currentRequirements: params.currentRequirements,
        requirementKey: params.requirement.key
      })
    ) {
      return false;
    }
    return hasRequirementSpecificVolunteeredCue(
      params.requirement.key,
      params.leadReplyContent
    );
  }

  if (!AMOUNT_DATA_REQUIREMENT_KEYS.has(params.requirement.key)) {
    return true;
  }

  if (
    currentPromptAsksForDifferentAmountField({
      currentRequirements: params.currentRequirements,
      requirementKey: params.requirement.key
    })
  ) {
    return false;
  }

  return hasRequirementSpecificVolunteeredCue(
    params.requirement.key,
    params.leadReplyContent
  );
}

function parseReplaceOrSupplementDecision(
  content: string
): 'replace' | 'supplement' | null {
  const lower = content.toLowerCase();
  if (
    /\breplac(e|ing)\b|\bquit\b|\bleave\s+(my\s+)?job\b|\bfull[-\s]?time\b/i.test(
      lower
    )
  ) {
    return 'replace';
  }
  if (
    /\bsupplement\b|\bextra\b|\bon\s+the\s+side\b|\bpart[-\s]?time\b|\bin\s+addition\b/i.test(
      lower
    )
  ) {
    return 'supplement';
  }
  return null;
}

function parseWorkBackgroundPhrase(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (
    !/\b(work|job|retail|sales|construction|nurs|engineer|teacher|driver|server|restaurant|warehouse|manager|student|school|business|self[-\s]?employed)\b/i.test(
      trimmed
    )
  ) {
    return null;
  }

  const match = trimmed.match(
    /\b(?:i\s+)?(?:work(?:ing)?|am|i'm)\s+(?:as\s+an?\s+|as\s+|in\s+|at\s+|for\s+)?([^,.]+?)(?:\s*,|\s+been\b|\s+for\b|$)/i
  );
  const phrase = (match?.[1] ?? trimmed)
    .replace(/^(an?\s+|in\s+|at\s+|for\s+|the\s+|my\s+|a\s+job\s+in\s+)/i, '')
    .replace(/[.!,]+$/, '')
    .trim();

  return phrase.length >= 2 ? phrase.slice(0, 80) : null;
}

function parseVolunteeredRequirementValue(
  requirementKey: string,
  content: string
): unknown | null {
  switch (requirementKey) {
    case 'tradingExperienceDuration':
    case 'workDuration':
      return extractDurationPhrase(content);
    case 'incomeGoal': {
      if (!hasAmountDisclosureContext(content)) return null;
      // Scope to the income-goal clause so a leading unrelated number
      // (e.g. "3 years") isn't mis-read as the goal. "been trading 3 years,
      // want an extra $2k a month" must yield 2000, not 3. Falls back to the
      // whole-message scan when no goal-clause pattern is present.
      const goalMatch = INCOME_GOAL_VOLUNTEERED_PATTERNS.exec(content);
      const scoped = goalMatch ? content.slice(goalMatch.index) : content;
      return extractAmountUSD(scoped);
    }
    case 'monthlyIncome':
    case 'capital': {
      if (!hasAmountDisclosureContext(content)) return null;
      return extractAmountUSD(content);
    }
    case 'replaceOrSupplement':
      return parseReplaceOrSupplementDecision(content);
    case 'workBackground':
      return parseWorkBackgroundPhrase(content);
    case 'obstacle': {
      const trimmed = content.trim();
      if (
        trimmed.length >= 12 &&
        /\b(struggl|problem|issue|hard|stuck|holding|stopping|revenge|loss|lose|lost|emotion|discipline|fear|greed|confidence)\b/i.test(
          trimmed
        )
      ) {
        return trimmed.slice(0, 500);
      }
      return null;
    }
    case 'deepWhy': {
      const trimmed = content.trim();
      if (
        trimmed.length >= 12 &&
        /\b(because|so\s+i\s+can|so\s+that|want|need|family|wife|kids?|children|freedom|quit|provide|matter|important|goal|life|future)\b/i.test(
          trimmed
        )
      ) {
        return trimmed.slice(0, 500);
      }
      return null;
    }
    default:
      return null;
  }
}

function extractVolunteeredDataForUpcomingAsks(params: {
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  script: ScriptWithRecovery | null;
}) {
  const steps = params.script?.steps ?? [];
  if (steps.length === 0) return;

  const messages = sortedHistory(params.history);
  for (let index = 0; index < messages.length; index += 1) {
    const prompt = messages[index];
    if (prompt.sender !== 'AI' && prompt.sender !== 'HUMAN') continue;

    const stepNumber = stepNumberForPromptMessage({
      steps,
      points: params.points,
      messageContent: prompt.content
    });
    if (!stepNumber) continue;

    const leadReply = immediateLeadReplyAfterPrompt(messages, index);
    if (!leadReply) continue;

    const currentRequirements = dataRequirementsForAskContent(prompt.content);
    const requirements = upcomingRequirementsAfterStep(steps, stepNumber);
    // Phase 7A: the script step that OWNS the income-goal ask, and whether it is
    // the IMMEDIATE next step after the current prompt. bug-58 requires that a
    // money answer given when the income-goal ask is the very next step must NOT
    // pre-capture incomeGoal (the dedicated ask should fire). But when that ask
    // is several steps ahead (the prod dead-end), a clearly-cued volunteered
    // goal SHOULD be captured so the funnel isn't blocked.
    const incomeGoalOwnStep = incomeGoalAskStepNumber(steps);
    const incomeGoalIsImmediateNext =
      typeof incomeGoalOwnStep === 'number' &&
      incomeGoalOwnStep === nextAskStepNumberAfter(steps, stepNumber);
    for (const requirement of requirements) {
      if (pointIsPresentForRequirement(params.points, requirement)) continue;
      if (
        !shouldExtractVolunteeredRequirement({
          requirement,
          currentRequirements,
          leadReplyContent: leadReply.content,
          incomeGoalIsImmediateNext
        })
      ) {
        continue;
      }

      const value = parseVolunteeredRequirementValue(
        requirement.key,
        leadReply.content
      );
      if (value === null || value === undefined || value === '') continue;

      // Phase 7A: stamp incomeGoal with its OWN-ask step so checkCallProposalPrereqs
      // (which matches incomeGoal by its source step) recognizes the volunteered
      // capture. Other requirements keep the prompt's step as source.
      const sourceStep =
        requirement.key === 'incomeGoal' &&
        typeof incomeGoalOwnStep === 'number'
          ? incomeGoalOwnStep
          : stepNumber;
      setPoint(
        params.points,
        requirement.key,
        value,
        'HIGH',
        leadReply.id ?? null,
        `volunteered_${requirement.key}_for_upcoming_ask`,
        {
          sourceFieldName: requirement.key,
          sourceStepNumber: sourceStep,
          sourceQuestion: prompt.content
        }
      );
    }
  }
}

function capturedDataPointHasValue(point: CapturedDataPoint): boolean {
  const value = point.value;
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value === true;
  return Boolean(value);
}

function capturedDataPointNumericValue(
  point: CapturedDataPoint
): number | null {
  const value = point.value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return extractAmountUSD(value);
  return null;
}

function pointCanSatisfyRequirementForStep(params: {
  point: CapturedDataPoint;
  requirement: CapturedDataRequirement;
  stepNumber: number;
}): boolean {
  if (params.requirement.key !== 'incomeGoal') return true;
  // Anchor-free extraction (extractVolunteeredDiscoveryFields) captures the
  // income goal from a lead message the LEAD volunteered before any scripted
  // ask, so it has no sourceStepNumber to match against. Trust it to satisfy
  // ANY income-goal step as long as it carries a numeric value — this is what
  // lets a packed opening message ("3 years in, want an extra $2k a month")
  // auto-complete the goal step instead of re-firing the scripted question.
  if (params.point.extractionMethod === 'volunteered_incomeGoal_anchor_free') {
    return capturedDataPointNumericValue(params.point) !== null;
  }
  if (params.point.sourceStepNumber !== params.stepNumber) return false;
  return capturedDataPointNumericValue(params.point) !== null;
}

function recentPointForRequirement(params: {
  requirement: CapturedDataRequirement;
  stepNumber: number;
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  afterTimeMs: number;
}): RecentCapturedDataPoint | null {
  const sorted = sortedHistory(params.history);
  const keys = [params.requirement.key, ...params.requirement.aliases];
  const matches: RecentCapturedDataPoint[] = [];

  const seenKeys = new Set<string>();
  for (const key of keys) {
    const normalizedKey = canonicalCapturedDataPointKey(key);
    if (seenKeys.has(normalizedKey)) continue;
    seenKeys.add(normalizedKey);
    const point = capturedPointForKey(params.points, key);
    if (
      !isCapturedDataPoint(point) ||
      point.confidence !== HIGH_CONFIDENCE ||
      !capturedDataPointHasValue(point) ||
      !point.extractedFromMessageId
    ) {
      continue;
    }

    const leadMessage =
      sorted.find(
        (message) =>
          message.id === point.extractedFromMessageId &&
          message.sender === 'LEAD'
      ) ?? null;
    if (!leadMessage) continue;
    const leadTime = new Date(leadMessage.timestamp).getTime();
    // Volunteered points are CURSOR-EXEMPT (Ahmed Shah 2026-07-18): a fact
    // the lead volunteered does not expire because an unrelated step was
    // asked and answered in between. Previously only a 1ms same-turn chain
    // was tolerated, so "packed opener → legitimately-asked step → goal
    // step" rejected the opener-extracted goal as too old and re-fired the
    // scripted goal question. Anchored (non-volunteered) points keep the
    // temporal gate — those are answers to specific asks and must not
    // satisfy a REVISITED step from a prior loop.
    const isVolunteeredPoint = /^volunteered_/.test(point.extractionMethod);
    if (
      !Number.isFinite(leadTime) ||
      (leadTime < params.afterTimeMs && !isVolunteeredPoint)
    ) {
      continue;
    }
    if (
      !pointCanSatisfyRequirementForStep({
        point,
        requirement: params.requirement,
        stepNumber: params.stepNumber
      })
    ) {
      continue;
    }

    matches.push({ key, point, leadMessage, leadTime });
  }

  return matches.sort((a, b) => b.leadTime - a.leadTime).at(0) ?? null;
}

function volunteeredDataSkipCompletion(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  afterTimeMs: number
): StepCompletionResult | null {
  if (!Number.isFinite(afterTimeMs)) return null;

  const selectedBranchLabel = selectedBranchLabelForStep(
    points,
    step.stepNumber
  );
  const paths = stepCompletionPaths(step, selectedBranchLabel);

  if (
    !selectedBranchLabel &&
    step.branches.length > 1 &&
    paths.some(
      (path) =>
        hasWaitAction(path.actions) &&
        !path.actions.some((action) => action.actionType === 'ask_question')
    )
  ) {
    return null;
  }

  for (const path of paths) {
    if (!hasWaitAction(path.actions)) continue;
    const asks = path.actions.filter(
      (action) =>
        action.actionType === 'ask_question' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    );
    if (asks.length === 0) continue;

    const requirements = dedupeDataRequirements(
      asks.flatMap((ask) => dataRequirementsForAskContent(ask.content))
    );
    if (requirements.length === 0) continue;

    const satisfied = requirements.map((requirement) =>
      recentPointForRequirement({
        requirement,
        stepNumber: step.stepNumber,
        points,
        history,
        afterTimeMs
      })
    );
    if (satisfied.some((match) => match === null)) continue;

    const latest = (satisfied as RecentCapturedDataPoint[]).sort(
      (a, b) => b.leadTime - a.leadTime
    )[0];
    if (!latest) continue;

    return {
      complete: true,
      completedAt: Math.max(latest.leadTime, afterTimeMs + 1),
      aiMessageId: null,
      aiMessageIds: [],
      leadMessageId: latest.leadMessage.id ?? null,
      sentAt: null,
      reason: 'volunteered_data_auto_complete',
      selectedBranchLabel: path.selectedBranchLabel ?? selectedBranchLabel,
      selectedSuggestionId: null,
      historyMessagesWithSelectedSuggestionId: null
    };
  }

  return null;
}

async function extractBookingInfoDataPoints(params: {
  accountId: string;
  leadId: string;
  points: CapturedDataPoints;
  history: ScriptHistoryMessage[];
  script: ScriptWithRecovery | null;
}) {
  const reply = findLatestBookingInfoReply({
    history: params.history,
    script: params.script
  });
  if (!reply) return;

  const existingFields = bookingInfoFieldsFromPoints(params.points);
  const alreadyExtractedForReply =
    bookingInfoLeadMessageId(params.points) === (reply.leadReply.id ?? null) &&
    hasAnyBookingInfoField(existingFields);
  const fields = alreadyExtractedForReply
    ? existingFields
    : await extractBookingInfoWithHaiku({
        accountId: params.accountId,
        leadMessage: reply.leadReply.content
      });
  if (!hasAnyBookingInfoField(fields)) return;

  if (!alreadyExtractedForReply) {
    setBookingInfoDataPoints({
      points: params.points,
      fields,
      leadMessageId: reply.leadReply.id ?? null,
      method: 'llm_booking_info_extraction'
    });

    const leadUpdate = {
      ...(fields.fullName ? { name: fields.fullName } : {}),
      ...(fields.email ? { email: fields.email } : {}),
      ...(fields.timezone ? { timezone: fields.timezone } : {})
    };
    if (Object.keys(leadUpdate).length > 0) {
      await prisma.lead
        .update({
          where: { id: params.leadId },
          data: leadUpdate
        })
        .catch((err) =>
          console.error('[script-state] booking lead update failed:', err)
        );
    }
  }

  if (
    !reply.promptStep ||
    !hasAllBookingInfoFields(bookingInfoFieldsFromPoints(params.points))
  ) {
    return;
  }

  appendBranchHistoryEventToPoints(params.points, {
    eventType: 'step_completed',
    stepNumber: reply.promptStep.stepNumber,
    stepTitle: reply.promptStep.title ?? null,
    selectedBranchLabel: selectedBranchLabelForStep(
      params.points,
      reply.promptStep.stepNumber
    ),
    suggestionId: null,
    aiMessageId: reply.prompt.id ?? null,
    aiMessageIds: reply.prompt.id ? [reply.prompt.id] : [],
    leadMessageId: reply.leadReply.id ?? null,
    sentAt: new Date(reply.prompt.timestamp).toISOString(),
    completedAt: new Date(reply.leadReply.timestamp).toISOString(),
    createdAt: new Date().toISOString(),
    stepCompletionAttempted: true,
    stepCompletionReason: 'completed_by_booking_info_reply',
    previousSelectedBranch: selectedBranchLabelForStep(
      params.points,
      reply.promptStep.stepNumber
    ),
    currentSelectedBranch: selectedBranchLabelForStep(
      params.points,
      reply.promptStep.stepNumber
    ),
    selectedSuggestionId:
      branchHistorySelectionForStep(params.points, reply.promptStep.stepNumber)
        ?.suggestionId ?? null,
    historyMessagesWithSelectedSuggestionId: null
  });
}

function ruleRecord(step: ScriptStepWithRecovery): Record<string, unknown> {
  return asRecord(step.completionRule);
}

export function isStepComplete(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints
): boolean {
  const rule = ruleRecord(step);
  const type = typeof rule.type === 'string' ? rule.type : null;
  // Behavior change (2026-05-08, bug-26): a NULL completionRule used to
  // mean "this step is auto-complete". That assumption made
  // computeSystemStage return the LAST step of every parsed script
  // (because the parser doesn't synthesise completion rules), which
  // surfaced in the dashboard as e.g. "Didnt Receive Homework" on a
  // fresh conversation. Now: null type → INCOMPLETE. Operators marking
  // a step explicitly auto-complete must use `{ "type": "always_complete" }`
  // in completionRule. Backward-compat carve-out for `always_complete`
  // is retained below.
  if (type === 'always_complete') return true;
  if (!type) return false;

  if (type === 'data_captured') {
    const fields = Array.isArray(rule.fields) ? rule.fields : [];
    return fields.every(
      (field) =>
        typeof field === 'string' &&
        pointIsHigh(points, field) &&
        pointValue(points, field) !== null
    );
  }

  if (type === 'binary_confirmation') {
    const field = typeof rule.field === 'string' ? rule.field : null;
    return !!field && pointValue<boolean>(points, field) === true;
  }

  if (type === 'artifact_delivered') {
    const field = typeof rule.field === 'string' ? rule.field : null;
    if (!field) return false;
    return pointValue<boolean>(points, `${field}_delivered`) === true;
  }

  if (type === 'route_decision') return false;

  return false;
}

export function computeSystemStage(
  script: ScriptWithRecovery | null,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[] = [],
  options: {
    previousCurrentScriptStep?: number | null;
    maxAdvanceSteps?: number;
  } = {}
): { step: ScriptStepWithRecovery | null; reason: string } {
  const steps = script?.steps ?? [];
  let historyCursor = Number.NEGATIVE_INFINITY;
  let durableMinStepNumber = durableMinimumStepNumber(points, steps);
  let candidate: {
    step: ScriptStepWithRecovery | null;
    reason: string;
  } | null = null;

  for (const step of steps) {
    const durableCompletion = completedBranchHistoryForStep(
      points,
      step.stepNumber,
      historyCursor
    );
    if (durableCompletion?.completedAt) {
      historyCursor = Date.parse(durableCompletion.completedAt);
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: 'completed_from_branch_history',
        previousSelectedBranch: durableCompletion.selectedBranchLabel,
        currentSelectedBranch: durableCompletion.selectedBranchLabel,
        selectedSuggestionId: durableCompletion.selectedSuggestionId ?? null,
        historyMessagesWithSelectedSuggestionId:
          durableCompletion.historyMessagesWithSelectedSuggestionId ?? null,
        aiMessageId: durableCompletion.aiMessageId,
        leadMessageId: durableCompletion.leadMessageId
      });
      continue;
    }

    const bookingSkipCompletion = bookingInfoSkipCompletion(
      step,
      points,
      history,
      historyCursor
    );
    if (bookingSkipCompletion?.complete) {
      historyCursor = bookingSkipCompletion.completedAt;
      appendStepCompletedBranchHistoryEvent(
        points,
        step,
        bookingSkipCompletion
      );
      durableMinStepNumber = durableMinimumStepNumber(points, steps);
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: bookingSkipCompletion.reason,
        previousSelectedBranch: bookingSkipCompletion.selectedBranchLabel,
        currentSelectedBranch: bookingSkipCompletion.selectedBranchLabel,
        selectedSuggestionId: bookingSkipCompletion.selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId:
          bookingSkipCompletion.historyMessagesWithSelectedSuggestionId,
        aiMessageId: bookingSkipCompletion.aiMessageId,
        leadMessageId: bookingSkipCompletion.leadMessageId
      });
      continue;
    }

    const volunteeredSkipCompletion = volunteeredDataSkipCompletion(
      step,
      points,
      history,
      historyCursor
    );
    if (volunteeredSkipCompletion?.complete) {
      historyCursor = volunteeredSkipCompletion.completedAt;
      appendStepCompletedBranchHistoryEvent(
        points,
        step,
        volunteeredSkipCompletion
      );
      durableMinStepNumber = durableMinimumStepNumber(points, steps);
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: volunteeredSkipCompletion.reason,
        previousSelectedBranch: volunteeredSkipCompletion.selectedBranchLabel,
        currentSelectedBranch: volunteeredSkipCompletion.selectedBranchLabel,
        selectedSuggestionId: volunteeredSkipCompletion.selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId:
          volunteeredSkipCompletion.historyMessagesWithSelectedSuggestionId,
        aiMessageId: volunteeredSkipCompletion.aiMessageId,
        leadMessageId: volunteeredSkipCompletion.leadMessageId
      });
      continue;
    }

    const routingOnlyCompletion = autoCompletionFromSelectedRoutingBranch(
      step,
      points,
      history,
      historyCursor
    );
    if (routingOnlyCompletion?.complete) {
      historyCursor = routingOnlyCompletion.completedAt;
      appendStepCompletedBranchHistoryEvent(
        points,
        step,
        routingOnlyCompletion
      );
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: routingOnlyCompletion.reason,
        previousSelectedBranch: routingOnlyCompletion.selectedBranchLabel,
        currentSelectedBranch: routingOnlyCompletion.selectedBranchLabel,
        selectedSuggestionId: routingOnlyCompletion.selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId:
          routingOnlyCompletion.historyMessagesWithSelectedSuggestionId,
        aiMessageId: routingOnlyCompletion.aiMessageId,
        leadMessageId: routingOnlyCompletion.leadMessageId
      });
      continue;
    }

    if (routingOnlyCompletion) {
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: routingOnlyCompletion.reason,
        previousSelectedBranch: routingOnlyCompletion.selectedBranchLabel,
        currentSelectedBranch: null,
        selectedSuggestionId: routingOnlyCompletion.selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId:
          routingOnlyCompletion.historyMessagesWithSelectedSuggestionId,
        aiMessageId: null,
        leadMessageId: null
      });
      candidate = { step, reason: 'first_incomplete_step_from_history' };
      break;
    }

    if (stepHasHistoryCompletionSignal(step, points)) {
      const historyCompletion = stepCompletionFromHistory(
        step,
        points,
        history,
        historyCursor
      );
      if (historyCompletion.complete) {
        historyCursor = historyCompletion.completedAt;
        appendStepCompletedBranchHistoryEvent(points, step, historyCompletion);
        writeStepCompletionTrace(points, {
          stepNumber: step.stepNumber,
          stepTitle: step.title ?? null,
          stepCompletionAttempted: true,
          stepCompletionReason: historyCompletion.reason,
          previousSelectedBranch: historyCompletion.selectedBranchLabel,
          currentSelectedBranch: historyCompletion.selectedBranchLabel,
          selectedSuggestionId: historyCompletion.selectedSuggestionId,
          historyMessagesWithSelectedSuggestionId:
            historyCompletion.historyMessagesWithSelectedSuggestionId,
          aiMessageId: historyCompletion.aiMessageId,
          leadMessageId: historyCompletion.leadMessageId
        });
        continue;
      }

      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: true,
        stepCompletionReason: historyCompletion.reason,
        previousSelectedBranch: historyCompletion.selectedBranchLabel,
        currentSelectedBranch: null,
        selectedSuggestionId: historyCompletion.selectedSuggestionId,
        historyMessagesWithSelectedSuggestionId:
          historyCompletion.historyMessagesWithSelectedSuggestionId,
        aiMessageId: null,
        leadMessageId: null
      });
      candidate = { step, reason: 'first_incomplete_step_from_history' };
      break;
    }

    if (isStepComplete(step, points)) {
      writeStepCompletionTrace(points, {
        stepNumber: step.stepNumber,
        stepTitle: step.title ?? null,
        stepCompletionAttempted: false,
        stepCompletionReason: 'completed_from_completion_rule',
        previousSelectedBranch: selectedBranchLabelForStep(
          points,
          step.stepNumber
        ),
        currentSelectedBranch: null,
        selectedSuggestionId: null,
        historyMessagesWithSelectedSuggestionId: null,
        aiMessageId: null,
        leadMessageId: null
      });
      continue;
    }

    writeStepCompletionTrace(points, {
      stepNumber: step.stepNumber,
      stepTitle: step.title ?? null,
      stepCompletionAttempted: false,
      stepCompletionReason: 'no_history_completion_signal',
      previousSelectedBranch: selectedBranchLabelForStep(
        points,
        step.stepNumber
      ),
      currentSelectedBranch: null,
      selectedSuggestionId: null,
      historyMessagesWithSelectedSuggestionId: null,
      aiMessageId: null,
      leadMessageId: null
    });
    candidate = { step, reason: 'first_incomplete_step' };
    break;
  }

  if (!candidate) {
    candidate = {
      step: steps.length > 0 ? steps[steps.length - 1] : null,
      reason: steps.length > 0 ? 'all_steps_complete' : 'no_active_script'
    };
  }

  if (
    candidate.step &&
    durableMinStepNumber !== null &&
    candidate.step.stepNumber < durableMinStepNumber
  ) {
    const floorStepNumber = durableMinStepNumber;
    const durableStep =
      steps.find((step) => step.stepNumber === floorStepNumber) ??
      steps.find((step) => step.stepNumber > floorStepNumber) ??
      steps.at(-1) ??
      candidate.step;
    if (durableStep.stepNumber > candidate.step.stepNumber) {
      candidate = {
        step: durableStep,
        reason: `branch_history_floor:${candidate.reason}`
      };
    }
  }

  if (candidate.step) {
    const currentCandidateStep = candidate.step;
    const postFloorBookingSkip = bookingInfoSkipCompletion(
      currentCandidateStep,
      points,
      history,
      historyCursor
    );
    if (postFloorBookingSkip?.complete) {
      appendStepCompletedBranchHistoryEvent(
        points,
        currentCandidateStep,
        postFloorBookingSkip
      );
      durableMinStepNumber = durableMinimumStepNumber(points, steps);
      const nextStep =
        steps.find(
          (step) => step.stepNumber > currentCandidateStep.stepNumber
        ) ?? currentCandidateStep;
      if (nextStep.stepNumber > currentCandidateStep.stepNumber) {
        candidate = {
          step: nextStep,
          reason: `booking_info_complete_skip_missing_info_followup:${candidate.reason}`
        };
      }
    }

    const postFloorVolunteeredSkip = volunteeredDataSkipCompletion(
      currentCandidateStep,
      points,
      history,
      historyCursor
    );
    if (postFloorVolunteeredSkip?.complete) {
      appendStepCompletedBranchHistoryEvent(
        points,
        currentCandidateStep,
        postFloorVolunteeredSkip
      );
      durableMinStepNumber = durableMinimumStepNumber(points, steps);
      const nextStep =
        steps.find(
          (step) => step.stepNumber > currentCandidateStep.stepNumber
        ) ?? currentCandidateStep;
      if (nextStep.stepNumber > currentCandidateStep.stepNumber) {
        candidate = {
          step: nextStep,
          reason: `volunteered_data_auto_complete:${candidate.reason}`
        };
      }
    }
  }

  const previousCurrentScriptStep = options.previousCurrentScriptStep ?? null;
  const maxAdvanceSteps = options.maxAdvanceSteps ?? 1;

  // F5 (2026-07-22): monotonic step floor at the LAST-PERSISTED position.
  // The durableMinStepNumber floor above only holds the line at steps with a
  // proven step_completed event; early in a conversation (or after the F4 gate
  // parks a step on a non-answer) a fresh re-derivation could compute a
  // candidate BELOW where we already were and silently walk the lead backward
  // — re-asking a question they already answered. currentScriptStep is the
  // single source of truth for "where we are"; never move below it. This is a
  // floor, not an advance: it can only raise a too-low candidate back up to the
  // prior position, never push forward (that stays governed by the cap below).
  if (
    candidate.step &&
    typeof previousCurrentScriptStep === 'number' &&
    previousCurrentScriptStep > 0 &&
    candidate.step.stepNumber < previousCurrentScriptStep
  ) {
    const candidateStepNumber = candidate.step.stepNumber;
    const heldStep =
      steps.find((step) => step.stepNumber === previousCurrentScriptStep) ??
      steps.find((step) => step.stepNumber > candidateStepNumber) ??
      null;
    if (heldStep && heldStep.stepNumber > candidateStepNumber) {
      console.warn(
        `[script-state-recovery] F5 step floor: blocked backward move ` +
          `${previousCurrentScriptStep}→${candidateStepNumber}; ` +
          `held at ${heldStep.stepNumber} (candidate reason: ${candidate.reason})`
      );
      candidate = {
        step: heldStep,
        reason: `prev_step_floor:${candidate.reason}`
      };
    }
  }

  if (
    candidate.step &&
    typeof previousCurrentScriptStep === 'number' &&
    previousCurrentScriptStep > 0 &&
    maxAdvanceSteps >= 0 &&
    candidate.step.stepNumber > previousCurrentScriptStep + maxAdvanceSteps
  ) {
    // F5.1 1b (2026-06-07): the +1/turn cap is an ANTI-SKIP guard — it stops
    // the AI jumping ahead of itself (generating late-step content while the
    // lead is still early). But it ALSO throttled legitimate catch-up: when the
    // tracker had lagged and the intervening steps are now PROVABLY complete,
    // capping kept the position stuck a step behind, re-feeding the gate a stale
    // step. So: only cap when the jump is UNPROVEN. If every intervening step
    // (prev+1 … candidate-1) has a step_completed event recorded this walk, the
    // advance is justified by history — allow it. This is strictly stronger than
    // the old durableMinStepNumber floor (it requires EVERY gap proven, so it
    // can never advance past an unproven step → no "jump to last step" regression).
    const allInterveningProven = (() => {
      for (
        let s = previousCurrentScriptStep + 1;
        s < candidate.step.stepNumber;
        s++
      ) {
        // step must exist in the script AND have a step_completed event
        const stepExists = steps.some((st) => st.stepNumber === s);
        if (!stepExists) continue; // gaps in numbering aren't blockers
        const completed = readBranchHistoryEvents(points).some(
          (e) => e.eventType === 'step_completed' && e.stepNumber === s
        );
        if (!completed) return false;
      }
      return true;
    })();

    if (!allInterveningProven) {
      const cappedStepNumber = Math.max(
        previousCurrentScriptStep + maxAdvanceSteps,
        durableMinStepNumber ?? Number.NEGATIVE_INFINITY
      );
      const cappedStep =
        steps.find((step) => step.stepNumber === cappedStepNumber) ??
        steps.find((step) => step.stepNumber > previousCurrentScriptStep) ??
        candidate.step;
      if (cappedStep.stepNumber < candidate.step.stepNumber) {
        return {
          step: cappedStep,
          reason: `capped_to_one_step_advance:${candidate.reason}`
        };
      }
    }
    // else: every intervening step proven complete → advance to true candidate.
  }

  return candidate;
}

const STEP_INFERENCE_PATTERNS: Record<string, RegExp[]> = {
  SOFT_PITCH: [
    // Leak-audit 1-5: removed "anthony"; generic closer phrasing only.
    /(quick\s+)?call with (my right hand|my partner|my closer|head coach)/i,
    /break (it|that) down/i,
    /game ?plan/i,
    /would you be (open|down) (to|for)/i,
    /\bhop on (a )?(quick )?(call|chat)\b/i,
    /\bjump on (a )?(quick )?(call|chat)\b/i
  ],
  APPLICATION_SEND: [
    /typeform|form\.typeform/i,
    /fill (this|it) out/i,
    /\bapplication\b/i
  ],
  CAPITAL_QUALIFICATION: [
    /capital situation/i,
    /(have|got).{0,20}(set aside|liquid)/i,
    /at least.{0,10}(usd|\$)/i,
    /\bcapital\b.{0,25}\b(markets|trading|mentorship|education)\b/i
  ],
  DOWNSELL_DELIVERY: [
    // Leak-audit 1-5: removed "whop.com" and "session liquidity" (daetradez's
    // downsell host/product); generic downsell terms only.
    /self.?paced/i,
    /\bcourse link\b/i,
    /\bcheckout\b/i
  ],
  BOOKING_CONFIRM: [
    /\bbooking\b/i,
    /(monday|tuesday|wednesday|thursday|friday|saturday|sunday).{0,30}(am|pm)/i,
    /\bscheduled\b/i
  ]
};

function normalizedStepKey(step: ScriptStepWithRecovery | null | undefined) {
  const raw = step?.stateKey || step?.title || '';
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stepMatchesAnyKey(
  step: ScriptStepWithRecovery,
  keys: string[]
): boolean {
  const key = normalizedStepKey(step);
  const title = step.title.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return keys.some(
    (candidate) => key === candidate || title.includes(candidate)
  );
}

function findStepForActionKind(
  script: ScriptWithRecovery | null,
  kind: string
): ScriptStepWithRecovery | null {
  const steps = script?.steps ?? [];
  if (kind === 'CAPITAL_QUALIFICATION') {
    return (
      steps.find((step) =>
        stepMatchesAnyKey(step, [
          'CAPITAL_QUALIFICATION',
          'FINANCIAL_SCREENING'
        ])
      ) ??
      steps.find((step) =>
        /capital/i.test(step.canonicalQuestion || step.title || '')
      ) ??
      null
    );
  }

  if (kind === 'APPLICATION_SEND') {
    return (
      steps.find((step) => step.artifactField === 'applicationFormUrl') ??
      steps.find((step) =>
        stepMatchesAnyKey(step, ['SEND_APPLICATION_LINK'])
      ) ??
      null
    );
  }

  if (kind === 'DOWNSELL_DELIVERY') {
    return (
      steps.find((step) => step.artifactField === 'downsellUrl') ??
      steps.find((step) => stepMatchesAnyKey(step, ['FUNDING_OR_DOWNSELL'])) ??
      null
    );
  }

  if (kind === 'BOOKING_CONFIRM') {
    return (
      steps.find((step) =>
        stepMatchesAnyKey(step, ['CONFIRM_BOOKING', 'BOOKING_CONFIRM'])
      ) ??
      steps.find((step) => /booking/i.test(step.title)) ??
      null
    );
  }

  if (kind === 'SOFT_PITCH') {
    return (
      steps.find((step) =>
        stepMatchesAnyKey(step, [
          'SOFT_PITCH',
          'SOFT_PITCH_COMMITMENT',
          'CALL_PITCH'
        ])
      ) ??
      // Some parsed scripts do not have an explicit soft-pitch step yet.
      // Treat the application/call handoff as the planned forward step so
      // capital qualification still blocks an early call pitch.
      findStepForActionKind(script, 'APPLICATION_SEND')
    );
  }

  return null;
}

export function inferStepFromAction(params: {
  script: ScriptWithRecovery | null;
  action: string | string[] | null | undefined;
}): {
  step: ScriptStepWithRecovery;
  stepNumber: number;
  stepKey: string;
  actionKind: string;
} | null {
  const text = Array.isArray(params.action)
    ? params.action.join('\n')
    : params.action || '';
  if (!text.trim()) return null;

  for (const [kind, patterns] of Object.entries(STEP_INFERENCE_PATTERNS)) {
    if (!patterns.some((pattern) => pattern.test(text))) continue;
    const step = findStepForActionKind(params.script, kind);
    if (!step) continue;
    return {
      step,
      stepNumber: step.stepNumber,
      stepKey: kind === 'SOFT_PITCH' ? 'SOFT_PITCH' : normalizedStepKey(step),
      actionKind: kind
    };
  }

  return null;
}

function stepRequiresRecovery(step: ScriptStepWithRecovery): boolean {
  const actionType = inferActionType(step);
  return actionType === 'ASK_QUESTION' || actionType === 'ROUTE_DECISION';
}

export function collectPrerequisiteDataPointsBeforeStep(params: {
  script: ScriptWithRecovery | null;
  targetStepNumber: number;
}): string[] {
  const fields = new Set<string>();
  const steps = (params.script?.steps ?? []).filter(
    (step) => step.stepNumber < params.targetStepNumber
  );

  for (const step of steps) {
    const required = Array.isArray(step.requiredDataPoints)
      ? step.requiredDataPoints
      : [];
    for (const field of required) {
      if (typeof field === 'string' && field.trim()) fields.add(field.trim());
    }

    const rule = ruleRecord(step);
    const ruleFields = Array.isArray(rule.fields) ? rule.fields : [];
    for (const field of ruleFields) {
      if (typeof field === 'string' && field.trim()) fields.add(field.trim());
    }
  }

  return Array.from(fields);
}

export function validateStepPrerequisites(params: {
  snapshot: ScriptStateSnapshot | null;
  targetStepNumber: number | null | undefined;
}): { allowed: boolean; missingPrerequisites: string[] } {
  const snapshot = params.snapshot;
  if (!snapshot || !params.targetStepNumber) {
    return { allowed: true, missingPrerequisites: [] };
  }

  const prerequisites = collectPrerequisiteDataPointsBeforeStep({
    script: snapshot.script,
    targetStepNumber: params.targetStepNumber
  });
  const missing = prerequisites.filter((field) => {
    if (field === 'verifiedCapitalUsd') {
      return (
        !pointIsPresent(snapshot.capturedDataPoints, 'verifiedCapitalUsd') &&
        pointValue<boolean>(
          snapshot.capturedDataPoints,
          'capitalThresholdMet'
        ) !== true
      );
    }
    return !pointIsPresent(snapshot.capturedDataPoints, field);
  });

  return { allowed: missing.length === 0, missingPrerequisites: missing };
}

export function validateSoftPitchPrerequisites(params: {
  snapshot: ScriptStateSnapshot | null;
  action: string | string[] | null | undefined;
}): { allowed: boolean; missingPrerequisites: string[] } {
  const inferred = inferStepFromAction({
    script: params.snapshot?.script ?? null,
    action: params.action
  });
  if (!inferred || inferred.actionKind !== 'SOFT_PITCH') {
    return { allowed: true, missingPrerequisites: [] };
  }
  return validateStepPrerequisites({
    snapshot: params.snapshot,
    targetStepNumber: inferred.stepNumber
  });
}

export function detectAttemptedStepSkip(params: {
  snapshot: ScriptStateSnapshot | null;
  plannedAction: string | string[] | null | undefined;
}): ScriptStepSkipCheck {
  const snapshot = params.snapshot;
  const currentStep = snapshot?.currentStep ?? null;
  const inferred = inferStepFromAction({
    script: snapshot?.script ?? null,
    action: params.plannedAction
  });
  if (!snapshot?.script || !currentStep || !inferred) {
    return {
      skip: false,
      plannedStep: inferred?.step ?? null,
      plannedStepNumber: inferred?.stepNumber ?? null,
      plannedStepKey: inferred?.stepKey ?? null,
      plannedActionKind: inferred?.actionKind ?? null,
      missingSteps: [],
      recoveryStep: null,
      reason: null
    };
  }

  const plannedStepNumber = inferred.stepNumber;
  if (plannedStepNumber <= currentStep.stepNumber) {
    return {
      skip: false,
      plannedStep: inferred.step,
      plannedStepNumber,
      plannedStepKey: inferred.stepKey,
      plannedActionKind: inferred.actionKind,
      missingSteps: [],
      recoveryStep: null,
      reason: null
    };
  }

  const candidateMissing = [
    currentStep,
    ...snapshot.script.steps.filter(
      (step) =>
        step.stepNumber > currentStep.stepNumber &&
        step.stepNumber < plannedStepNumber
    )
  ].filter((step) => !isStepComplete(step, snapshot.capturedDataPoints));

  const missingSteps = candidateMissing.length
    ? candidateMissing
    : [currentStep];
  const recoveryStep =
    missingSteps.find((step) => stepRequiresRecovery(step)) ?? missingSteps[0];

  return {
    skip: true,
    plannedStep: inferred.step,
    plannedStepNumber,
    plannedStepKey: inferred.stepKey,
    plannedActionKind: inferred.actionKind,
    missingSteps,
    recoveryStep,
    reason: `planned_${inferred.stepKey}_before_${normalizedStepKey(recoveryStep)}`
  };
}

export function detectMidConversationStepSkip(params: {
  snapshot: ScriptStateSnapshot | null;
  history: ScriptHistoryMessage[];
}): ScriptStepSkipCheck {
  const snapshot = params.snapshot;
  const currentStepNumber = snapshot?.currentStep?.stepNumber ?? null;
  if (!snapshot?.script || !currentStepNumber) {
    return detectAttemptedStepSkip({ snapshot, plannedAction: null });
  }

  const setterMessages = sortedHistory(params.history).filter(
    (message) => message.sender === 'AI'
  );
  let best: ScriptStepSkipCheck | null = null;

  for (const message of setterMessages) {
    const check = detectAttemptedStepSkip({
      snapshot,
      plannedAction: message.content
    });
    if (!check.skip || !check.plannedStepNumber) continue;
    if (!best || check.plannedStepNumber > (best.plannedStepNumber ?? 0)) {
      best = check;
    }
  }

  return (
    best ?? {
      skip: false,
      plannedStep: null,
      plannedStepNumber: null,
      plannedStepKey: null,
      plannedActionKind: null,
      missingSteps: [],
      recoveryStep: null,
      reason: null
    }
  );
}

export async function prepareScriptState(params: {
  accountId: string;
  conversationId: string;
  history: ScriptHistoryMessage[];
}): Promise<ScriptStateSnapshot> {
  const [conversation, script, persona] = await Promise.all([
    prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: {
        id: true,
        leadId: true,
        capturedDataPoints: true,
        capitalVerificationStatus: true,
        capitalVerifiedAmount: true,
        currentScriptStep: true,
        source: true
      }
    }),
    prisma.script.findFirst({
      where: { accountId: params.accountId, isActive: true },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            actions: {
              where: { branchId: null },
              orderBy: { sortOrder: 'asc' },
              include: { form: { include: { fields: true } } }
            },
            branches: {
              orderBy: { sortOrder: 'asc' },
              include: {
                actions: {
                  orderBy: { sortOrder: 'asc' },
                  include: { form: { include: { fields: true } } }
                }
              }
            }
          }
        }
      }
    }),
    prisma.aIPersona.findFirst({
      where: { accountId: params.accountId, isActive: true },
      select: {
        minimumCapitalRequired: true,
        capitalVerificationPrompt: true,
        freeValueLink: true,
        downsellConfig: true,
        promptConfig: true
      }
    })
  ]);

  if (!conversation) {
    return {
      conversationId: params.conversationId,
      leadId: '',
      script: null,
      currentStep: null,
      currentScriptStep: 1,
      activeBranch: null,
      selectedBranchLabel: null,
      systemStage: null,
      capturedDataPoints: {},
      persona,
      reason: 'conversation_not_found'
    };
  }

  const capturedDataPoints = extractDataPoints({
    existing: conversation.capturedDataPoints,
    history: params.history,
    script,
    persona,
    durableStatus: conversation.capitalVerificationStatus,
    durableAmount: conversation.capitalVerifiedAmount
  });
  removeInvalidScriptVariableResolutionKeys(
    capturedDataPoints as unknown as Record<string, unknown>
  );
  await extractBookingInfoDataPoints({
    accountId: params.accountId,
    leadId: conversation.leadId,
    points: capturedDataPoints,
    history: params.history,
    script
  });
  let systemStage = computeSystemStage(
    script,
    capturedDataPoints,
    params.history,
    {
      previousCurrentScriptStep: conversation.currentScriptStep,
      maxAdvanceSteps: 1
    }
  );
  let currentStep = systemStage.step;
  const conditionalSkip = await applyConditionalStepSkip({
    accountId: params.accountId,
    script,
    points: capturedDataPoints,
    history: params.history,
    currentStep
  });
  if (
    conditionalSkip.step &&
    conditionalSkip.step.stepNumber !== currentStep?.stepNumber
  ) {
    currentStep = conditionalSkip.step;
    systemStage = {
      step: currentStep,
      reason: conditionalSkip.reason ?? systemStage.reason
    };
  }
  let currentScriptStep = currentStep?.stepNumber ?? 1;

  // A No-signal branch is a recovery loop, not completion of the step. Its
  // question asks the lead to provide a usable intent. The next real reply
  // must be classified again on the same step; crediting it as the branch's
  // answer skips the normal branch requirements (live v2 skipped location).
  const priorStepForNoSignal =
    typeof conversation.currentScriptStep === 'number' &&
    conversation.currentScriptStep > 0
      ? conversation.currentScriptStep
      : 1;
  const priorSelectedLabel = branchHistorySelectedLabelForStep(
    capturedDataPoints,
    priorStepForNoSignal
  );
  const priorStepRow = script?.steps.find(
    (step) => step.stepNumber === priorStepForNoSignal
  );
  const priorSelectedBranch =
    priorStepRow?.branches.find(
      (branch) => branch.branchLabel === priorSelectedLabel
    ) ?? null;
  if (
    shouldHoldNoSignalRecoveryAdvance({
      priorStep: priorStepForNoSignal,
      computedStep: currentScriptStep,
      selectedBranch: priorSelectedBranch
    })
  ) {
    removeNoSignalStepCompletion(capturedDataPoints, priorStepForNoSignal);
    currentScriptStep = priorStepForNoSignal;
    currentStep = priorStepRow ?? currentStep;
    systemStage = { step: currentStep, reason: 'no_signal_reclassify_hold' };
    console.warn(
      `[script-state] no-signal recovery hold — reclassifying the lead's usable reply on step ${priorStepForNoSignal} instead of advancing (conv ${params.conversationId})`
    );
  }

  // No-signal hold (Tega, 2026-09-15). A lead turn that carries no answerable
  // content — an unreadable image, a bare emoji, a lone "?" — does not answer
  // our ask, so it must not move the cursor. The legacy detector credits it,
  // advances a step, and the NEXT step's copy ships on top of a message the AI
  // has just said it cannot read ("love to see it, most people don't even take
  // the first step" onto an image). Same family as the decline bug: another
  // branch's text landing in the wrong branch. The compiled FSM already holds
  // correctly here (reply_carries_no_signal); this applies the same rule to
  // the legacy position while the FSM is still shadow-only.
  try {
    const lastMsg = params.history[params.history.length - 1];
    if (lastMsg?.sender === 'LEAD') {
      const { isAnswerableReply } = await import('@/lib/script-fsm/runtime');
      const priorStep =
        typeof conversation.currentScriptStep === 'number' &&
        conversation.currentScriptStep > 0
          ? conversation.currentScriptStep
          : 1;
      if (
        !isAnswerableReply(lastMsg.content) &&
        currentScriptStep > priorStep
      ) {
        const held = script?.steps.find((st) => st.stepNumber === priorStep);
        console.warn(
          `[script-state] no-signal hold — lead turn carries no answerable content (${JSON.stringify((lastMsg.content ?? '').slice(0, 40))}); holding step ${priorStep} instead of advancing to ${currentScriptStep} (conv ${params.conversationId})`
        );
        currentScriptStep = priorStep;
        if (held) {
          currentStep = held;
          systemStage = { step: held, reason: 'no_signal_hold' };
        }
      }
    }
  } catch (holdErr) {
    console.error(
      '[script-state] no-signal hold check failed (non-fatal):',
      holdErr instanceof Error ? holdErr.message : holdErr
    );
  }

  // M5 item 4 (compiler, shadow-first): the compiled FSM's position is a pure
  // fold of the full conversation history through the machine (a lead reply
  // is credited only after we spoke in the step; a branch with N waits needs
  // N credited replies; routing-only / send-only branches complete on our own
  // outbound turn). Logged next to computeSystemStage's answer
  // (RoutingShadowLog.advanceAgreed) and stashed on capturedDataPoints.fsmCursor
  // for traces. When FIX_D_ROUTING_AUTHORITATIVE names this account the FSM
  // OWNS currentScriptStep. Fail-open: any error leaves legacy as is.
  try {
    const { getActiveScriptFsm } = await import('@/lib/script-fsm/store');
    const { foldHistory } = await import('@/lib/script-fsm/runtime');
    const { recordRoutingShadow, isRoutingAuthoritative } = await import(
      '@/lib/script-fsm/shadow'
    );
    const active = await getActiveScriptFsm(params.accountId);
    if (active) {
      const prior =
        typeof conversation.currentScriptStep === 'number' &&
        conversation.currentScriptStep > 0
          ? conversation.currentScriptStep
          : 1;
      const fold = foldHistory(
        active.fsm,
        params.history.map((m) => ({ sender: m.sender, content: m.content })),
        {
          labelForStep: (stepNumber) =>
            branchHistorySelectedLabelForStep(capturedDataPoints, stepNumber),
          source: conversation.source ?? null,
          dataPoints: capturedDataPoints as Record<string, unknown>
        }
      );
      const fsmNext = fold.cursor.stepNumber;
      const lastAdvance = fold.advances.at(-1);
      const fsmReason = `${fold.lastReason}|advances=${fold.advances.length}${
        lastAdvance
          ? `|last=${lastAdvance.from}>${lastAdvance.to}:${lastAdvance.reason}`
          : ''
      }`;
      const last = params.history[params.history.length - 1];
      (capturedDataPoints as Record<string, unknown>).fsmCursor = {
        ...fold.cursor,
        scriptId: active.scriptId,
        asOf:
          last?.timestamp instanceof Date
            ? last.timestamp.toISOString()
            : (last?.timestamp ?? null),
        reason: fsmReason,
        legacyStep: currentScriptStep
      };
      await recordRoutingShadow({
        accountId: params.accountId,
        conversationId: params.conversationId,
        scriptId: active.scriptId,
        stepNumber: prior,
        legacyBranchLabel: null,
        fsmBranchLabel: null,
        fsmReason,
        legacyNextStep: currentScriptStep,
        fsmNextStep: fsmNext
      });
      if (
        script &&
        isRoutingAuthoritative(params.accountId) &&
        fsmNext !== currentScriptStep
      ) {
        const owned = script.steps.find((s) => s.stepNumber === fsmNext);
        if (owned) {
          const legacySaid = currentScriptStep;
          currentStep = owned;
          currentScriptStep = fsmNext;
          systemStage = {
            step: owned,
            reason: `fsm:${fold.lastReason}`
          };
          console.warn(
            `[script-fsm] AUTHORITATIVE position ${fsmNext} (${fsmReason}) on conv ${params.conversationId}; legacy said ${legacySaid}`
          );
        }
      }
    }
  } catch (fsmErr) {
    console.error(
      '[script-fsm] shadow advancement failed (non-fatal, legacy stands):',
      fsmErr instanceof Error ? fsmErr.message : fsmErr
    );
  }
  // F5.1 [4]: did the position advance >1 step this turn (provable catch-up)?
  const priorStep =
    typeof conversation.currentScriptStep === 'number'
      ? conversation.currentScriptStep
      : 0;
  const positionJumpedThisTurn =
    priorStep > 0 && currentScriptStep > priorStep + 1;
  const systemStageName = currentStep?.stateKey || currentStep?.title || null;

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: {
        capturedDataPoints: capturedDataPoints as Prisma.InputJsonValue,
        currentScriptStep,
        systemStage: systemStageName
      }
    })
    .catch((err) =>
      console.error('[script-state] conversation state persist failed:', err)
    );

  // F5.1 1c (2026-06-07): removed the redundant LeadScriptPosition upsert here.
  // `Conversation.currentScriptStep` (persisted just above) is the single source
  // of truth for position; LeadScriptPosition has ZERO live readers across the
  // codebase (verified — only writers in lead-script-tracker.ts [dead fn] +
  // ai-engine.ts). Writing it created a misleading second source of truth and a
  // redundant DB write every turn. Model left intact (no migration) to keep
  // scope tight; only the dead write is dropped.

  return {
    conversationId: params.conversationId,
    leadId: conversation.leadId,
    script,
    currentStep,
    currentScriptStep,
    activeBranch: null,
    selectedBranchLabel: null,
    systemStage: systemStageName,
    capturedDataPoints,
    persona,
    reason: systemStage.reason,
    positionJumpedThisTurn
  };
}

function compareValue(
  rawValue: unknown,
  operator: string,
  rawExpected: string,
  minimumCapitalRequired: number | null
): boolean {
  const expected =
    rawExpected === 'null'
      ? null
      : rawExpected === 'minimumCapitalRequired'
        ? minimumCapitalRequired
        : Number(rawExpected);
  if (operator === '==' && expected === null) return rawValue === null;
  if (operator === '!=' && expected === null) return rawValue !== null;
  if (typeof rawValue !== 'number' || typeof expected !== 'number') {
    return false;
  }
  switch (operator) {
    case '>':
      return rawValue > expected;
    case '>=':
      return rawValue >= expected;
    case '<':
      return rawValue < expected;
    case '<=':
      return rawValue <= expected;
    case '==':
      return rawValue === expected;
    case '!=':
      return rawValue !== expected;
    default:
      return false;
  }
}

export function evaluateRoutingCondition(params: {
  condition: string;
  value: unknown;
  minimumCapitalRequired: number | null;
}): boolean {
  const orParts = params.condition.split(/\s+OR\s+/i);
  return orParts.some((orPart) => {
    const andParts = orPart.split(/\s+AND\s+/i);
    return andParts.every((part) => {
      const match = part
        .trim()
        .match(
          /^value\s*(>=|<=|==|!=|>|<)\s*(minimumCapitalRequired|null|\d+(?:\.\d+)?)$/i
        );
      if (!match) return false;
      return compareValue(
        params.value,
        match[1],
        match[2],
        params.minimumCapitalRequired
      );
    });
  });
}

function buildTemplateMessages(artifactField: string | null, url: string) {
  if (artifactField === 'applicationFormUrl') {
    return [
      `bet bro, here's the application: ${url}`,
      "fill it out and lmk once it's sent through"
    ];
  }
  if (artifactField === 'downsellUrl') {
    return [
      `bet bro, here's the link: ${url}`,
      'go through it at your own pace and build the base first'
    ];
  }
  if (artifactField === 'fallbackContentUrl') {
    return [
      `for now check this out and start applying what you learn: ${url}`,
      "when you're ready to take it deeper just hit me up"
    ];
  }
  return [`here's the link: ${url}`];
}

function actionContentMessages(
  step: ScriptStepWithRecovery,
  artifactField: string | null,
  url: string | null
): string[] {
  // Recovery artifact delivery is deterministic. Script steps can contain
  // multiple branch actions for later states ("filled it out", "link issue"),
  // so flattening all branch actions would duplicate URLs or send the wrong
  // branch. Use one clean artifact template for known delivery fields.
  if (
    url &&
    (artifactField === 'applicationFormUrl' ||
      artifactField === 'downsellUrl' ||
      artifactField === 'fallbackContentUrl')
  ) {
    return buildTemplateMessages(artifactField, url);
  }

  const actions = [
    ...step.actions,
    ...step.branches.flatMap((branch) => branch.actions)
  ].sort((a, b) => a.sortOrder - b.sortOrder);

  const messages: string[] = [];
  for (const action of actions) {
    if (
      action.actionType === 'wait_for_response' ||
      action.actionType === 'wait_duration' ||
      action.actionType === 'runtime_judgment' ||
      action.actionType === 'send_voice_note'
    ) {
      continue;
    }
    let content = action.content?.trim() ?? '';
    const actionUrl =
      firstUrl(action.linkUrl) ||
      firstUrl(action.content) ||
      action.form?.fields
        .map((field) => firstUrl(field.fieldValue))
        .find(Boolean) ||
      null;
    const finalUrl = url || actionUrl;
    if (finalUrl && !content.includes(finalUrl)) {
      content = content ? `${content}\n${finalUrl}` : finalUrl;
    }
    if (content) messages.push(content);
  }

  if (url && messages.length === 0) {
    return buildTemplateMessages(artifactField, url);
  }
  return messages.slice(0, 3);
}

function normalizeRecoveryMessages(messages: string[]) {
  return messages
    .map((m) => m.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function inferActionType(step: ScriptStepWithRecovery): string | null {
  if (step.recoveryActionType) return step.recoveryActionType;
  if (step.routingRules || /route/i.test(step.title)) return 'ROUTE_DECISION';
  const actions = [...step.actions, ...step.branches.flatMap((b) => b.actions)];
  if (
    actions.some(
      (a) => a.actionType === 'send_link' || a.actionType === 'form_reference'
    )
  ) {
    return 'DELIVER_ARTIFACT';
  }
  if (actions.some((a) => a.actionType === 'ask_question'))
    return 'ASK_QUESTION';
  if (actions.some((a) => a.actionType === 'send_message'))
    return 'ACKNOWLEDGE';
  return null;
}

function stageForRecovery(
  artifactField: string | null,
  actionType: string | null,
  points: CapturedDataPoints
) {
  if (artifactField === 'applicationFormUrl') {
    return {
      stage: 'BOOKING',
      subStage: 'BOOKING_CONFIRM',
      capitalOutcome: 'passed' as const
    };
  }
  if (
    artifactField === 'downsellUrl' ||
    pointValue(points, 'capitalThresholdMet') === false
  ) {
    return {
      stage: 'FINANCIAL_SCREENING',
      subStage: 'LOW_TICKET',
      capitalOutcome: 'failed' as const
    };
  }
  if (actionType === 'ASK_QUESTION') {
    return {
      stage: 'FINANCIAL_SCREENING',
      subStage: null,
      capitalOutcome: 'not_asked' as const
    };
  }
  return {
    stage: 'QUALIFYING',
    subStage: null,
    capitalOutcome: 'not_evaluated' as const
  };
}

function priorityForRecovery(
  artifactField: string | null,
  points: CapturedDataPoints
): RecoveryPriority {
  if (
    artifactField === 'applicationFormUrl' &&
    pointValue(points, 'capitalThresholdMet') === true
  ) {
    return 'HOT';
  }
  if (artifactField === 'downsellUrl') return 'MEDIUM';
  return 'LOW';
}

function buildDeterministicAction(params: {
  snapshot: ScriptStateSnapshot;
  step: ScriptStepWithRecovery;
  visited?: Set<number>;
}):
  | {
      step: ScriptStepWithRecovery;
      actionType: string;
      artifactField: string | null;
      messages: string[];
      reason: string;
    }
  | { failed: true; reason: string } {
  const visited = params.visited ?? new Set<number>();
  if (visited.has(params.step.stepNumber)) {
    return { failed: true, reason: 'route_cycle_detected' };
  }
  visited.add(params.step.stepNumber);

  const actionType = inferActionType(params.step);
  if (!actionType)
    return { failed: true, reason: 'step_missing_recovery_action' };

  if (actionType === 'ROUTE_DECISION') {
    const routingRules = asRecord(params.step.routingRules);
    const field =
      typeof routingRules.field === 'string' ? routingRules.field : null;
    const branches = Array.isArray(routingRules.branches)
      ? routingRules.branches
      : [];
    const value = field
      ? pointValue(params.snapshot.capturedDataPoints, field)
      : null;
    const matched = branches.find((branch) => {
      const b = asRecord(branch);
      const condition =
        typeof b.condition === 'string' ? b.condition : 'value == null';
      return evaluateRoutingCondition({
        condition,
        value,
        minimumCapitalRequired:
          params.snapshot.persona?.minimumCapitalRequired ?? null
      });
    });
    if (!matched) return { failed: true, reason: `no_matching_route_${field}` };
    const nextStep = Number(asRecord(matched).nextStep);
    const target = params.snapshot.script?.steps.find(
      (step) => step.stepNumber === nextStep
    );
    if (!target)
      return { failed: true, reason: `route_target_missing_${nextStep}` };
    return buildDeterministicAction({
      snapshot: params.snapshot,
      step: target,
      visited
    });
  }

  if (actionType === 'ASK_QUESTION') {
    const question =
      params.step.canonicalQuestion ||
      params.step.actions.find((a) => a.actionType === 'ask_question')
        ?.content ||
      params.step.actions.find((a) => a.content)?.content ||
      null;
    if (!question)
      return { failed: true, reason: 'canonical_question_missing' };
    return {
      step: params.step,
      actionType,
      artifactField: null,
      messages: [question],
      reason: `Step ${params.step.stepNumber} asks canonical question`
    };
  }

  if (actionType === 'DELIVER_ARTIFACT') {
    const artifactField = params.step.artifactField || null;
    const url = resolveArtifactUrl({
      artifactField,
      step: params.step,
      script: params.snapshot.script,
      persona: params.snapshot.persona
    });
    if (!url) {
      return {
        failed: true,
        reason:
          artifactField === 'applicationFormUrl'
            ? 'persona_missing_artifact_url'
            : `missing_artifact_url_${artifactField || 'unknown'}`
      };
    }
    const messages = normalizeRecoveryMessages(
      actionContentMessages(params.step, artifactField, url)
    );
    if (messages.length === 0) {
      return { failed: true, reason: 'artifact_message_empty' };
    }
    return {
      step: params.step,
      actionType,
      artifactField,
      messages,
      reason: `Step ${params.step.stepNumber} delivers ${artifactField || 'artifact'}`
    };
  }

  const messages = normalizeRecoveryMessages(
    actionContentMessages(params.step, null, null)
  );
  if (messages.length === 0) {
    return { failed: true, reason: 'acknowledgment_message_empty' };
  }
  return {
    step: params.step,
    actionType,
    artifactField: null,
    messages,
    reason: `Step ${params.step.stepNumber} emits ${actionType}`
  };
}

async function createRecoveryEvent(params: {
  accountId: string;
  snapshot: ScriptStateSnapshot;
  step: ScriptStepWithRecovery | null;
  triggerReason: string;
  recoveryAction: string | null;
  status: string;
  failureReason?: string | null;
  priority: RecoveryPriority;
  generatedMessages?: string[] | null;
  metadata?: Record<string, unknown>;
  llmEmittedStage?: string | null;
}) {
  return prisma.selfRecoveryEvent.create({
    data: {
      accountId: params.accountId,
      conversationId: params.snapshot.conversationId,
      leadId: params.snapshot.leadId,
      scriptId: params.snapshot.script?.id ?? null,
      scriptStepId: params.step?.id ?? null,
      stepNumber: params.step?.stepNumber ?? null,
      triggerReason: params.triggerReason,
      recoveryAction: params.recoveryAction,
      status: params.status,
      failureReason: params.failureReason ?? null,
      priority: params.priority,
      generatedMessages: params.generatedMessages
        ? (params.generatedMessages as Prisma.InputJsonValue)
        : undefined,
      metadata: params.metadata
        ? (params.metadata as Prisma.InputJsonValue)
        : undefined,
      llmEmittedStage: params.llmEmittedStage ?? null,
      systemStage: params.snapshot.systemStage
    }
  });
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function loadBridgingTemplates(params: {
  accountId: string;
  scriptId: string | null;
  currentStepKey: string;
  skippedAheadStepKey: string;
}): Promise<string[]> {
  const rows = await prisma.bridgingMessageTemplate.findMany({
    where: {
      isActive: true,
      currentStepKey: params.currentStepKey,
      skippedAheadStepKey: params.skippedAheadStepKey,
      OR: [
        { accountId: params.accountId, scriptId: params.scriptId },
        { accountId: params.accountId, scriptId: null },
        { accountId: null, scriptId: params.scriptId },
        { accountId: null, scriptId: null }
      ]
    },
    orderBy: [
      { accountId: 'desc' },
      { scriptId: 'desc' },
      { updatedAt: 'desc' }
    ]
  });
  for (const row of rows) {
    const templates = jsonStringArray(row.templates);
    if (templates.length > 0) return templates;
  }
  return [];
}

async function buildBridgingMessages(params: {
  accountId: string;
  snapshot: ScriptStateSnapshot;
  currentStep: ScriptStepWithRecovery;
  skippedAheadStep: ScriptStepWithRecovery | null;
  skippedAheadStepKey: string | null;
}): Promise<string[]> {
  const currentStepKey = normalizedStepKey(params.currentStep);
  const skippedAheadStepKey =
    params.skippedAheadStepKey ||
    normalizedStepKey(params.skippedAheadStep) ||
    'UNKNOWN';
  const templates = await loadBridgingTemplates({
    accountId: params.accountId,
    scriptId: params.snapshot.script?.id ?? null,
    currentStepKey,
    skippedAheadStepKey
  });
  const selected = templates[0]?.trim();
  if (selected) return normalizeRecoveryMessages([selected]);

  const canonical =
    params.currentStep.canonicalQuestion ||
    params.currentStep.actions.find(
      (action) => action.actionType === 'ask_question'
    )?.content ||
    null;
  return normalizeRecoveryMessages(canonical ? [canonical] : []);
}

async function distressBypassesRecovery(params: {
  accountId: string;
  snapshot: ScriptStateSnapshot;
  history: ScriptHistoryMessage[];
  triggerReason: string;
  llmEmittedStage?: string | null;
}): Promise<RecoveryResult | null> {
  const latestLead = [...params.history]
    .reverse()
    .find((m) => m.sender === 'LEAD');
  if (!latestLead) return null;
  try {
    const { detectDistress } = await import('@/lib/distress-detector');
    const distress = await detectDistress(latestLead.content);
    if (!distress.detected) return null;
    await createRecoveryEvent({
      accountId: params.accountId,
      snapshot: params.snapshot,
      step: params.snapshot.currentStep,
      triggerReason: params.triggerReason,
      recoveryAction: null,
      status: 'FAILED',
      failureReason: 'distress_bypass',
      priority: 'HOT',
      metadata: {
        distressLabel: distress.label,
        distressMatch: distress.match
      },
      llmEmittedStage: params.llmEmittedStage ?? null
    }).catch(() => null);
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: 'distress_bypass',
      eventId: null,
      priority: 'HOT',
      systemStage: params.snapshot.systemStage,
      currentScriptStep: params.snapshot.currentScriptStep
    };
  } catch {
    return null;
  }
}

function priorityForSkipRecovery(
  history: ScriptHistoryMessage[]
): RecoveryPriority {
  const latest = sortedHistory(history).at(-1);
  const latestMs = latest ? new Date(latest.timestamp).getTime() : 0;
  const hoursSinceLatest = latestMs
    ? (Date.now() - latestMs) / (60 * 60 * 1000)
    : Infinity;
  return hoursSinceLatest <= 2 ? 'HOT' : 'MEDIUM';
}

function recoveryStepAlreadyAsked(
  step: ScriptStepWithRecovery,
  history: ScriptHistoryMessage[]
): boolean {
  if (inferActionType(step) !== 'ASK_QUESTION') return false;
  const stepKey = normalizedStepKey(step);
  const canonical = step.canonicalQuestion?.trim().toLowerCase() || '';
  const setterMessages = sortedHistory(history).filter(
    (message) => message.sender === 'AI' || message.sender === 'HUMAN'
  );

  return setterMessages.some((message) => {
    const content = message.content.trim().toLowerCase();
    if (!content) return false;
    if (stepKey === 'CAPITAL_QUALIFICATION') {
      return containsCapitalQuestion(message.content);
    }
    if (canonical && content.includes(canonical.slice(0, 60))) {
      return true;
    }
    return false;
  });
}

export async function attemptStepSkipRecovery(params: {
  accountId: string;
  conversationId: string;
  history: ScriptHistoryMessage[];
  triggerReason: string;
  plannedAction?: string | string[] | null;
  llmEmittedStage?: string | null;
  approvalMode?: boolean;
}): Promise<RecoveryResult> {
  const snapshot = await prepareScriptState({
    accountId: params.accountId,
    conversationId: params.conversationId,
    history: params.history
  });

  const distress = await distressBypassesRecovery({
    accountId: params.accountId,
    snapshot,
    history: params.history,
    triggerReason: params.triggerReason,
    llmEmittedStage: params.llmEmittedStage ?? null
  });
  if (distress) return distress;

  const skipCheck =
    params.plannedAction !== undefined
      ? detectAttemptedStepSkip({
          snapshot,
          plannedAction: params.plannedAction
        })
      : detectMidConversationStepSkip({
          snapshot,
          history: params.history
        });

  if (
    !snapshot.script ||
    !snapshot.currentStep ||
    !snapshot.leadId ||
    !skipCheck.skip ||
    !skipCheck.recoveryStep
  ) {
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: skipCheck.reason || 'no_skip_detected_use_normal_recovery',
      eventId: null,
      priority: 'LOW',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const [conversationCount, stepCount] = await Promise.all([
    prisma.selfRecoveryEvent.count({
      where: {
        conversationId: params.conversationId,
        status: { in: RECOVERY_SUCCESS_STATUSES }
      }
    }),
    prisma.selfRecoveryEvent.count({
      where: {
        conversationId: params.conversationId,
        stepNumber: skipCheck.recoveryStep.stepNumber,
        status: { in: RECOVERY_SUCCESS_STATUSES }
      }
    })
  ]);
  if (conversationCount >= 2 || stepCount >= 1) {
    const event = await createRecoveryEvent({
      accountId: params.accountId,
      snapshot,
      step: skipCheck.recoveryStep,
      triggerReason: 'recovery_circuit_breaker',
      recoveryAction: null,
      status: 'FAILED',
      failureReason: 'recovery_circuit_breaker',
      priority: 'HOT',
      metadata: {
        recoveryCountForConversation: conversationCount,
        recoveryCountForCurrentStep: stepCount,
        circuitBreakerTriggered: true,
        plannedStep: skipCheck.plannedStepKey,
        missingSteps: skipCheck.missingSteps.map(normalizedStepKey)
      },
      llmEmittedStage: params.llmEmittedStage ?? null
    }).catch(() => null);
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: 'recovery_circuit_breaker',
      eventId: event?.id ?? null,
      priority: 'HOT',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const actionType = inferActionType(skipCheck.recoveryStep);
  let messages: string[] = [];
  let recoveryAction = 'EMIT_BRIDGING_REQUALIFICATION';
  let artifactField: string | null = null;

  if (recoveryStepAlreadyAsked(skipCheck.recoveryStep, params.history)) {
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: 'recovery_step_already_asked_wait_for_answer',
      eventId: null,
      priority: priorityForSkipRecovery(params.history),
      systemStage: snapshot.systemStage,
      currentScriptStep: skipCheck.recoveryStep.stepNumber
    };
  }

  if (actionType === 'ASK_QUESTION') {
    messages = await buildBridgingMessages({
      accountId: params.accountId,
      snapshot,
      currentStep: skipCheck.recoveryStep,
      skippedAheadStep: skipCheck.plannedStep,
      skippedAheadStepKey: skipCheck.plannedStepKey
    });
  } else {
    const deterministic = buildDeterministicAction({
      snapshot,
      step: skipCheck.recoveryStep
    });
    if ('failed' in deterministic) {
      const event = await createRecoveryEvent({
        accountId: params.accountId,
        snapshot,
        step: skipCheck.recoveryStep,
        triggerReason: params.triggerReason,
        recoveryAction: null,
        status: 'FAILED',
        failureReason: deterministic.reason,
        priority: 'HOT',
        metadata: {
          plannedStep: skipCheck.plannedStepKey,
          missingSteps: skipCheck.missingSteps.map(normalizedStepKey)
        },
        llmEmittedStage: params.llmEmittedStage ?? null
      }).catch(() => null);
      return {
        recovered: false,
        messages: [],
        reply: '',
        stage: '',
        subStage: null,
        capitalOutcome: 'not_evaluated',
        recoveryAction: null,
        reason: deterministic.reason,
        eventId: event?.id ?? null,
        priority: 'HOT',
        systemStage: snapshot.systemStage,
        currentScriptStep: snapshot.currentScriptStep
      };
    }
    messages = deterministic.messages;
    recoveryAction = deterministic.actionType;
    artifactField = deterministic.artifactField;
  }

  const normalizedMessages = normalizeRecoveryMessages(messages);
  if (normalizedMessages.length === 0) {
    const event = await createRecoveryEvent({
      accountId: params.accountId,
      snapshot,
      step: skipCheck.recoveryStep,
      triggerReason: params.triggerReason,
      recoveryAction: null,
      status: 'FAILED',
      failureReason: 'bridging_message_empty',
      priority: 'HOT',
      metadata: {
        plannedStep: skipCheck.plannedStepKey,
        missingSteps: skipCheck.missingSteps.map(normalizedStepKey)
      },
      llmEmittedStage: params.llmEmittedStage ?? null
    }).catch(() => null);
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: 'bridging_message_empty',
      eventId: event?.id ?? null,
      priority: 'HOT',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const priority = priorityForSkipRecovery(params.history);
  const stageInfo = stageForRecovery(
    artifactField,
    actionType,
    snapshot.capturedDataPoints
  );
  const event = await createRecoveryEvent({
    accountId: params.accountId,
    snapshot,
    step: skipCheck.recoveryStep,
    triggerReason: params.triggerReason,
    recoveryAction,
    status: params.approvalMode ? 'PENDING_APPROVAL' : 'SUCCEEDED',
    priority,
    generatedMessages: normalizedMessages,
    metadata: {
      recoveryCountForConversation: conversationCount + 1,
      recoveryCountForCurrentStep: stepCount + 1,
      circuitBreakerTriggered: false,
      plannedStep: skipCheck.plannedStepKey,
      plannedStepNumber: skipCheck.plannedStepNumber,
      plannedActionKind: skipCheck.plannedActionKind,
      missingSteps: skipCheck.missingSteps.map(normalizedStepKey),
      sourceDataPoints: snapshot.capturedDataPoints
    },
    llmEmittedStage: params.llmEmittedStage ?? null
  });

  if (params.approvalMode) {
    await prisma.aISuggestion
      .create({
        data: {
          conversationId: params.conversationId,
          accountId: params.accountId,
          responseText: normalizedMessages[0] || '',
          messageBubbles:
            normalizedMessages.length > 1
              ? (normalizedMessages as Prisma.InputJsonValue)
              : undefined,
          bubbleCount: normalizedMessages.length || 1,
          retrievalTier: null,
          qualityGateAttempts: 1,
          qualityGateScore: null,
          qualityGatePassedFirstAttempt: true,
          intentClassification: 'mid_conversation_requalification',
          intentConfidence: null,
          leadStageSnapshot: null,
          leadTypeSnapshot: null,
          aiStageReported: stageInfo.stage,
          aiSubStageReported: stageInfo.subStage,
          capitalOutcome: stageInfo.capitalOutcome,
          generatedDuringTrainingPhase: false,
          modelUsed: 'script-step-skip-recovery'
        }
      })
      .catch((err) =>
        console.error(
          '[script-state] skip-recovery AISuggestion create failed:',
          err
        )
      );
  } else {
    await prisma.conversation
      .update({
        where: { id: params.conversationId },
        data: { selfRecoveryCount: { increment: 1 } }
      })
      .catch((err) =>
        console.error('[script-state] selfRecoveryCount update failed:', err)
      );
  }

  return {
    recovered: true,
    messages: normalizedMessages,
    reply: normalizedMessages[0] || '',
    stage: stageInfo.stage,
    subStage: stageInfo.subStage,
    capitalOutcome: stageInfo.capitalOutcome,
    recoveryAction,
    reason: `Mid-conversation skip detected: attempted ${skipCheck.plannedStepKey} before completing ${normalizedStepKey(skipCheck.recoveryStep)}`,
    eventId: event.id,
    priority,
    systemStage: snapshot.systemStage,
    currentScriptStep: skipCheck.recoveryStep.stepNumber
  };
}

export async function attemptMidConversationRequalification(params: {
  accountId: string;
  conversationId: string;
  history: ScriptHistoryMessage[];
  triggerReason?: string;
  llmEmittedStage?: string | null;
  approvalMode?: boolean;
}): Promise<RecoveryResult> {
  return attemptStepSkipRecovery({
    accountId: params.accountId,
    conversationId: params.conversationId,
    history: params.history,
    triggerReason: params.triggerReason || 'mid_conversation_requalification',
    llmEmittedStage: params.llmEmittedStage ?? null,
    approvalMode: params.approvalMode
  });
}

export async function markSelfRecoveryEventFailed(
  eventId: string | null | undefined,
  failureReason: string
) {
  if (!eventId) return;
  await prisma.selfRecoveryEvent
    .update({
      where: { id: eventId },
      data: { status: 'FAILED', failureReason }
    })
    .catch((err) =>
      console.error('[script-state] recovery event failure update failed:', err)
    );
}

export async function attemptSelfRecovery(params: {
  accountId: string;
  conversationId: string;
  history: ScriptHistoryMessage[];
  triggerReason: string;
  llmEmittedStage?: string | null;
  approvalMode?: boolean;
}): Promise<RecoveryResult> {
  const snapshot = await prepareScriptState({
    accountId: params.accountId,
    conversationId: params.conversationId,
    history: params.history
  });

  const latestLead = [...params.history]
    .reverse()
    .find((m) => m.sender === 'LEAD');
  if (latestLead) {
    try {
      const { detectDistress } = await import('@/lib/distress-detector');
      const distress = await detectDistress(latestLead.content);
      if (distress.detected) {
        await createRecoveryEvent({
          accountId: params.accountId,
          snapshot,
          step: snapshot.currentStep,
          triggerReason: params.triggerReason,
          recoveryAction: null,
          status: 'FAILED',
          failureReason: 'distress_bypass',
          priority: 'HOT',
          metadata: {
            distressLabel: distress.label,
            distressMatch: distress.match
          },
          llmEmittedStage: params.llmEmittedStage ?? null
        }).catch(() => null);
        return {
          recovered: false,
          messages: [],
          reply: '',
          stage: '',
          subStage: null,
          capitalOutcome: 'not_evaluated',
          recoveryAction: null,
          reason: 'distress_bypass',
          eventId: null,
          priority: 'HOT',
          systemStage: snapshot.systemStage,
          currentScriptStep: snapshot.currentScriptStep
        };
      }
    } catch {
      // The main distress gates remain authoritative. If this optional
      // check fails, continue and let caller's normal safety path decide.
    }
  }

  if (!snapshot.script || !snapshot.currentStep || !snapshot.leadId) {
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: snapshot.reason,
      eventId: null,
      priority: 'LOW',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const [conversationCount, stepCount] = await Promise.all([
    prisma.selfRecoveryEvent.count({
      where: {
        conversationId: params.conversationId,
        status: { in: RECOVERY_SUCCESS_STATUSES }
      }
    }),
    prisma.selfRecoveryEvent.count({
      where: {
        conversationId: params.conversationId,
        stepNumber: snapshot.currentStep.stepNumber,
        status: { in: RECOVERY_SUCCESS_STATUSES }
      }
    })
  ]);
  if (conversationCount >= 2 || stepCount >= 1) {
    const event = await createRecoveryEvent({
      accountId: params.accountId,
      snapshot,
      step: snapshot.currentStep,
      triggerReason: 'recovery_circuit_breaker',
      recoveryAction: null,
      status: 'FAILED',
      failureReason: 'recovery_circuit_breaker',
      priority: 'HOT',
      metadata: {
        recoveryCountForConversation: conversationCount,
        recoveryCountForCurrentStep: stepCount,
        circuitBreakerTriggered: true
      },
      llmEmittedStage: params.llmEmittedStage ?? null
    }).catch(() => null);
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: 'recovery_circuit_breaker',
      eventId: event?.id ?? null,
      priority: 'HOT',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const action = buildDeterministicAction({
    snapshot,
    step: snapshot.currentStep
  });
  if ('failed' in action) {
    const event = await createRecoveryEvent({
      accountId: params.accountId,
      snapshot,
      step: snapshot.currentStep,
      triggerReason: params.triggerReason,
      recoveryAction: null,
      status: 'FAILED',
      failureReason: action.reason,
      priority: 'HOT',
      metadata: {
        recoveryCountForConversation: conversationCount,
        recoveryCountForCurrentStep: stepCount,
        circuitBreakerTriggered: false
      },
      llmEmittedStage: params.llmEmittedStage ?? null
    }).catch(() => null);
    return {
      recovered: false,
      messages: [],
      reply: '',
      stage: '',
      subStage: null,
      capitalOutcome: 'not_evaluated',
      recoveryAction: null,
      reason: action.reason,
      eventId: event?.id ?? null,
      priority: 'HOT',
      systemStage: snapshot.systemStage,
      currentScriptStep: snapshot.currentScriptStep
    };
  }

  const normalizedMessages = normalizeRecoveryMessages(action.messages);
  const priority = priorityForRecovery(
    action.artifactField,
    snapshot.capturedDataPoints
  );
  const stageInfo = stageForRecovery(
    action.artifactField,
    action.actionType,
    snapshot.capturedDataPoints
  );
  const event = await createRecoveryEvent({
    accountId: params.accountId,
    snapshot,
    step: action.step,
    triggerReason: params.triggerReason,
    recoveryAction: action.actionType,
    status: params.approvalMode ? 'PENDING_APPROVAL' : 'SUCCEEDED',
    priority,
    generatedMessages: normalizedMessages,
    metadata: {
      recoveryCountForConversation: conversationCount + 1,
      recoveryCountForCurrentStep: stepCount + 1,
      circuitBreakerTriggered: false,
      artifactField: action.artifactField,
      sourceDataPoints: snapshot.capturedDataPoints
    },
    llmEmittedStage: params.llmEmittedStage ?? null
  });

  if (params.approvalMode) {
    await prisma.aISuggestion
      .create({
        data: {
          conversationId: params.conversationId,
          accountId: params.accountId,
          responseText: normalizedMessages[0] || '',
          messageBubbles:
            normalizedMessages.length > 1
              ? (normalizedMessages as Prisma.InputJsonValue)
              : undefined,
          bubbleCount: normalizedMessages.length || 1,
          retrievalTier: null,
          qualityGateAttempts: 1,
          qualityGateScore: null,
          qualityGatePassedFirstAttempt: true,
          intentClassification: 'self_recovery',
          intentConfidence: null,
          leadStageSnapshot: null,
          leadTypeSnapshot: null,
          aiStageReported: stageInfo.stage,
          aiSubStageReported: stageInfo.subStage,
          capitalOutcome: stageInfo.capitalOutcome,
          generatedDuringTrainingPhase: false,
          modelUsed: 'script-state-recovery'
        }
      })
      .catch((err) =>
        console.error(
          '[script-state] approval-mode AISuggestion create failed:',
          err
        )
      );
  }

  if (!params.approvalMode) {
    await prisma.conversation
      .update({
        where: { id: params.conversationId },
        data: { selfRecoveryCount: { increment: 1 } }
      })
      .catch((err) =>
        console.error('[script-state] selfRecoveryCount update failed:', err)
      );
  }

  return {
    recovered: true,
    messages: normalizedMessages,
    reply: normalizedMessages[0] || '',
    stage: stageInfo.stage,
    subStage: stageInfo.subStage,
    capitalOutcome: stageInfo.capitalOutcome,
    recoveryAction: action.actionType,
    reason: action.reason,
    eventId: event.id,
    priority,
    systemStage: snapshot.systemStage,
    currentScriptStep: action.step.stepNumber
  };
}

export function isSelfRecoveryTrigger(params: {
  escalateToHuman?: boolean | null;
  stallType?: string | null;
  message?: string | null;
  messages?: string[] | null;
}): { triggered: boolean; reason: string | null } {
  if (params.escalateToHuman) {
    return { triggered: true, reason: 'llm_escalated' };
  }
  if (params.stallType) {
    return { triggered: true, reason: `stall_type_${params.stallType}` };
  }
  const text = (
    Array.isArray(params.messages) && params.messages.length > 0
      ? params.messages.join(' ')
      : params.message || ''
  ).toLowerCase();
  if (
    /\b(double.?check|give me a sec|gimme a sec|lemme check|let me check|checking with|not sure what next|point you wrong)\b/i.test(
      text
    )
  ) {
    return { triggered: true, reason: 'stall_message_detected' };
  }
  return { triggered: false, reason: null };
}

/**
 * F5.1 (2026-05-30) — passive capital signal phrases.
 *
 * The script's R24 gate only fires when an AI capital question has been asked
 * AND the lead answers it. But leads often mention their capital unsolicited
 * — e.g. answering "what does your job pay?" with "9-5 pays 6k and I have
 * around 5k saved to put toward this." Without a passive scan, that 5k
 * never becomes `verifiedCapitalUsd`, the resolver blocks at
 * `cannot_be_qualified_without_capital_verification`, and the lead is stuck.
 *
 * These phrases are positive capital signals — "lead is talking about money
 * they HAVE." `PASSIVE_NEGATIVE_CONTEXT` catches obvious anti-signals
 * ("lost 5k", "made 5k last month") that `parseLeadCapitalAnswer` would
 * otherwise pass as kind='amount' since its disqualifier list is narrower.
 */
// P0 hardening (2026-07-26): the (invest|put|commit|spend) branch matched
// "so I can SPEND more TIME with my family" — spending TIME, not money — and
// that false signal is what minted capital from an income goal on Ahmed Shah.
// The verb branch now refuses time/energy/effort objects.
const PASSIVE_CAPITAL_SIGNAL_PHRASES =
  /\b(i\s+have(\s+(around|about|roughly|currently))?|i'?ve\s+(got|saved)|i\s+saved|saved\s+up|i\s+(can|will|am\s+ready\s+to)\s+(invest|put|commit|spend)(?!\s+(more\s+)?(time|energy|effort|hours))|i'?m\s+(putting|investing|working\s+with|ready\s+to\s+(invest|put))|my\s+budget(\s+is)?|i\s+got(\s+about|\s+around)?\s+\S+\s+(saved|to\s+(invest|put|spend|use)))\b/i;

/**
 * Negative-context guard: phrases that put a number in an anti-capital
 * frame ("lost 5k", "made 5k last month", "owe 5k"). `parseLeadCapitalAnswer`
 * doesn't catch all of these as disqualifiers, so this guards against the
 * passive scan over-qualifying. Conservative on purpose — a false positive
 * here (we reject a real capital statement) is recoverable on the next turn;
 * a false negative (we accept a fake capital statement) silently lets an
 * unqualified lead through to booking.
 */
const PASSIVE_NEGATIVE_CONTEXT =
  /\b(i\s+(lost|made|owe|spent|wasted|blew|burned|earn|earned|make)|lost\s+(in\s+)?(the\s+)?(market|trade|trading)|i'?m\s+(making|earning|losing|paying)|my\s+(salary|income|paycheck|job\s+pays?)|my\s+(current\s+)?(income|revenue)\s+goal|paid?\s+(me|us)\s+\$?\d)/i;

/**
 * F5.1 passive scan: when the LLM emits a high-intent stage but capital was
 * never asked-and-answered, walk the recent LEAD history for an unsolicited
 * capital statement that beats the persona's `minimumCapitalRequired`. On
 * match, persist `verifiedCapitalUsd` + `capitalThresholdMet` so the existing
 * resolver naturally returns QUALIFIED on this turn and every turn after.
 *
 * Returns null if nothing qualifying is found — the caller falls through to
 * the existing "cannot_be_qualified" branch in that case.
 */
async function scanForPassiveCapitalQualification(
  conversationId: string
): Promise<{
  amount: number;
  threshold: number;
  sourceMessageId: string;
} | null> {
  let threshold: number | null = null;
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        lead: {
          select: {
            account: {
              select: {
                personas: {
                  take: 1,
                  select: { minimumCapitalRequired: true, promptConfig: true }
                }
              }
            }
          }
        }
      }
    });
    const persona = row?.lead?.account?.personas?.[0] ?? null;
    // P0 (2026-07-26): low-ticket personas have no capital step — the passive
    // scan must never qualify/disqualify on capital for them.
    if (
      (persona?.promptConfig as Record<string, unknown> | null | undefined)
        ?.disableLeadStageProgression === true
    ) {
      return null;
    }
    threshold = persona?.minimumCapitalRequired ?? null;
  } catch {
    return null;
  }
  if (!threshold || threshold <= 0) return null;

  let leads: { id: string; content: string }[] = [];
  try {
    leads = await prisma.message.findMany({
      where: { conversationId, sender: 'LEAD' },
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: { id: true, content: true }
    });
  } catch {
    return null;
  }

  // Dynamic import to avoid the ai-engine ↔ script-state-recovery circular dep.
  const aiEngine: typeof import('@/lib/ai-engine') = await import(
    '@/lib/ai-engine'
  );

  for (const m of leads) {
    if (!PASSIVE_CAPITAL_SIGNAL_PHRASES.test(m.content)) continue;
    if (PASSIVE_NEGATIVE_CONTEXT.test(m.content)) continue;
    const parsed = aiEngine.parseLeadCapitalAnswer(m.content);
    if (parsed.kind !== 'amount' || parsed.amount === null) continue;
    const usd = aiEngine.convertCapitalAmountToUsd(
      parsed.amount,
      parsed.currency ?? null
    );
    if (usd >= threshold) {
      await persistPassiveCapital(conversationId, usd, m.id);
      return { amount: usd, threshold, sourceMessageId: m.id };
    }
  }
  return null;
}

async function persistPassiveCapital(
  conversationId: string,
  amountUsd: number,
  sourceMessageId: string
): Promise<void> {
  try {
    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { capturedDataPoints: true }
    });
    const existing = (row?.capturedDataPoints as Record<string, unknown>) ?? {};
    const now = new Date().toISOString();
    const pointMeta = {
      confidence: 'HIGH' as const,
      extractedAt: now,
      extractionMethod: 'passive_lead_message_scan',
      extractedFromMessageId: sourceMessageId
    };
    const next = {
      ...existing,
      verifiedCapitalUsd: { ...pointMeta, value: amountUsd },
      capitalThresholdMet: { ...pointMeta, value: true }
    };
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        capturedDataPoints: next as Prisma.InputJsonValue,
        capitalVerificationStatus: 'VERIFIED_QUALIFIED',
        capitalVerifiedAt: new Date(),
        capitalVerifiedAmount: amountUsd
      }
    });
    console.log(
      `[script-state-recovery] F5.1 passive capital qualified conversation=${conversationId} amount=$${amountUsd} source=${sourceMessageId}`
    );
  } catch (err) {
    console.error(
      '[script-state-recovery] persistPassiveCapital failed (non-fatal):',
      err
    );
  }
}

export async function applyStageOverride(params: {
  conversationId: string;
  llmEmittedStage: string | null | undefined;
  currentStage: string;
  capitalOutcome: RecoveryResult['capitalOutcome'];
  snapshot?: ScriptStateSnapshot | null;
}): Promise<{
  finalStage: string;
  capitalOutcome: RecoveryResult['capitalOutcome'];
  reason: string | null;
  stageMismatchCount?: number;
}> {
  const snapshot =
    params.snapshot ??
    (await prepareScriptState({
      accountId: '',
      conversationId: params.conversationId,
      history: []
    }).catch(() => null));
  const points = snapshot?.capturedDataPoints ?? {};
  const thresholdMet = pointValue<boolean>(points, 'capitalThresholdMet');
  const verifiedCapital = pointValue<number>(points, 'verifiedCapitalUsd');
  const llmStage = (params.llmEmittedStage || params.currentStage || '').trim();

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: { llmEmittedStage: llmStage || null }
    })
    .catch(() => null);

  if (thresholdMet === true) {
    const shouldKeepBookingStage = /^(BOOKING|CALL_PROPOSED|BOOKED)$/i.test(
      params.currentStage
    );
    return {
      finalStage: shouldKeepBookingStage ? params.currentStage : 'QUALIFIED',
      capitalOutcome: 'passed',
      reason: /^(UNQUALIFIED|NOT_QUALIFIED)$/i.test(llmStage)
        ? 'capital_threshold_met_overrides_unqualified'
        : 'capital_threshold_met_authoritative'
    };
  }

  if (thresholdMet === false && verifiedCapital !== null) {
    return {
      finalStage: 'UNQUALIFIED',
      capitalOutcome: 'failed',
      reason: 'capital_below_threshold_explicit'
    };
  }

  if (/^(UNQUALIFIED|NOT_QUALIFIED)$/i.test(llmStage || params.currentStage)) {
    const capitalAnswered = verifiedCapital !== null || thresholdMet !== null;
    const convo = await prisma.conversation
      .findUnique({
        where: { id: params.conversationId },
        select: {
          outcome: true,
          lead: { select: { accountId: true } },
          messages: {
            orderBy: { timestamp: 'desc' },
            take: 30,
            select: { sender: true, content: true }
          }
        }
      })
      .catch(() => null);
    const capitalAsked =
      convo?.messages.some(
        (message) =>
          (message.sender === 'AI' || message.sender === 'HUMAN') &&
          containsCapitalQuestion(message.content)
      ) ?? false;

    if (!capitalAsked || !capitalAnswered) {
      console.warn(
        `[script-state-recovery] PREMATURE_UNQUALIFIED_BLOCKED for ${params.conversationId}: stage=${llmStage || params.currentStage}, capitalAsked=${capitalAsked}, capitalAnswered=${capitalAnswered}`
      );
      if (convo?.outcome === 'UNQUALIFIED_REDIRECT') {
        await prisma.conversation
          .update({
            where: { id: params.conversationId },
            data: { outcome: 'ONGOING' }
          })
          .catch(() => null);
      }
      if (convo?.lead?.accountId) {
        await prisma.bookingRoutingAudit
          .create({
            data: {
              accountId: convo.lead.accountId,
              conversationId: params.conversationId,
              personaMinimumCapital: null,
              routingAllowed: false,
              regenerationForced: true,
              blockReason: 'PREMATURE_UNQUALIFIED_BLOCKED',
              aiStageReported: llmStage || params.currentStage,
              aiSubStageReported: null,
              contentPreview: `capitalAsked=${capitalAsked}; capitalAnswered=${capitalAnswered}`
            }
          })
          .catch(() => null);
      }
      return {
        finalStage: 'QUALIFYING',
        capitalOutcome:
          params.capitalOutcome === 'failed'
            ? 'not_evaluated'
            : params.capitalOutcome,
        reason: 'cannot_unqualify_without_capital_qualification'
      };
    }
  }

  if (
    /^(QUALIFIED|BOOKED|BOOKING|CALL_PROPOSED|SEND_APPLICATION_LINK)$/i.test(
      llmStage || params.currentStage || ''
    ) &&
    verifiedCapital === null
  ) {
    // F5.1 (2026-05-30) — passive capital scan. The R24 path only fires when
    // an AI capital question was asked AND the lead answered. Leads frequently
    // mention capital unsolicited ("I have around 5k saved up") in response
    // to unrelated discovery questions; without this scan the conversation is
    // stuck at QUALIFYING forever while the LLM keeps emitting BOOKING.
    const passive = await scanForPassiveCapitalQualification(
      params.conversationId
    );
    if (passive) {
      // Capital persisted by the helper — honor the LLM's high-intent stage
      // (BOOKING / CALL_PROPOSED / etc.) since the lead is now qualified.
      const keepBookingStage = /^(BOOKING|CALL_PROPOSED|BOOKED)$/i.test(
        params.currentStage
      );
      return {
        finalStage: keepBookingStage ? params.currentStage : llmStage,
        capitalOutcome: 'passed',
        reason: 'passive_capital_scan_qualified'
      };
    }

    return {
      finalStage: 'QUALIFYING',
      capitalOutcome:
        params.capitalOutcome === 'passed'
          ? 'not_evaluated'
          : params.capitalOutcome,
      reason: 'cannot_be_qualified_without_capital_verification'
    };
  }

  const systemStage = snapshot?.systemStage || null;

  // Reset mismatch counter when stages agree — previously the counter only ever
  // incremented and was never cleared, so a single disagreement run at count 3+
  // locked system stage authoritative for the rest of the conversation even after
  // the stages converged again.
  if (systemStage && llmStage && systemStage === llmStage) {
    await prisma.conversation
      .update({
        where: { id: params.conversationId },
        data: { stageMismatchCount: 0 }
      })
      .catch(() => null);
  }

  if (systemStage && llmStage && systemStage !== llmStage) {
    const updated = await prisma.conversation
      .update({
        where: { id: params.conversationId },
        data: { stageMismatchCount: { increment: 1 } },
        select: { stageMismatchCount: true }
      })
      .catch(() => null);
    if ((updated?.stageMismatchCount ?? 0) > 2) {
      // Hard ceiling: if the system stage has overridden the LLM > 15 times,
      // the computed systemStage itself is stuck (e.g. step completion failure
      // in a large history). Trust the LLM stage at that point.
      if ((updated?.stageMismatchCount ?? 0) > 15) {
        return {
          finalStage: params.currentStage,
          capitalOutcome: params.capitalOutcome,
          reason: 'llm_stage_trusted_after_system_stuck',
          stageMismatchCount: updated?.stageMismatchCount
        };
      }
      return {
        finalStage: systemStage,
        capitalOutcome: params.capitalOutcome,
        reason: 'system_stage_authoritative_after_repeated_mismatch',
        stageMismatchCount: updated?.stageMismatchCount
      };
    }
    return {
      finalStage: params.currentStage,
      capitalOutcome: params.capitalOutcome,
      reason: null,
      stageMismatchCount: updated?.stageMismatchCount
    };
  }

  return {
    finalStage: params.currentStage,
    capitalOutcome: params.capitalOutcome,
    reason: null
  };
}

export function extractCapturedDataPointsForTest(params: {
  existing?: Prisma.JsonValue | null;
  history: ScriptHistoryMessage[];
  script?: ScriptWithRecovery | null;
  minimumCapitalRequired?: number | null;
  durableStatus?: string | null;
  durableAmount?: number | null;
  promptConfig?: Prisma.JsonValue | null;
}): CapturedDataPoints {
  return extractDataPoints({
    existing: params.existing,
    history: params.history,
    script: params.script ?? null,
    persona: {
      minimumCapitalRequired: params.minimumCapitalRequired ?? null,
      capitalVerificationPrompt: null,
      freeValueLink: null,
      downsellConfig: null,
      promptConfig: params.promptConfig ?? null
    },
    durableStatus: params.durableStatus,
    durableAmount: params.durableAmount
  });
}
