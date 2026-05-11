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

export function normalizeTemplateKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function extractTemplateVariableNames(text: string | null | undefined) {
  const names: string[] = [];
  const regex = /\{\{\s*([^{}]{1,160})\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text || '')) !== null) {
    const name = match[1].trim();
    if (name) names.push(name);
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

function variableAliases(variableName: string): string[] {
  const normalized = normalizeTemplateKey(variableName);
  const aliases = new Set([variableName, normalized]);
  const add = (items: string[]) => items.forEach((item) => aliases.add(item));

  if (/^(name|firstname|leadname)$/.test(normalized)) {
    add(['name', 'leadName', 'firstName']);
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

  return Array.from(aliases);
}

function resolveFromRecord(
  variableName: string,
  record: Record<string, unknown> | null | undefined
): string | null {
  if (!record) return null;
  const normalizedAliases = new Set(
    variableAliases(variableName).map((alias) => normalizeTemplateKey(alias))
  );

  for (const [key, raw] of Object.entries(record)) {
    if (!normalizedAliases.has(normalizeTemplateKey(key))) continue;
    const value = stringifyTemplateValue(unwrapCapturedPoint(raw));
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
    const content = leadMessage?.content?.trim();
    if (content && content.length >= 2) return content.slice(0, 260);
  }

  return null;
}

function fallbackForVariable(variableName: string): string {
  const normalized = normalizeTemplateKey(variableName);
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

function cleanExtractorValue(value: string | null): string | null {
  const trimmed = (value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!trimmed || /^none$/i.test(trimmed)) return null;
  if (/\{\{[^}]+\}\}/.test(trimmed)) return null;
  return trimmed.slice(0, 260);
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
    maxTokens: 80,
    temperature: 0,
    timeoutMs: 3000,
    logPrefix: '[script-variable-resolver]',
    prompt:
      `You extract one missing script variable for a sales DM conversation.\n` +
      `Conversation history:\n${history || '(none)'}\n\n` +
      `What is the lead's {{${params.variableName}}}?\n` +
      `Return ONLY the value, or NONE if the conversation does not contain it.`
  });

  return cleanExtractorValue(result.text);
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
      if (extracted) {
        resolution = {
          variableName,
          value: extracted,
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

    byNormalizedName.set(normalized, resolution);
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
    const resolution = resolutionMap.byNormalizedName.get(
      normalizeTemplateKey(String(rawName).trim())
    );
    return resolution?.value ?? match;
  });
}

export async function persistScriptVariableResolutions(params: {
  conversationId?: string | null;
  resolutions: ScriptVariableResolution[];
}): Promise<void> {
  const persistable = params.resolutions.filter(
    (resolution) => resolution.shouldPersist && resolution.source !== 'fallback'
  );
  if (!params.conversationId || persistable.length === 0) return;

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

  let changed = false;
  for (const resolution of persistable) {
    const alreadyPresent = resolveFromRecord(resolution.variableName, existing);
    if (alreadyPresent) continue;
    existing[resolution.variableName] = {
      value: resolution.value,
      confidence: resolution.confidence,
      extractedFromMessageId: null,
      extractionMethod:
        resolution.source === 'branchHistory'
          ? 'branch_history_variable_resolution'
          : 'llm_variable_resolution',
      extractedAt: new Date().toISOString(),
      variableName: resolution.variableName
    };
    changed = true;
  }

  if (!changed) return;
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { capturedDataPoints: existing as Prisma.InputJsonValue }
  });
}
