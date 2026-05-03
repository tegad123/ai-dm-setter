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

type ScriptWithRecovery = Prisma.ScriptGetPayload<{
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

type ScriptStepWithRecovery = ScriptWithRecovery['steps'][number];

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
  return [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
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
    return {
      kind: 'amount',
      amount: parsedAmount.amount,
      confidence: parsedAmount.currencyExplicit ? 'HIGH' : 'MEDIUM',
      method: parsedAmount.currencyExplicit
        ? 'specific_amount_explicit_currency'
        : 'specific_amount_currency_unclear'
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
    setPoint(
      points,
      'verifiedCapitalUsd',
      0,
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

function resolveArtifactUrl(params: {
  artifactField: string | null | undefined;
  step: ScriptStepWithRecovery | null;
  script: ScriptWithRecovery | null;
  persona: PersonaForRecovery | null;
}): string | null {
  const { artifactField, step, script, persona } = params;
  const promptConfig = parseJsonObject(persona?.promptConfig);
  const downsellConfig = parseJsonObject(persona?.downsellConfig);

  if (artifactField === 'applicationFormUrl') {
    const configured =
      promptConfig.typeformUrl ||
      promptConfig.applicationFormUrl ||
      promptConfig.applicationUrl ||
      promptConfig.bookingUrl;
    if (typeof configured === 'string' && firstUrl(configured)) {
      return firstUrl(configured);
    }
  }

  if (artifactField === 'downsellUrl') {
    const configured =
      downsellConfig.link ||
      downsellConfig.url ||
      downsellConfig.checkoutUrl ||
      promptConfig.downsellUrl;
    if (typeof configured === 'string' && firstUrl(configured)) {
      return firstUrl(configured);
    }
  }

  if (artifactField === 'fallbackContentUrl' && persona?.freeValueLink) {
    return firstUrl(persona.freeValueLink);
  }

  const candidateActions = step
    ? [...step.actions, ...step.branches.flatMap((b) => b.actions)]
    : allScriptActions(script);
  for (const action of candidateActions) {
    const direct = firstUrl(action.linkUrl);
    if (direct) return direct;
    const contentUrl = firstUrl(action.content);
    if (contentUrl) return contentUrl;
    const fieldUrl = action.form?.fields
      ?.map((field) => firstUrl(field.fieldValue))
      .find(Boolean);
    if (fieldUrl) return fieldUrl;
  }

  return null;
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
  if (!type || type === 'always_complete') return true;

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
  points: CapturedDataPoints
): { step: ScriptStepWithRecovery | null; reason: string } {
  const steps = script?.steps ?? [];
  for (const step of steps) {
    if (!isStepComplete(step, points)) {
      return { step, reason: 'first_incomplete_step' };
    }
  }
  return {
    step: steps.length > 0 ? steps[steps.length - 1] : null,
    reason: steps.length > 0 ? 'all_steps_complete' : 'no_active_script'
  };
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
        capitalVerifiedAmount: true
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
  const systemStage = computeSystemStage(script, capturedDataPoints);
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
      `bet bro, here's the course link: ${url}`,
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
