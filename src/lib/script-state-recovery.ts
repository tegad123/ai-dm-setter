import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { containsCapitalQuestion } from '@/lib/voice-quality-gate';

export type DataPointConfidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type RecoveryPriority = 'HOT' | 'MEDIUM' | 'LOW';

export interface ScriptHistoryMessage {
  id?: string | null;
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
}

export type CapturedDataPoints = Record<string, CapturedDataPoint | undefined>;

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

function isCapturedDataPoint(value: unknown): value is CapturedDataPoint {
  return (
    !!value &&
    typeof value === 'object' &&
    'value' in value &&
    'confidence' in value
  );
}

function pointValue<T = unknown>(
  points: CapturedDataPoints,
  key: string,
  requireHigh = true
): T | null {
  const point = points[key];
  if (!isCapturedDataPoint(point)) return null;
  if (requireHigh && point.confidence !== HIGH_CONFIDENCE) return null;
  return point.value as T;
}

function pointIsHigh(points: CapturedDataPoints, key: string): boolean {
  const point = points[key];
  return isCapturedDataPoint(point) && point.confidence === HIGH_CONFIDENCE;
}

function pointIsPresent(points: CapturedDataPoints, key: string): boolean {
  const point = points[key];
  if (!isCapturedDataPoint(point)) return false;
  return point.confidence === HIGH_CONFIDENCE && point.value !== null;
}

function setPoint<T>(
  points: CapturedDataPoints,
  key: string,
  value: T,
  confidence: DataPointConfidence,
  extractedFromMessageId: string | null,
  extractionMethod: string
) {
  const existing = points[key];
  if (
    isCapturedDataPoint(existing) &&
    existing.confidence === HIGH_CONFIDENCE &&
    confidence !== HIGH_CONFIDENCE
  ) {
    return;
  }

  points[key] = {
    value,
    confidence,
    extractedFromMessageId,
    extractionMethod,
    extractedAt: new Date().toISOString()
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

function stepCompletionActionPaths(
  step: ScriptStepWithRecovery,
  selectedBranchLabel: string | null = null
): StepCompletionAction[][] {
  const directActions = step.actions.map(stepActionRef);
  if (step.branches.length === 0) {
    return [directActions];
  }

  const branches = selectedBranchLabel
    ? step.branches.filter(
        (branch) => branch.branchLabel === selectedBranchLabel
      )
    : step.branches;
  const branchActions = branches.length > 0 ? branches : step.branches;

  return branchActions.map((branch) => [
    ...directActions,
    ...branch.actions.map(stepActionRef)
  ]);
}

function selectedBranchLabelForStep(
  points: CapturedDataPoints,
  stepNumber: number
): string | null {
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

function findSetterMessageForContent(
  history: ScriptHistoryMessage[],
  requiredContent: string | null | undefined,
  afterTimeMs = Number.NEGATIVE_INFINITY
): ScriptHistoryMessage | null {
  if (!requiredContent) {
    return null;
  }

  if (contentIsRuntimePlaceholderOnly(requiredContent)) {
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
  if (step.canonicalQuestion?.trim()) return true;

  const selectedBranchLabel = selectedBranchLabelForStep(
    points,
    step.stepNumber
  );

  return stepCompletionActionPaths(step, selectedBranchLabel).some(
    (actions) => {
      const { asks, messages, waits } = waitableActionsForPath(actions);
      return asks.length > 0 || (messages.length > 0 && waits.length > 0);
    }
  );
}

function findSetterMessagesForActions(
  history: ScriptHistoryMessage[],
  actions: StepCompletionAction[],
  afterTimeMs = Number.NEGATIVE_INFINITY
): ScriptHistoryMessage[] | null {
  const sentMessages: ScriptHistoryMessage[] = [];
  let cursor = afterTimeMs;

  for (const action of actions) {
    const sent = findSetterMessageForContent(history, action.content, cursor);
    if (!sent) return null;
    sentMessages.push(sent);
    cursor = new Date(sent.timestamp).getTime();
  }

  return sentMessages;
}

function stepCompletionFromHistory(
  step: ScriptStepWithRecovery,
  points: CapturedDataPoints,
  history: ScriptHistoryMessage[],
  afterTimeMs = Number.NEGATIVE_INFINITY
): { complete: boolean; completedAt: number } {
  if (history.length === 0) {
    return { complete: false, completedAt: afterTimeMs };
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

  for (const actions of stepCompletionActionPaths(step, selectedBranchLabel)) {
    const { asks, messages, waits } = waitableActionsForPath(actions);

    for (const action of [...asks, ...canonicalCandidates]) {
      const sent = findSetterMessageForContent(
        sorted,
        action.content,
        afterTimeMs
      );
      const leadReply = sent ? hasLeadReplyAfter(sorted, sent) : null;
      if (sent && leadReply) {
        return {
          complete: true,
          completedAt: new Date(leadReply.timestamp).getTime()
        };
      }
    }

    if (asks.length === 0 && messages.length > 0 && waits.length) {
      const sentMessages = findSetterMessagesForActions(
        sorted,
        messages,
        afterTimeMs
      );
      const lastSent = sentMessages?.at(-1) ?? null;
      const leadReply = lastSent ? hasLeadReplyAfter(sorted, lastSent) : null;
      if (lastSent && leadReply) {
        return {
          complete: true,
          completedAt: new Date(leadReply.timestamp).getTime()
        };
      }
    }
  }

  return { complete: false, completedAt: afterTimeMs };
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
      delete points.verifiedCapitalUsd;
      delete points.capitalThresholdMet;
      delete points.capitalAnswerType;
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
      /course|whop|checkout|payment|purchase|module|self.?paced|session liquidity model/.test(
        text
      ) ||
      /whop|checkout/.test(lowerUrl)
    ) {
      return 100;
    }
    return -1;
  }

  if (artifactField === 'fallbackContentUrl') {
    if (/whop|checkout|typeform|zoom/.test(lowerUrl)) return -1;
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
  field: string;
  promptPattern: RegExp;
  method: string;
  parse: (leadContent: string) => T | null;
}) {
  const { points, history, field, promptPattern, method, parse } = params;
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
    const value = parse(msg.content);
    if (value !== null && value !== undefined && value !== '') {
      setPoint(points, field, value, 'HIGH', msg.id ?? null, method);
      // After successful capture, reset prompt so we don't re-capture
      // from later messages — the FIRST lead reply after the prompt
      // is the canonical answer.
      prompt = null;
    }
  }
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
}) {
  extractValueAfterPrompt({
    ...params,
    field: 'incomeGoal',
    method: 'amount_after_step_9_prompt',
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
}) {
  extractValueAfterPrompt({
    ...params,
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
    // The lead's answer to "what do you do for work" is captured as a
    // brief noun phrase. Strip leading "I work as / I'm a / I do" so
    // capturedDataPoints.workBackground stays clean ("nurse" not
    // "I work as a nurse").
    const trimmed = msg.content
      .trim()
      .replace(
        /^(i\s+work\s+as\s+(an?\s+)?|i'?m\s+(an?\s+|a\s+)?|i\s+do\s+|i'?m\s+in\s+|i\s+am\s+(an?\s+)?)/i,
        ''
      )
      .replace(/[.!,]+$/, '')
      .slice(0, 80);
    if (trimmed.length >= 2) {
      setPoint(
        points,
        'workBackground',
        trimmed,
        'HIGH',
        msg.id ?? null,
        'phrase_after_step_5_prompt'
      );
      prompt = null;
    }
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

function extractDataPoints(params: {
  existing: Prisma.JsonValue | null | undefined;
  history: ScriptHistoryMessage[];
  script: ScriptWithRecovery | null;
  persona: PersonaForRecovery | null;
  durableStatus?: string | null;
  durableAmount?: number | null;
}): CapturedDataPoints {
  const points = { ...asRecord(params.existing) } as CapturedDataPoints;
  const threshold = params.persona?.minimumCapitalRequired ?? null;

  extractCapitalDataPoints({
    points,
    history: params.history,
    threshold,
    durableStatus: params.durableStatus,
    durableAmount: params.durableAmount
  });

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
    promptPattern: /\b(course|whop|downsell|lower.ticket|497|self.paced)\b/i,
    method: 'affirmed_downsell_interest'
  });

  // Step-progression captures (bug-30): operator scripts may not have
  // runtime_judgment {{variable}} bindings for every discovery step.
  // These code-level extractors backfill the most common ones so the
  // call-proposal / capital-question / mandatory-ask gates have
  // accurate state.
  extractWorkBackground({ points, history: params.history });
  extractMonthlyIncomeFromJob({ points, history: params.history });
  extractReplaceOrSupplement({ points, history: params.history });
  extractIncomeGoal({ points, history: params.history });

  extractArtifactDeliveryDataPoints(
    points,
    params.history,
    params.script,
    params.persona
  );

  return points;
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
  let candidate: {
    step: ScriptStepWithRecovery | null;
    reason: string;
  } | null = null;

  for (const step of steps) {
    if (stepHasHistoryCompletionSignal(step, points)) {
      const historyCompletion = stepCompletionFromHistory(
        step,
        points,
        history,
        historyCursor
      );
      if (historyCompletion.complete) {
        historyCursor = historyCompletion.completedAt;
        continue;
      }

      candidate = { step, reason: 'first_incomplete_step_from_history' };
      break;
    }

    if (isStepComplete(step, points)) continue;

    candidate = { step, reason: 'first_incomplete_step' };
    break;
  }

  if (!candidate) {
    candidate = {
      step: steps.length > 0 ? steps[steps.length - 1] : null,
      reason: steps.length > 0 ? 'all_steps_complete' : 'no_active_script'
    };
  }

  const previousCurrentScriptStep = options.previousCurrentScriptStep ?? null;
  const maxAdvanceSteps = options.maxAdvanceSteps ?? 1;
  if (
    candidate.step &&
    typeof previousCurrentScriptStep === 'number' &&
    previousCurrentScriptStep > 0 &&
    maxAdvanceSteps >= 0 &&
    candidate.step.stepNumber > previousCurrentScriptStep + maxAdvanceSteps
  ) {
    const cappedStepNumber = previousCurrentScriptStep + maxAdvanceSteps;
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

  return candidate;
}

const STEP_INFERENCE_PATTERNS: Record<string, RegExp[]> = {
  SOFT_PITCH: [
    /(quick\s+)?call with (my right hand|anthony)/i,
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
    /whop\.com/i,
    /session liquidity/i,
    /self.?paced/i,
    /\bcourse link\b/i
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
        currentScriptStep: true
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
  const systemStage = computeSystemStage(
    script,
    capturedDataPoints,
    params.history,
    {
      previousCurrentScriptStep: conversation.currentScriptStep,
      maxAdvanceSteps: 1
    }
  );
  const currentStep = systemStage.step;
  const currentScriptStep = currentStep?.stepNumber ?? 1;
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

  if (script && currentStep) {
    await prisma.leadScriptPosition
      .upsert({
        where: {
          leadId_scriptId: {
            leadId: conversation.leadId,
            scriptId: script.id
          }
        },
        create: {
          leadId: conversation.leadId,
          scriptId: script.id,
          currentStepId: currentStep.id,
          status: 'active'
        },
        update: {
          currentStepId: currentStep.id
        }
      })
      .catch((err) =>
        console.error(
          '[script-state] lead script position persist failed:',
          err
        )
      );
  }

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
    reason: systemStage.reason
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
    const distress = detectDistress(latestLead.content);
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
      const distress = detectDistress(latestLead.content);
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
  if (systemStage && llmStage && systemStage !== llmStage) {
    const updated = await prisma.conversation
      .update({
        where: { id: params.conversationId },
        data: { stageMismatchCount: { increment: 1 } },
        select: { stageMismatchCount: true }
      })
      .catch(() => null);
    if ((updated?.stageMismatchCount ?? 0) > 2) {
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
  minimumCapitalRequired?: number | null;
  durableStatus?: string | null;
  durableAmount?: number | null;
}): CapturedDataPoints {
  return extractDataPoints({
    existing: params.existing,
    history: params.history,
    script: null,
    persona: {
      minimumCapitalRequired: params.minimumCapitalRequired ?? null,
      capitalVerificationPrompt: null,
      freeValueLink: null,
      downsellConfig: null,
      promptConfig: null
    },
    durableStatus: params.durableStatus,
    durableAmount: params.durableAmount
  });
}
