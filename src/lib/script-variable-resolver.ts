import { Prisma } from '@prisma/client';

import { callHaikuText } from '@/lib/haiku-text';
import prisma from '@/lib/prisma';

export interface ScriptVariableHistoryMessage {
  id?: string | null;
  sender: string;
  content: string;
  timestamp?: Date | string | null;
}

export interface ScriptVariableResolutionContext {
  conversationId?: string | null;
  capturedDataPoints?: Record<string, unknown> | null;
  conversationHistory?: ScriptVariableHistoryMessage[];
  leadContext?: Record<string, unknown> | null;
}

export interface ScriptVariableResolution {
  variableName: string;
  value: string;
  source:
    | 'capturedDataPoints'
    | 'leadContext'
    | 'branchHistory'
    | 'llm'
    | 'fallback';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  shouldPersist: boolean;
}

export interface ScriptVariableResolutionMap {
  byNormalizedName: Map<string, ScriptVariableResolution>;
  resolvedVariables: ScriptVariableResolution[];
}

type ScriptVariableExtractor = (params: {
  variableName: string;
  conversationHistory: ScriptVariableHistoryMessage[];
  accountId: string;
}) => Promise<string | null>;

type ScriptVariableValueKind =
  | 'name'
  | 'obstacle'
  | 'deepWhy'
  | 'desiredOutcome'
  | 'money'
  | 'datetime'
  | 'contact'
  | 'generic';

interface ScriptVariableValueSpec {
  kind: ScriptVariableValueKind;
  typeLabel: string;
  formatSpec: string;
  maxWords: number | null;
  correctExamples: string[];
  wrongExamples: string[];
}

export function normalizeTemplateKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const KNOWN_MULTI_WORD_TEMPLATE_VARIABLES = new Set([
  'day and time',
  'first name',
  'last name',
  'full name',
  'phone number',
  'email address',
  'time zone',
  'their field',
  'their job',
  'their work',
  'current work',
  'work background',
  'work situation'
]);

const SEMANTIC_TEMPLATE_VARIABLE_ALIASES = new Map<string, string>([
  ['theirstatedgoal', 'incomeGoal'],
  ['statedgoal', 'incomeGoal'],
  ['theirgoal', 'incomeGoal'],
  ['tradinggoal', 'incomeGoal'],
  ['incometarget', 'incomeGoal'],
  ['targetincome', 'incomeGoal'],
  ['targettradingincome', 'incomeGoal'],
  ['monthlytradinggoal', 'incomeGoal'],
  ['theirfield', 'workBackground'],
  ['field', 'workBackground'],
  ['theirjob', 'workBackground'],
  ['job', 'workBackground'],
  ['jobtitle', 'workBackground'],
  ['occupation', 'workBackground'],
  ['theirwork', 'workBackground'],
  ['currentwork', 'workBackground'],
  ['workbackground', 'workBackground'],
  ['worksituation', 'workBackground']
]);

const DIRECTIVE_FIRST_WORDS = new Set([
  'acknowledge',
  'address',
  'ask',
  'comment',
  'confirm',
  'greet',
  'include',
  'match',
  'mention',
  'reference',
  'respond',
  'restate',
  'say',
  'summarize',
  'use'
]);

function canonicalTemplateVariableName(variableName: string): string {
  return (
    SEMANTIC_TEMPLATE_VARIABLE_ALIASES.get(
      normalizeTemplateKey(variableName)
    ) ?? variableName
  );
}

export function isValidTemplateVariableName(
  rawName: string | null | undefined
): boolean {
  const name = (rawName || '').trim();
  if (!name || name.length > 50) return false;
  if (/["'“”‘’/\\]/.test(name)) return false;
  if (/\b(?:e\.g|i\.e|example|for example|such as)\b/i.test(name)) {
    return false;
  }
  if (/[{}()[\];:,]/.test(name)) return false;
  if (SEMANTIC_TEMPLATE_VARIABLE_ALIASES.has(normalizeTemplateKey(name))) {
    return true;
  }

  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  const firstWord = words[0] ?? '';
  if (DIRECTIVE_FIRST_WORDS.has(firstWord)) return false;
  if (/ing$/.test(firstWord)) return false;

  if (words.length > 1) {
    return (
      KNOWN_MULTI_WORD_TEMPLATE_VARIABLES.has(words.join(' ')) ||
      SEMANTIC_TEMPLATE_VARIABLE_ALIASES.has(normalizeTemplateKey(name))
    );
  }

  return /^[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*$/.test(name);
}

export function extractTemplateVariableNames(text: string | null | undefined) {
  const names: string[] = [];
  const regex = /\{\{\s*([^{}]{1,160})\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text || '')) !== null) {
    const name = match[1].trim();
    if (isValidTemplateVariableName(name)) names.push(name);
  }
  return Array.from(new Set(names));
}

function unwrapCapturedPoint(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) {
    return (raw as { value?: unknown }).value;
  }
  return raw;
}

function stringifyTemplateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return null;
}

function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function hasEmoji(value: string): boolean {
  return /[\u2600-\u27BF\uD83C-\uDBFF\uDC00-\uDFFF]/.test(value);
}

export function getVariableValueSpec(
  variableName: string
): ScriptVariableValueSpec {
  const normalized = normalizeTemplateKey(
    canonicalTemplateVariableName(variableName)
  );

  if (/^(name|firstname|leadname)$/.test(normalized)) {
    return {
      kind: 'name',
      typeLabel: 'first name',
      formatSpec: 'first name only, 1 word',
      maxWords: 1,
      correctExamples: ['Tega', 'Daniel'],
      wrongExamples: ['Tega Umukoro', 'the lead is named Tega']
    };
  }

  if (normalized.includes('obstacle') || normalized.includes('struggle')) {
    return {
      kind: 'obstacle',
      typeLabel: 'short noun phrase',
      formatSpec: '1-5 words naming the core obstacle',
      maxWords: 5,
      correctExamples: [
        'emotional control',
        'revenge trading',
        'no consistent system',
        'lack of discipline'
      ],
      wrongExamples: [
        "honestly bro it's been brutal...",
        'They struggle with emotions when trading',
        'the lead said he keeps blowing accounts after losses'
      ]
    };
  }

  if (
    normalized.includes('deepwhy') ||
    normalized.includes('reason') ||
    normalized === 'why'
  ) {
    return {
      kind: 'deepWhy',
      typeLabel: 'short reason phrase',
      formatSpec: '5-15 words describing why this matters to the lead',
      maxWords: 15,
      correctExamples: [
        'spend more time with family',
        'pay off debt and breathe again',
        'quit the nursing job'
      ],
      wrongExamples: [
        'The reason is that the lead explained a long backstory',
        "honestly I just can't keep doing this anymore bro"
      ]
    };
  }

  if (normalized.includes('desired') || normalized.includes('outcome')) {
    return {
      kind: 'desiredOutcome',
      typeLabel: 'short outcome phrase',
      formatSpec: '5-15 words describing the desired result',
      maxWords: 15,
      correctExamples: [
        'replace job income with trading',
        'make consistent income from trading',
        'build a second income stream'
      ],
      wrongExamples: [
        'The lead wants to eventually get to a place where...',
        'I want to quit my job because...'
      ]
    };
  }

  if (
    normalized.includes('income') ||
    normalized.includes('capital') ||
    normalized.includes('amount') ||
    normalized.includes('money')
  ) {
    return {
      kind: 'money',
      typeLabel: 'money amount',
      formatSpec: 'dollar amount only, like 3000, $3k, or $5,000',
      maxWords: 4,
      correctExamples: ['3000', '$3k', '$5,000'],
      wrongExamples: ['3k a month from my job', 'they want to make 5000']
    };
  }

  if (normalized.includes('day') || normalized.includes('time')) {
    return {
      kind: 'datetime',
      typeLabel: 'day/time phrase',
      formatSpec: 'short day and time phrase only',
      maxWords: 8,
      correctExamples: ['Wednesday at 2pm', 'tomorrow afternoon'],
      wrongExamples: ['The lead said Wednesday at 2pm should work for them']
    };
  }

  if (
    normalized.includes('email') ||
    normalized.includes('phone') ||
    normalized.includes('timezone')
  ) {
    return {
      kind: 'contact',
      typeLabel: 'contact field value',
      formatSpec: 'the exact contact field value only',
      maxWords: 6,
      correctExamples: ['tegad8@gmail.com', '346-295-4688', 'CT'],
      wrongExamples: ['Their email is tegad8@gmail.com']
    };
  }

  return {
    kind: 'generic',
    typeLabel: 'short phrase',
    formatSpec: 'short phrase, no full sentences',
    maxWords: 12,
    correctExamples: ['what matters most', 'consistent progress'],
    wrongExamples: ['The lead said a long explanation about their situation']
  };
}

function cleanMoneyValue(value: string): string | null {
  const compact = value.replace(/,/g, '').trim();
  const match = compact.match(/\$?\s*(\d+(?:\.\d+)?)\s*([kKmM])?\b/);
  if (!match) return null;
  const amount = match[1].replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  const suffix = match[2]?.toLowerCase() ?? '';
  if (suffix === 'k') return `$${amount}k`;
  if (suffix === 'm') return `$${amount}m`;
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount)
    ? formatCompactMoneyAmount(numericAmount)
    : null;
}

function formatCompactMoneyAmount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1000 && value % 1000 === 0) {
    return `$${value / 1000}k`;
  }
  return `$${value}`;
}

function normalizeResolvedVariableValue(
  variableName: string,
  rawValue: string | null
): string | null {
  const firstLine = (rawValue || '').split(/\r?\n/)[0] ?? '';
  let value = firstLine
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (!value || /^none\b/i.test(value)) return null;
  if (/\{\{[^}]+\}\}/.test(value)) return null;

  const spec = getVariableValueSpec(variableName);

  if (spec.kind === 'money') {
    return cleanMoneyValue(value);
  }

  if (spec.kind === 'name') {
    const first = value
      .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'-]+/g, ' ')
      .trim()
      .split(/\s+/)[0];
    return first || null;
  }

  value = value.replace(/[.。!?]+$/g, '').trim();

  const quoteLike =
    /["“”]/.test(value) ||
    hasEmoji(value) ||
    /\b(?:bro|lol|lmao|haha|man)\b/i.test(value) ||
    /^(?:honestly|literally|tbh|ngl|honestly bro|i mean)\b/i.test(value);
  if (
    quoteLike &&
    ['obstacle', 'deepWhy', 'desiredOutcome', 'generic'].includes(spec.kind)
  ) {
    return null;
  }

  if (
    ['obstacle', 'deepWhy', 'desiredOutcome', 'generic'].includes(spec.kind)
  ) {
    if (/^(?:the lead|they|he|she|i|we)\b/i.test(value)) return null;
    if (wordCount(value) > 20) return null;
  }

  if (spec.maxWords !== null && wordCount(value) > spec.maxWords) {
    return null;
  }

  return value;
}

function variableAliases(variableName: string): string[] {
  const canonicalName = canonicalTemplateVariableName(variableName);
  const normalized = normalizeTemplateKey(canonicalName);
  const aliases = new Set([
    variableName,
    normalizeTemplateKey(variableName),
    canonicalName,
    normalized
  ]);
  const add = (items: string[]) => items.forEach((item) => aliases.add(item));

  if (/^(name|firstname|leadname)$/.test(normalized)) {
    add(['name', 'leadName', 'firstName', 'fullName', 'full_name']);
  }
  if (normalized.includes('obstacle') || normalized.includes('struggle')) {
    add([
      'obstacle',
      'mainObstacle',
      'earlyObstacle',
      'early_obstacle',
      'painPoint',
      'struggle'
    ]);
  }
  if (
    normalized.includes('desired') ||
    normalized.includes('outcome') ||
    normalized.includes('deepwhy') ||
    normalized === 'why'
  ) {
    add([
      'desiredOutcome',
      'desired_outcome',
      'deepWhy',
      'deep_why',
      'goalReason',
      'why'
    ]);
  }
  if (normalized.includes('goal')) {
    add(['incomeGoal', 'income_goal', 'goal', 'desiredOutcome']);
  }
  if (normalized.includes('day') || normalized.includes('time')) {
    add(['dayAndTime', 'day_and_time', 'scheduledCallAt']);
  }
  if (
    normalized.includes('workbackground') ||
    normalized.includes('job') ||
    normalized.includes('field') ||
    normalized.includes('occupation') ||
    normalized.includes('work')
  ) {
    add([
      'workBackground',
      'work_background',
      'job',
      'occupation',
      'field',
      'theirField',
      'their_field',
      'theirJob',
      'their_job'
    ]);
  }

  return Array.from(aliases);
}

function resolveFromRecord(
  variableName: string,
  record: Record<string, unknown> | null | undefined
): string | null {
  if (!record) return null;
  const aliases = Array.from(
    new Set(
      variableAliases(variableName).map((alias) => normalizeTemplateKey(alias))
    )
  );
  const entries = Object.entries(record);

  for (const alias of aliases) {
    const matchedEntry = entries.find(
      ([key]) => normalizeTemplateKey(key) === alias
    );
    if (!matchedEntry) continue;
    const [, raw] = matchedEntry;
    const unwrapped = unwrapCapturedPoint(raw);
    const spec = getVariableValueSpec(variableName);
    const rawValue =
      spec.kind === 'money' && typeof unwrapped === 'number'
        ? formatCompactMoneyAmount(unwrapped)
        : stringifyTemplateValue(unwrapped);
    const value = normalizeResolvedVariableValue(variableName, rawValue);
    if (value) return value;
  }

  return null;
}

function resolveFromLeadContext(
  variableName: string,
  context: ScriptVariableResolutionContext
): string | null {
  const leadContext = context.leadContext || {};
  const values: Record<string, unknown> = {
    ...leadContext,
    name: leadContext.leadName,
    firstName: leadContext.leadName,
    leadName: leadContext.leadName,
    handle: leadContext.handle,
    dayAndTime:
      typeof (leadContext as { booking?: { scheduledCallAt?: unknown } })
        .booking?.scheduledCallAt === 'string'
        ? (leadContext as { booking?: { scheduledCallAt?: string } }).booking
            ?.scheduledCallAt
        : null
  };

  return resolveFromRecord(variableName, values);
}

function branchHistoryEvents(
  points: Record<string, unknown> | null | undefined
) {
  const raw = points?.branchHistory;
  return Array.isArray(raw)
    ? raw.filter((event): event is Record<string, unknown> => {
        return !!event && typeof event === 'object' && !Array.isArray(event);
      })
    : [];
}

function findMessageById(
  history: ScriptVariableHistoryMessage[],
  messageId: string | null | undefined
) {
  if (!messageId) return null;
  return history.find((message) => message.id === messageId) ?? null;
}

function inferFromBranchHistory(
  variableName: string,
  context: ScriptVariableResolutionContext
): string | null {
  const events = branchHistoryEvents(context.capturedDataPoints);
  const history = context.conversationHistory ?? [];
  if (events.length === 0 || history.length === 0) return null;
  const aliases = variableAliases(variableName).map((alias) =>
    normalizeTemplateKey(alias)
  );

  for (const event of [...events].reverse()) {
    if (event.eventType !== 'step_completed') continue;
    const searchable = [
      event.stepTitle,
      event.selectedBranchLabel,
      event.skipDirective,
      event.skipReason,
      event.currentSelectedBranch,
      event.previousSelectedBranch
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    const normalizedSearchable = normalizeTemplateKey(searchable);
    const mentionsVariable = aliases.some((alias) =>
      normalizedSearchable.includes(alias)
    );
    if (!mentionsVariable) continue;

    const leadMessage = findMessageById(
      history,
      typeof event.leadMessageId === 'string' ? event.leadMessageId : null
    );
    const content = normalizeResolvedVariableValue(
      variableName,
      leadMessage?.content?.trim() ?? null
    );
    if (content && content.length >= 2) return content;
  }

  return null;
}

function fallbackForVariable(variableName: string): string {
  const normalized = normalizeTemplateKey(
    canonicalTemplateVariableName(variableName)
  );
  if (/^(name|firstname|leadname)$/.test(normalized)) return 'bro';
  if (normalized.includes('obstacle') || normalized.includes('struggle')) {
    return 'what you mentioned earlier';
  }
  if (
    normalized.includes('desired') ||
    normalized.includes('outcome') ||
    normalized.includes('deepwhy') ||
    normalized === 'why'
  ) {
    return 'what you said matters most';
  }
  if (normalized.includes('goal')) return 'that goal';
  if (normalized.includes('day') || normalized.includes('time')) {
    return 'the time you picked';
  }
  return 'what you shared earlier';
}

function cleanExtractorValue(
  value: string | null,
  variableName = 'generic'
): string | null {
  return normalizeResolvedVariableValue(variableName, value);
}

export function parseScriptVariableExtractorValue(
  value: string | null,
  variableName?: string
): string | null {
  return cleanExtractorValue(value, variableName);
}

function buildExtractorPrompt(params: {
  variableName: string;
  history: string;
}): string {
  const spec = getVariableValueSpec(params.variableName);
  const correct = spec.correctExamples
    .map((example) => `- '${example}'`)
    .join('\n');
  const wrong = spec.wrongExamples
    .map((example) => `- '${example}'`)
    .join('\n');

  return (
    `Extract the lead's {{${params.variableName}}} from this sales DM conversation.\n` +
    `Return ONLY a short ${spec.typeLabel} in this format: ${spec.formatSpec}.\n` +
    `No explanation. No full sentences. No quote from the lead. If unclear, return NONE.\n\n` +
    `Examples of CORRECT output:\n${correct}\n\n` +
    `Examples of WRONG output:\n${wrong}\n\n` +
    `Conversation history:\n${params.history || '(none)'}\n\n` +
    `Return the value:`
  );
}

async function extractVariableWithHaiku(params: {
  variableName: string;
  conversationHistory: ScriptVariableHistoryMessage[];
  accountId: string;
}): Promise<string | null> {
  const history = params.conversationHistory
    .slice(-20)
    .map((message) => `${message.sender}: ${message.content}`)
    .join('\n');
  const result = await callHaikuText({
    accountId: params.accountId,
    maxTokens: 50,
    temperature: 0,
    timeoutMs: 3000,
    logPrefix: '[script-variable-resolver]',
    prompt: buildExtractorPrompt({
      variableName: params.variableName,
      history
    })
  });

  return cleanExtractorValue(result.text, params.variableName);
}

export async function resolveScriptVariablesForTexts(
  texts: Array<string | null | undefined>,
  params: {
    accountId: string;
    context?: ScriptVariableResolutionContext | null;
    extractor?: ScriptVariableExtractor;
  }
): Promise<ScriptVariableResolutionMap> {
  const variableNames = Array.from(
    new Set(texts.flatMap((text) => extractTemplateVariableNames(text)))
  );
  const byNormalizedName = new Map<string, ScriptVariableResolution>();
  const resolvedVariables: ScriptVariableResolution[] = [];
  const context = params.context ?? {};
  const extractor = params.extractor ?? extractVariableWithHaiku;

  for (const variableName of variableNames) {
    const normalized = normalizeTemplateKey(variableName);
    let resolution: ScriptVariableResolution | null = null;

    const direct = resolveFromRecord(variableName, context.capturedDataPoints);
    if (direct) {
      resolution = {
        variableName,
        value: direct,
        source: 'capturedDataPoints',
        confidence: 'HIGH',
        shouldPersist: false
      };
    }

    if (!resolution) {
      const leadValue = resolveFromLeadContext(variableName, context);
      if (leadValue) {
        resolution = {
          variableName,
          value: leadValue,
          source: 'leadContext',
          confidence: 'HIGH',
          shouldPersist: false
        };
      }
    }

    if (!resolution) {
      const inferred = inferFromBranchHistory(variableName, context);
      if (inferred) {
        resolution = {
          variableName,
          value: inferred,
          source: 'branchHistory',
          confidence: 'MEDIUM',
          shouldPersist: true
        };
      }
    }

    if (!resolution && (context.conversationHistory ?? []).length > 0) {
      const extracted = await extractor({
        variableName,
        conversationHistory: context.conversationHistory ?? [],
        accountId: params.accountId
      });
      const cleanExtracted = cleanExtractorValue(extracted, variableName);
      if (cleanExtracted) {
        resolution = {
          variableName,
          value: cleanExtracted,
          source: 'llm',
          confidence: 'MEDIUM',
          shouldPersist: true
        };
      }
    }

    if (!resolution) {
      resolution = {
        variableName,
        value: fallbackForVariable(variableName),
        source: 'fallback',
        confidence: 'LOW',
        shouldPersist: false
      };
    }

    const normalizedCanonical = normalizeTemplateKey(
      canonicalTemplateVariableName(variableName)
    );
    byNormalizedName.set(normalized, resolution);
    byNormalizedName.set(normalizedCanonical, resolution);
    resolvedVariables.push(resolution);
  }

  return { byNormalizedName, resolvedVariables };
}

export function applyResolvedScriptVariables(
  text: string | null | undefined,
  resolutionMap?: ScriptVariableResolutionMap | null
): string | null | undefined {
  if (!text || !resolutionMap) return text;
  return text.replace(/\{\{\s*([^{}]{1,160})\s*\}\}/g, (match, rawName) => {
    const variableName = String(rawName).trim();
    const resolution =
      resolutionMap.byNormalizedName.get(normalizeTemplateKey(variableName)) ??
      resolutionMap.byNormalizedName.get(
        normalizeTemplateKey(canonicalTemplateVariableName(variableName))
      );
    return resolution?.value ?? match;
  });
}

export async function persistScriptVariableResolutions(params: {
  conversationId?: string | null;
  resolutions: ScriptVariableResolution[];
}): Promise<void> {
  const persistable = params.resolutions.filter(
    (resolution) =>
      resolution.shouldPersist &&
      resolution.source !== 'fallback' &&
      isValidTemplateVariableName(resolution.variableName)
  );
  if (!params.conversationId) return;

  const row = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { capturedDataPoints: true }
  });
  const existing =
    row?.capturedDataPoints &&
    typeof row.capturedDataPoints === 'object' &&
    !Array.isArray(row.capturedDataPoints)
      ? ({ ...(row.capturedDataPoints as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};

  let changed = removeInvalidScriptVariableResolutionKeys(existing);
  if (persistable.length === 0) {
    if (!changed) return;
    await prisma.conversation.update({
      where: { id: params.conversationId },
      data: { capturedDataPoints: existing as Prisma.InputJsonValue }
    });
    return;
  }

  for (const resolution of persistable) {
    const persistenceName = canonicalTemplateVariableName(
      resolution.variableName
    );
    const alreadyPresent = resolveFromRecord(persistenceName, existing);
    if (alreadyPresent) continue;
    existing[persistenceName] = {
      value: resolution.value,
      confidence: resolution.confidence,
      extractedFromMessageId: null,
      extractionMethod:
        resolution.source === 'branchHistory'
          ? 'branch_history_variable_resolution'
          : 'llm_variable_resolution',
      extractedAt: new Date().toISOString(),
      variableName: persistenceName
    };
    changed = true;
  }

  if (!changed) return;
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { capturedDataPoints: existing as Prisma.InputJsonValue }
  });
}

export function removeInvalidScriptVariableResolutionKeys(
  points: Record<string, unknown>
): boolean {
  let changed = false;
  for (const [key, raw] of Object.entries(points)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const extractionMethod =
      typeof record.extractionMethod === 'string'
        ? record.extractionMethod
        : '';
    const variableName =
      typeof record.variableName === 'string' ? record.variableName : '';
    const isVariableResolution =
      extractionMethod.includes('variable_resolution') ||
      (!!variableName && variableName === key);
    if (!isVariableResolution) continue;
    if (isValidTemplateVariableName(key)) {
      const value = stringifyTemplateValue(unwrapCapturedPoint(raw));
      if (normalizeResolvedVariableValue(key, value)) continue;
    }
    delete points[key];
    changed = true;
  }
  return changed;
}
