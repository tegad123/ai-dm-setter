import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { buildDynamicSystemPrompt, getPromptVersion } from '@/lib/ai-prompts';
import type { LeadContext } from '@/lib/ai-prompts';
import { getCredentials } from '@/lib/credential-store';
import { retrieveFewShotExamples } from '@/lib/training-example-retriever';
import {
  containsCapitalQuestion,
  containsIncomeGoalQuestion,
  containsUrgencyQuestion,
  stripPreCallHomeworkFromMessages,
  scoreVoiceQualityGroup,
  detectMetadataLeak,
  surgicalStripMetadataLeak,
  classifyMessageStructure,
  isUnkeptPromise,
  isValidationOnlyMessage,
  detectTypeformFilledNoBookingContext,
  callLogisticsAlreadyDeliveredInRecentHistory,
  isAcknowledgmentOnlyLeadMessage,
  getUnacknowledgedLeadBurst,
  isExplicitAcceptance,
  aiPromisedArtifact,
  TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE,
  extractEmbeddedQuotes,
  type RequiredMessage
} from '@/lib/voice-quality-gate';
import { countCapitalQuestionAsks } from '@/lib/conversation-facts';
import {
  buildImageContextText,
  buildVoiceContextText
} from '@/lib/media-processing';
import {
  applyStageOverride,
  appendBranchHistoryEvent,
  attemptSelfRecovery,
  attemptStepSkipRecovery,
  detectAttemptedStepSkip,
  isSelfRecoveryTrigger,
  markSelfRecoveryEventFailed,
  prepareScriptState,
  validateSoftPitchPrerequisites,
  type RecoveryResult,
  type ScriptStateSnapshot
} from '@/lib/script-state-recovery';
import { resolveScriptUrgencyQuestion } from '@/lib/urgency-question-resolver';
import {
  buildPriorCapturedSignalsBlock,
  mergeCapturedDataPoints,
  parseCapturedDataPointsFromResponse
} from '@/lib/runtime-judgment-evaluator';
import {
  collectRuntimeJudgmentVariableNames,
  selectStep1BranchesForPrompt
} from '@/lib/script-serializer';
import {
  applyResolvedScriptVariables,
  isValidTemplateVariableName,
  persistScriptVariableResolutions,
  resolveScriptVariablesForTexts,
  type ScriptVariableResolutionContext,
  type ScriptVariableResolutionMap
} from '@/lib/script-variable-resolver';
import {
  countConversationTurns,
  detectBeliefBreakDeliveryStage,
  detectBeliefBreakInMessage,
  getStepActionShape,
  hasCapturedDataPoint,
  incomeGoalSatisfiedByExpectedStep,
  isRuntimePlaceholderOnly
} from '@/lib/script-step-progression';
import {
  extractUrlsFromText,
  isUrlAllowed,
  normalizeUrlForAllowlist
} from '@/lib/url-allowlist';
import { classifyCapitalAmountWithHaiku } from '@/lib/capital-amount-classifier';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  id: string;
  sender: string; // 'LEAD' | 'AI' | 'HUMAN' | internal/system senders
  content: string;
  timestamp: Date | string;
  isVoiceNote?: boolean;
  voiceNoteUrl?: string | null;
  imageUrl?: string | null;
  hasImage?: boolean;
  mediaType?: string | null;
  mediaUrl?: string | null;
  transcription?: string | null;
  imageMetadata?: Prisma.JsonValue | null;
  mediaProcessedAt?: Date | string | null;
  mediaProcessingError?: string | null;
  mediaCostUsd?: Prisma.Decimal | number | string | null;
  messageGroupId?: string | null;
  bubbleIndex?: number | null;
  bubbleTotalCount?: number | null;
  suggestionId?: string | null;
  systemPromptVersion?: string | null;
  // True when an operator unsent the prior AI/HUMAN message and
  // replaced it with this one (within 2 min). The system prompt
  // builder injects an [Operator correction] directive when the most
  // recent setter-side message has this flag, telling the LLM to
  // treat THIS message — not the unsent one — as the canonical prior
  // turn and to continue from this point.
  isHumanCorrection?: boolean;
}

function isOperatorNoteContent(content: string | null | undefined): boolean {
  return (content ?? '').trimStart().startsWith('OPERATOR NOTE:');
}

function isLeadCapitalParseCandidate(message: {
  sender?: string | null;
  content?: string | null;
}): boolean {
  if (message.sender !== 'LEAD') return false;
  if (!message.content || message.content.trim().length === 0) return false;
  if (isOperatorNoteContent(message.content)) return false;
  return true;
}

function capturedPointRawValue(
  points: Record<string, unknown> | null | undefined,
  keys: string[]
): unknown {
  if (!points) return null;
  for (const key of keys) {
    const raw = points[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const value = (raw as { value?: unknown }).value;
      if (value !== null && value !== undefined && value !== '') {
        return value;
      }
      continue;
    }
    if (raw !== '') return raw;
  }
  return null;
}

function formatGoalForDeepWhyAsk(
  rawGoal: unknown,
  fallbackLeadMessage?: string | null
): string {
  const leadGoal = (fallbackLeadMessage ?? '').match(
    /\b\d+(?:[.,]\d+)?\s*k\b(?:\s*(?:a|per)\s*month)?|\b\d{1,3}(?:,\d{3})+\b(?:\s*(?:a|per)\s*month)?/i
  )?.[0];
  if (leadGoal) return leadGoal.replace(/\s+/g, ' ').trim();

  if (typeof rawGoal === 'number' && Number.isFinite(rawGoal)) {
    if (rawGoal >= 1000 && rawGoal % 1000 === 0) {
      return `${rawGoal / 1000}k a month`;
    }
    return `${rawGoal.toLocaleString('en-US')} a month`;
  }

  if (typeof rawGoal === 'string' && rawGoal.trim()) {
    return rawGoal.trim();
  }

  return 'that goal';
}

function buildStep10DeepWhyDirective(goalText: string): string {
  return `\n\n===== STEP 10 — DEEP WHY MUST FIRE BEFORE ANY STEP 12+ CONTENT =====\nThe lead has shared their income goal but you have NOT yet captured their emotional reason behind it (deepWhy / desiredOutcome). The script REQUIRES Step 10 to fire before any obstacle re-ask, belief break, buy-in confirmation, urgency push, capital question, or call proposal.\n\nFORBIDDEN ON THIS TURN:\n  ✗ "what's your capital situation" / any question about budget, capital, savings, or how much they have\n  ✗ "what's the main thing holding you back" / any obstacle re-ask\n  ✗ Belief-break / "99% of traders" reframe\n  ✗ "would that kind of structure help" buy-in confirmation\n  ✗ "is now the time to overcome" urgency push\n  ✗ "set up a call with anthony" / any call proposal language\n  ✗ Skipping ahead because early_obstacle is already captured (early_obstacle is NOT the same signal as deepWhy)\n\nREQUIRED ON THIS TURN — Step 10 verbatim:\n  [MSG] "I respect that bro, I truly do. I hear so many people talk about cars and materialistic stuff so it's refreshing to hear this haha."\n  [ASK] "But why is ${goalText} so important to you though? Asking since the more I know the better I'll be able to help."\n\nDo NOT skip the [MSG] — send it before the [ASK] in the same turn (multi-bubble) or as the opener of a single-bubble reply.\n=====`;
}

/**
 * ManyChat-recency gate (bug-fix 2026-05-10).
 *
 * `Conversation.source` is set once at creation and never updated. When a
 * lead originally came in via a ManyChat automation weeks ago and now
 * sends a fresh direct DM on the same conversation, source=MANYCHAT is
 * stale for THIS turn — the ManyChat sequence is long gone and the lead's
 * current message is a warm inbound. Use this helper everywhere we'd
 * normally branch on "is this a ManyChat-sourced conversation" to also
 * require recent ManyChat activity.
 *
 * Window: 2 hours. Matches a typical ManyChat sequence duration
 * (opener → video → 30-min delay → follow-up ≈ 1–2 hours). Anything
 * older is a re-engagement, not a continuation.
 */
export function isManyChatRecentlyActive(
  source: string | null | undefined,
  manyChatFiredAt: Date | string | null | undefined,
  windowMs: number = 2 * 60 * 60 * 1000
): boolean {
  if ((source || '').toUpperCase() !== 'MANYCHAT') return false;
  // No firedAt timestamp recorded → trust the source attribution.
  // (Won't happen for conversations created after manychat-handoff
  // shipped, but legacy rows may lack it. Default to "active" so we
  // don't accidentally flip legitimate MANYCHAT conversations.)
  if (!manyChatFiredAt) return true;
  const firedMs =
    manyChatFiredAt instanceof Date
      ? manyChatFiredAt.getTime()
      : Date.parse(String(manyChatFiredAt));
  if (!Number.isFinite(firedMs)) return true;
  return Date.now() - firedMs < windowMs;
}

export function shouldForceColdStartStep1Inbound(params: {
  conversationHistory: ConversationMessage[];
  hasActiveScript: boolean;
  conversationSource?: string | null;
  leadSource?: string | null;
  manyChatFiredAt?: Date | string | null;
  systemStage?: string | null;
  currentScriptStep?: number | null;
  conversationMessageCount?: number | null;
}): boolean {
  if (!params.hasActiveScript) return false;

  const conversationSource = (params.conversationSource || '').toUpperCase();
  const leadSource = (params.leadSource || '').toUpperCase();
  // ManyChat counts as "explicitly outbound" only when the handoff is
  // recent (within 2 hours). Stale MANYCHAT attribution on a long-
  // dormant conversation should NOT block Step 1 Inbound cold-start
  // when the lead sends a fresh direct DM.
  const manyChatIsLive = isManyChatRecentlyActive(
    conversationSource,
    params.manyChatFiredAt
  );
  const staleManyChatConversation =
    conversationSource === 'MANYCHAT' && !manyChatIsLive;
  const leadSourceIsOutbound =
    leadSource === 'OUTBOUND' && !staleManyChatConversation;
  const explicitlyOutbound =
    manyChatIsLive ||
    conversationSource === 'MANUAL_UPLOAD' ||
    leadSourceIsOutbound;
  if (explicitlyOutbound) return false;

  const hasSetterMessage = params.conversationHistory.some(
    (m) => m.sender === 'AI' || m.sender === 'HUMAN'
  );
  if (hasSetterMessage) return false;

  const historyLooksLikeFirstInbound =
    params.conversationHistory.length === 0 ||
    (params.conversationHistory.length === 1 &&
      params.conversationHistory[0]?.sender === 'LEAD');
  if (!historyLooksLikeFirstInbound) return false;

  const dbCount = params.conversationMessageCount;
  if (typeof dbCount === 'number' && dbCount > 1) return false;
  return (
    conversationSource === 'INBOUND' ||
    leadSource === 'INBOUND' ||
    historyLooksLikeFirstInbound
  );
}

async function hasConfiguredScriptForColdStart(params: {
  accountId: string;
  personaId: string;
}): Promise<boolean> {
  const [activeRelationalScript, persona] = await Promise.all([
    prisma.script.findFirst({
      where: { accountId: params.accountId, isActive: true },
      select: { id: true }
    }),
    prisma.aIPersona.findUnique({
      where: { id: params.personaId },
      select: {
        rawScript: true,
        qualificationFlow: true,
        breakdowns: {
          where: { status: 'ACTIVE' },
          select: { id: true },
          take: 1
        }
      }
    })
  ]);

  if (activeRelationalScript) return true;
  if (!persona) return false;

  if (
    typeof persona.rawScript === 'string' &&
    persona.rawScript.trim().length > 100
  ) {
    return true;
  }

  if (persona.breakdowns.length > 0) return true;

  if (Array.isArray(persona.qualificationFlow)) {
    return persona.qualificationFlow.length > 0;
  }

  return false;
}

function buildColdStartStep1InboundDirective(): string {
  return `\n\n===== COLD START SCRIPT OVERRIDE — FIRE BEFORE ALL OTHER SCRIPT LOGIC =====\nCOLD START DETECTED. Fire Step 1 Inbound now. Do not deviate.\n\nIf this is the FIRST message in the conversation (messageCount === 0 or 1, or conversationStage is null/INIT) AND the direction is INBOUND, immediately execute Step 1 Inbound regardless of the lead's message content.\n\nThe lead's opening message is an inbound trigger, not small talk. Do NOT mirror, echo, or respond conversationally to the opener. Do NOT reply with a greeting-only message like "yo bro" / "hey man" / "what's up". Use the active script's Step 1 Inbound wording and then wait for the lead's answer.\n\nReturn the normal JSON response schema, but the lead-facing message/messages MUST be Step 1 Inbound.\n=====`;
}

async function persistColdStartStep1InboundState(params: {
  conversationId: string;
  snapshot: ScriptStateSnapshot;
}): Promise<void> {
  const firstStep =
    params.snapshot.script?.steps.find((step) => step.stepNumber === 1) ?? null;

  await prisma.conversation
    .update({
      where: { id: params.conversationId },
      data: {
        currentScriptStep: 1,
        systemStage: 'STEP_1_INBOUND'
      }
    })
    .catch((err) =>
      console.error(
        '[ai-engine] cold-start Step 1 state persist failed (non-fatal):',
        err
      )
    );

  if (firstStep && params.snapshot.leadId) {
    await prisma.leadScriptPosition
      .upsert({
        where: {
          leadId_scriptId: {
            leadId: params.snapshot.leadId,
            scriptId: firstStep.scriptId
          }
        },
        create: {
          leadId: params.snapshot.leadId,
          scriptId: firstStep.scriptId,
          currentStepId: firstStep.id,
          status: 'active'
        },
        update: {
          currentStepId: firstStep.id,
          currentBranchId: null,
          status: 'active'
        }
      })
      .catch((err) =>
        console.error(
          '[ai-engine] cold-start lead script position persist failed (non-fatal):',
          err
        )
      );
  }

  params.snapshot.currentStep = firstStep ?? params.snapshot.currentStep;
  params.snapshot.currentScriptStep = 1;
  params.snapshot.systemStage = 'STEP_1_INBOUND';
}

type LLMTextContentPart = {
  type: 'text';
  text: string;
};

type LLMImageContentPart = {
  type: 'image_url';
  image_url: {
    url: string;
    detail: 'low';
  };
};

type TemplateVariableContext = {
  capturedDataPoints?: Record<string, unknown> | null;
  leadContext?: Partial<LeadContext> | null;
  lastLeadMessage?: string | null;
};

export type TemplateVariableResolution = {
  text: string;
  resolvedVariables: string[];
  strippedVariables: string[];
};

function normalizeTemplateKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
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
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}

function resolveTemplateVariable(
  rawName: string,
  context: TemplateVariableContext
): string | null {
  const normalizedName = normalizeTemplateKey(rawName);
  const points = context.capturedDataPoints || {};

  for (const [key, raw] of Object.entries(points)) {
    if (normalizeTemplateKey(key) !== normalizedName) continue;
    const value = stringifyTemplateValue(unwrapCapturedPoint(raw));
    if (value) return value;
  }

  const leadContext = context.leadContext || {};
  const leadContextValues: Record<string, unknown> = {
    leadName: leadContext.leadName,
    name: leadContext.leadName,
    handle: leadContext.handle,
    platform: leadContext.platform,
    status: leadContext.status,
    source: leadContext.source,
    triggerType: leadContext.triggerType,
    triggerSource: leadContext.triggerSource,
    experience: leadContext.experience,
    incomeLevel: leadContext.incomeLevel,
    geography: leadContext.geography,
    timezone: leadContext.timezone,
    lastLeadMessage: context.lastLeadMessage
  };

  for (const [key, value] of Object.entries(leadContextValues)) {
    if (normalizeTemplateKey(key) !== normalizedName) continue;
    const resolved = stringifyTemplateValue(value);
    if (resolved) return resolved;
  }

  return null;
}

export function resolveOrStripTemplateVariables(
  input: string,
  context: TemplateVariableContext = {}
): TemplateVariableResolution {
  const resolvedVariables: string[] = [];
  const strippedVariables: string[] = [];

  const text = input
    .replace(/\{\{\s*([^{}]{1,160})\s*\}\}/g, (_match, rawName: string) => {
      const variableName = rawName.trim();
      if (!isValidTemplateVariableName(variableName)) {
        return variableName;
      }
      const value = resolveTemplateVariable(variableName, context);
      if (value !== null) {
        resolvedVariables.push(variableName);
        return value;
      }
      strippedVariables.push(variableName);
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

  return { text, resolvedVariables, strippedVariables };
}

type JudgeActionLike = {
  actionType: string;
  content?: string | null;
};

type JudgeBranchLike = {
  branchLabel: string;
  conditionDescription?: string | null;
  actions: JudgeActionLike[];
};

type JudgeStepLike = {
  stepNumber: number;
  title: string;
  canonicalQuestion?: string | null;
  actions: JudgeActionLike[];
  branches: JudgeBranchLike[];
};

type JudgeBranchConfidence =
  | 'high'
  | 'medium'
  | 'low'
  | 'none'
  | 'llm_classified';

export function isJudgeBranchLockConfidence(
  confidence: string | null | undefined
): boolean {
  return (
    confidence === 'high' ||
    confidence === 'medium' ||
    confidence === 'llm_classified'
  );
}

export function shouldUseSmartModeForJudgeConfidence(
  confidence: string | null | undefined
): boolean {
  return confidence === 'low' || confidence === 'none';
}

type JudgeTokenScoringResult = {
  selectedBranchLabel: string | null;
  confidence: Exclude<JudgeBranchConfidence, 'llm_classified'>;
  bestScore: number;
  secondScore: number | null;
  tied: boolean;
};

type JudgeClassifierTrace = {
  stepNumber: number | null;
  stepTitle: string | null;
  branchCount: number;
  hasRuntimeJudgment: boolean;
  leadMessageFirst100: string | null;
  tokenConfidence: JudgeTokenScoringResult['confidence'];
  tokenSelectedLabel: string | null;
  tokenBestScore: number;
  tokenSecondScore: number | null;
  tokenTied: boolean;
  tokenScoreError: string | null;
  llmAttempted: boolean;
  llmSelectedLabel: string | null;
  llmError: string | null;
  finalSelectedLabel: string | null;
  finalConfidence: JudgeBranchConfidence;
  timestamp: string;
};

export type JudgeBranchMatch = {
  branchLabel: string | null;
  confidence: JudgeBranchConfidence;
  score: number;
  tokenScoringResult?: JudgeTokenScoringResult;
  classifierTrace?: JudgeClassifierTrace;
};

export type JudgeBranchSelectionCache = Map<string, Promise<JudgeBranchMatch>>;

type JudgeBranchClassifierOutcome = {
  selectedLabel: string | null;
  error: string | null;
  timedOut: boolean;
};

type JudgeBranchClassifierResult = string | null | JudgeBranchClassifierOutcome;

type JudgeBranchClassifier = (params: {
  step: JudgeStepLike;
  leadMessage: string;
  accountId?: string | null;
}) => Promise<JudgeBranchClassifierResult>;

export type JudgeBranchViolation = {
  blocked: boolean;
  reason: string | null;
  matchedBranchLabel: string | null;
  fallbackMessages: string[];
};

const JUDGE_MATCH_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'be',
  'been',
  'but',
  'for',
  'from',
  'has',
  'have',
  'if',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'with',
  'you',
  'your'
]);

function hasRuntimeJudgmentAction(step: JudgeStepLike | null | undefined) {
  if (!step) return false;
  return [...step.actions, ...step.branches.flatMap((b) => b.actions)].some(
    (action) => action.actionType === 'runtime_judgment'
  );
}

function tokenizeForJudgeMatch(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || [])
    .map((token) => token.replace(/^'+|'+$/g, ''))
    .filter((token) => token.length >= 3 && !JUDGE_MATCH_STOPWORDS.has(token));
}

function scoreJudgeBranch(
  branch: JudgeBranchLike,
  leadMessage: string
): number {
  const leadTokens = new Set(tokenizeForJudgeMatch(leadMessage));
  if (leadTokens.size === 0) return 0;

  const branchText = judgeBranchRoutingText(branch).toLowerCase();
  const branchTokens = tokenizeForJudgeMatch(branchText);
  let score = 0;

  for (const token of branchTokens) {
    if (leadTokens.has(token)) score += 2;
  }

  const normalizedLead = leadMessage.toLowerCase();
  if (/\b(start|beginner|new|never|learning|learn)\b/.test(branchText)) {
    if (
      /\b(start|starting|started|beginner|new|never|learning|learn)\b/.test(
        normalizedLead
      )
    ) {
      score += 4;
    }
  }
  if (/\b(not|no|never|haven'?t|hasn'?t|isn'?t|aren'?t)\b/.test(branchText)) {
    if (
      /\b(not|no|never|haven'?t|hasn'?t|isn'?t|aren'?t|don'?t)\b/.test(
        normalizedLead
      )
    ) {
      score += 3;
    }
  }
  if (
    /\b(already|currently|active|experienced|doing|done)\b/.test(branchText)
  ) {
    if (
      /\b(already|currently|active|been|doing|done|experience|experienced)\b/.test(
        normalizedLead
      )
    ) {
      score += 3;
    }
  }

  return score;
}

function judgeBranchRoutingText(branch: JudgeBranchLike): string {
  const runtimeJudgmentText = branch.actions
    .filter(
      (action) =>
        action.actionType === 'runtime_judgment' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    )
    .map((action) => String(action.content).trim());

  return [
    branch.branchLabel,
    branch.conditionDescription || '',
    ...runtimeJudgmentText
  ]
    .filter(Boolean)
    .join(' ');
}

function scoreJudgeBranchesForLead(
  step: JudgeStepLike | null | undefined,
  leadMessage: string | null | undefined
): JudgeBranchMatch {
  if (!step || !hasRuntimeJudgmentAction(step) || !leadMessage?.trim()) {
    return {
      branchLabel: null,
      confidence: 'none',
      score: 0,
      tokenScoringResult: {
        selectedBranchLabel: null,
        confidence: 'none',
        bestScore: 0,
        secondScore: null,
        tied: false
      }
    };
  }

  const scored = step.branches
    .map((branch) => ({
      branch,
      score: scoreJudgeBranch(branch, leadMessage)
    }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  const tied = !!second && best?.score === second.score;

  if (!best || best.score <= 0) {
    return {
      branchLabel: null,
      confidence: 'none',
      score: best?.score ?? 0,
      tokenScoringResult: {
        selectedBranchLabel: null,
        confidence: 'none',
        bestScore: best?.score ?? 0,
        secondScore: second?.score ?? null,
        tied
      }
    };
  }

  const closeTokenMargin = !!second && best.score - second.score <= 2;
  if (best.score < 3 || tied || closeTokenMargin) {
    return {
      branchLabel: null,
      confidence: 'low',
      score: best.score,
      tokenScoringResult: {
        selectedBranchLabel: best.branch.branchLabel,
        confidence: 'low',
        bestScore: best.score,
        secondScore: second?.score ?? null,
        tied
      }
    };
  }

  const confidence =
    best.score >= 7 || !second || best.score - second.score >= 4
      ? 'high'
      : 'medium';

  return {
    branchLabel: best.branch.branchLabel,
    confidence,
    score: best.score,
    tokenScoringResult: {
      selectedBranchLabel: best.branch.branchLabel,
      confidence,
      bestScore: best.score,
      secondScore: second?.score ?? null,
      tied
    }
  };
}

function buildJudgeBranchSelectionCacheKey(
  step: JudgeStepLike,
  leadMessage: string
) {
  const branchSignature = step.branches
    .map(
      (branch) =>
        `${branch.branchLabel.trim()}:${(branch.conditionDescription || '').trim()}`
    )
    .join('|');
  return [
    step.stepNumber,
    leadMessage.trim().toLowerCase().replace(/\s+/g, ' '),
    branchSignature
  ].join('::');
}

function normalizeJudgeClassifierResult(
  result: JudgeBranchClassifierResult
): JudgeBranchClassifierOutcome {
  if (result && typeof result === 'object') {
    return {
      selectedLabel: result.selectedLabel ?? null,
      error: result.error ?? null,
      timedOut: result.timedOut === true
    };
  }
  return {
    selectedLabel:
      typeof result === 'string' && result.trim() ? result.trim() : null,
    error: null,
    timedOut: false
  };
}

function buildJudgeClassifierTrace(params: {
  step: JudgeStepLike | null | undefined;
  leadMessage: string | null | undefined;
  tokenMatch: JudgeBranchMatch;
  tokenScoreError?: string | null;
  llmAttempted?: boolean;
  llmSelectedLabel?: string | null;
  llmError?: string | null;
  finalSelectedLabel?: string | null;
  finalConfidence?: JudgeBranchConfidence;
}): JudgeClassifierTrace {
  const tokenResult = params.tokenMatch.tokenScoringResult;
  return {
    stepNumber: params.step?.stepNumber ?? null,
    stepTitle: params.step?.title ?? null,
    branchCount: params.step?.branches.length ?? 0,
    hasRuntimeJudgment: hasRuntimeJudgmentAction(params.step),
    leadMessageFirst100: params.leadMessage?.slice(0, 100) ?? null,
    tokenConfidence:
      tokenResult?.confidence ??
      (params.tokenMatch.confidence === 'llm_classified'
        ? 'none'
        : params.tokenMatch.confidence),
    tokenSelectedLabel:
      tokenResult?.selectedBranchLabel ?? params.tokenMatch.branchLabel ?? null,
    tokenBestScore: tokenResult?.bestScore ?? params.tokenMatch.score,
    tokenSecondScore: tokenResult?.secondScore ?? null,
    tokenTied: tokenResult?.tied ?? false,
    tokenScoreError: params.tokenScoreError ?? null,
    llmAttempted: params.llmAttempted === true,
    llmSelectedLabel: params.llmSelectedLabel ?? null,
    llmError: params.llmError ?? null,
    finalSelectedLabel:
      params.finalSelectedLabel ?? params.tokenMatch.branchLabel ?? null,
    finalConfidence: params.finalConfidence ?? params.tokenMatch.confidence,
    timestamp: new Date().toISOString()
  };
}

function withJudgeClassifierTrace(
  match: JudgeBranchMatch,
  trace: JudgeClassifierTrace
): JudgeBranchMatch {
  return { ...match, classifierTrace: trace };
}

function asJsonObject(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function persistJudgeClassifierTrace(params: {
  conversationId: string | null;
  match: JudgeBranchMatch;
  snapshotCurrentScriptStep?: number | null;
  inferredStepNumberForGate?: number | null;
  step?: JudgeStepLike | null;
}) {
  if (!params.conversationId || !params.match.classifierTrace) return;

  const trace = {
    ...params.match.classifierTrace,
    snapshotCurrentScriptStep: params.snapshotCurrentScriptStep ?? null,
    inferredStepNumberForGate: params.inferredStepNumberForGate ?? null,
    stepObjectStepNumber: params.step?.stepNumber ?? null,
    stepObjectTitle: params.step?.title ?? null,
    stepObjectBranchLabels:
      params.step?.branches.map((branch) => branch.branchLabel) ?? []
  };

  const row = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { capturedDataPoints: true }
  });
  const capturedDataPoints = {
    ...asJsonObject(row?.capturedDataPoints),
    lastClassifierTrace: trace
  };

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      capturedDataPoints: capturedDataPoints as Prisma.InputJsonValue
    }
  });
}

async function persistGenerateReplyTrace(params: {
  conversationId: string | null;
  patch: Record<string, unknown>;
}) {
  if (!params.conversationId) return;

  try {
    const row = await prisma.conversation.findUnique({
      where: { id: params.conversationId },
      select: { capturedDataPoints: true }
    });
    const capturedDataPoints = asJsonObject(row?.capturedDataPoints);
    const existingTrace = asJsonObject(
      capturedDataPoints.generateReplyTrace as Prisma.JsonValue
    );
    const generateReplyTrace = {
      ...existingTrace,
      ...params.patch,
      timestamp: new Date().toISOString()
    };

    await prisma.conversation.update({
      where: { id: params.conversationId },
      data: {
        capturedDataPoints: {
          ...capturedDataPoints,
          generateReplyTrace
        } as Prisma.InputJsonValue
      }
    });
  } catch (err) {
    console.error('[ai-engine] generateReplyTrace persist failed:', {
      conversationId: params.conversationId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

async function persistCapturedDataPointMerge(params: {
  conversationId: string | null;
  incoming: Record<string, string> | null;
}) {
  if (
    !params.conversationId ||
    !params.incoming ||
    Object.keys(params.incoming).length === 0
  ) {
    return;
  }

  const row = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { capturedDataPoints: true }
  });
  const merged = mergeCapturedDataPoints(
    asJsonObject(row?.capturedDataPoints),
    params.incoming
  );

  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { capturedDataPoints: merged as Prisma.InputJsonValue }
  });
}

async function resolveAnthropicApiKeyWithSource(accountId?: string | null) {
  if (accountId) {
    const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
    if (typeof anthropicCreds?.apiKey === 'string') {
      const byokKey = anthropicCreds.apiKey.trim();
      if (byokKey) return { apiKey: byokKey, keySource: 'byok' as const };
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY?.trim() || null;
  return envKey ? { apiKey: envKey, keySource: 'env' as const } : null;
}

async function classifyJudgeBranchWithHaiku(params: {
  step: JudgeStepLike;
  leadMessage: string;
  accountId?: string | null;
}): Promise<JudgeBranchClassifierOutcome> {
  const { step, leadMessage, accountId } = params;
  const keyResolution = await resolveAnthropicApiKeyWithSource(accountId);
  const apiKey = keyResolution?.apiKey ?? null;
  console.warn('[branch-classifier] LLM ATTEMPT:', {
    stepNumber: step.stepNumber,
    hasAnthropicKey: !!apiKey,
    keySource: keyResolution?.keySource ?? 'env'
  });
  if (!apiKey) {
    console.warn('[branch-classifier] LLM RESULT:', {
      stepNumber: step.stepNumber,
      success: false,
      selectedLabel: null,
      error: 'missing_anthropic_key',
      timedOut: false
    });
    return {
      selectedLabel: null,
      error: 'missing_anthropic_key',
      timedOut: false
    };
  }

  const branchLines = step.branches
    .map(
      (branch) => `- ${branch.branchLabel}: ${judgeBranchRoutingText(branch)}`
    )
    .join('\n');
  const prompt = `You are a branch router for a sales conversation.
Given a lead's message and a list of possible branches with their conditions, select the single best matching branch.

Lead message: ${leadMessage}

Branches:
${branchLines}

Use the operator's runtime judgment criteria in the branch text as the source of truth. When branches distinguish clear conviction from lukewarm interest, emphatic language, specific stakes, and strong personal importance should match the clear/committed branch; hedging language such as "maybe", "could", "possibly", or "I guess" should match the lukewarm/uncertain branch.

Respond with ONLY the exact branchLabel of the best match. No explanation. No punctuation. Just the label.`;

  const controller = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, 3000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn('[branch-classifier] LLM RESULT:', {
        stepNumber: step.stepNumber,
        success: false,
        selectedLabel: null,
        error: `http_${response.status}`,
        timedOut: didTimeout
      });
      return {
        selectedLabel: null,
        error: `http_${response.status}`,
        timedOut: didTimeout
      };
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = data.content
      ?.map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    console.warn('[branch-classifier] LLM RESULT:', {
      stepNumber: step.stepNumber,
      success: !!text,
      selectedLabel: text || null,
      error: null,
      timedOut: didTimeout
    });
    return { selectedLabel: text || null, error: null, timedOut: didTimeout };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('[branch-classifier] LLM RESULT:', {
      stepNumber: step.stepNumber,
      success: false,
      selectedLabel: null,
      error,
      timedOut: didTimeout
    });
    return { selectedLabel: null, error, timedOut: didTimeout };
  } finally {
    clearTimeout(timeout);
  }
}

export async function selectJudgeBranchForLead(
  step: JudgeStepLike | null | undefined,
  leadMessage: string | null | undefined,
  options?: {
    accountId?: string | null;
    cache?: JudgeBranchSelectionCache;
    classifier?: JudgeBranchClassifier;
  }
): Promise<JudgeBranchMatch> {
  const safeFallback: JudgeBranchMatch = {
    branchLabel: null,
    confidence: 'none',
    score: 0,
    tokenScoringResult: {
      selectedBranchLabel: null,
      confidence: 'none',
      bestScore: 0,
      secondScore: null,
      tied: false
    }
  };

  try {
    console.warn('[branch-classifier] ENTRY:', {
      stepNumber: step?.stepNumber ?? null,
      branchCount: step?.branches.length ?? 0,
      leadMessageFirst50: leadMessage?.slice(0, 50) ?? null
    });

    let tokenMatch: JudgeBranchMatch;
    let tokenScoreError: string | null = null;
    try {
      tokenMatch = scoreJudgeBranchesForLead(step, leadMessage);
      console.warn('[branch-classifier] TOKEN RESULT:', {
        stepNumber: step?.stepNumber ?? null,
        confidence: tokenMatch.confidence,
        selectedLabel: tokenMatch.branchLabel ?? null,
        willAttemptLLM:
          tokenMatch.confidence === 'none' ||
          tokenMatch.confidence === 'low' ||
          tokenMatch.confidence === 'medium'
      });
    } catch (err) {
      console.error('[branch-classifier] TOKEN SCORE ERROR:', {
        stepNumber: step?.stepNumber ?? null,
        error: err instanceof Error ? err.message : String(err)
      });
      tokenScoreError = err instanceof Error ? err.message : String(err);
      tokenMatch = safeFallback;
    }

    const baseTrace = buildJudgeClassifierTrace({
      step,
      leadMessage,
      tokenMatch,
      tokenScoreError
    });

    if (
      !step ||
      !hasRuntimeJudgmentAction(step) ||
      !leadMessage?.trim() ||
      tokenMatch.confidence === 'high'
    ) {
      return withJudgeClassifierTrace(tokenMatch, baseTrace);
    }

    const cacheKey = buildJudgeBranchSelectionCacheKey(step, leadMessage);
    const cached = options?.cache?.get(cacheKey);
    if (cached) return cached;

    const classifier = options?.classifier ?? classifyJudgeBranchWithHaiku;
    const selectionPromise = (async (): Promise<JudgeBranchMatch> => {
      let classifierOutcome: JudgeBranchClassifierOutcome;
      try {
        classifierOutcome = normalizeJudgeClassifierResult(
          await classifier({
            step,
            leadMessage,
            accountId: options?.accountId
          })
        );
      } catch (err) {
        classifierOutcome = {
          selectedLabel: null,
          error: err instanceof Error ? err.message : String(err),
          timedOut: false
        };
      }
      const selectedLabel = classifierOutcome.selectedLabel;
      const selectedBranch = selectedLabel
        ? step.branches.find((branch) => branch.branchLabel === selectedLabel)
        : null;

      if (!selectedBranch) {
        const llmError =
          classifierOutcome.error ||
          (selectedLabel ? 'invalid_branch_label' : null);
        return withJudgeClassifierTrace(
          tokenMatch,
          buildJudgeClassifierTrace({
            step,
            leadMessage,
            tokenMatch,
            tokenScoreError,
            llmAttempted: true,
            llmSelectedLabel: selectedLabel,
            llmError,
            finalSelectedLabel: tokenMatch.branchLabel,
            finalConfidence: tokenMatch.confidence
          })
        );
      }

      console.warn('[branch-classifier] LLM fallback:', {
        step: step.stepNumber,
        leadMessageFirst100: leadMessage.slice(0, 100),
        tokenScore: tokenMatch.tokenScoringResult ?? {
          selectedBranchLabel: tokenMatch.branchLabel,
          confidence: tokenMatch.confidence,
          bestScore: tokenMatch.score,
          secondScore: null,
          tied: false
        },
        llmSelected: selectedLabel,
        confidence: 'llm_classified'
      });

      const llmMatch: JudgeBranchMatch = {
        branchLabel: selectedBranch.branchLabel,
        confidence: 'llm_classified',
        score: tokenMatch.score,
        tokenScoringResult: tokenMatch.tokenScoringResult
      };
      return withJudgeClassifierTrace(
        llmMatch,
        buildJudgeClassifierTrace({
          step,
          leadMessage,
          tokenMatch,
          tokenScoreError,
          llmAttempted: true,
          llmSelectedLabel: selectedLabel,
          llmError: classifierOutcome.error,
          finalSelectedLabel: selectedBranch.branchLabel,
          finalConfidence: 'llm_classified'
        })
      );
    })().catch((err) =>
      withJudgeClassifierTrace(
        tokenMatch,
        buildJudgeClassifierTrace({
          step,
          leadMessage,
          tokenMatch,
          tokenScoreError,
          llmAttempted: true,
          llmError: err instanceof Error ? err.message : String(err),
          finalSelectedLabel: tokenMatch.branchLabel,
          finalConfidence: tokenMatch.confidence
        })
      )
    );

    options?.cache?.set(cacheKey, selectionPromise);
    return selectionPromise;
  } catch (err) {
    console.error('[branch-classifier] UNCAUGHT ERROR:', {
      stepNumber: step?.stepNumber ?? null,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack?.slice(0, 500) : undefined
    });
    return withJudgeClassifierTrace(
      safeFallback,
      buildJudgeClassifierTrace({
        step,
        leadMessage,
        tokenMatch: safeFallback,
        tokenScoreError: err instanceof Error ? err.message : String(err)
      })
    );
  }
}

function scriptedBranchActions(branch: JudgeBranchLike): JudgeActionLike[] {
  return branch.actions.filter(
    (action) =>
      (action.actionType === 'send_message' ||
        action.actionType === 'ask_question' ||
        action.actionType === 'send_link' ||
        action.actionType === 'send_video') &&
      typeof action.content === 'string' &&
      action.content.trim().length > 0 &&
      !isRuntimePlaceholderOnly(action.content)
  );
}

function branchHasAskAction(branch: JudgeBranchLike | null | undefined) {
  return !!branch?.actions.some(
    (action) => action.actionType === 'ask_question'
  );
}

function branchHasWaitAction(branch: JudgeBranchLike | null | undefined) {
  return !!branch?.actions.some(
    (action) => action.actionType === 'wait_for_response'
  );
}

function branchHasRuntimeJudgmentOnly(
  branch: JudgeBranchLike | null | undefined
) {
  if (!branch) return false;
  return (
    branch.actions.length > 0 &&
    branch.actions.every((action) => action.actionType === 'runtime_judgment')
  );
}

function branchIsSilent(branch: JudgeBranchLike | null | undefined) {
  if (!branch) return false;
  return (
    branchHasWaitAction(branch) &&
    !branchHasAskAction(branch) &&
    branch.actions.some((action) => action.actionType === 'send_message')
  );
}

function getRequiredMessagesFromActions(
  actions: JudgeActionLike[],
  variableResolutionMap?: ScriptVariableResolutionMap | null
): RequiredMessage[] {
  return actions
    .filter(
      (action) =>
        action.actionType === 'send_message' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    )
    .map((action) => {
      const content =
        applyResolvedScriptVariables(
          action.content?.trim() ?? '',
          variableResolutionMap
        )?.trim() ?? '';
      const isPlaceholder = isRuntimePlaceholderOnly(content);
      return {
        content,
        isPlaceholder,
        embeddedQuotes: isPlaceholder ? extractEmbeddedQuotes(content) : []
      };
    });
}

function getActiveBranchRequiredMessages(
  activeBranch: JudgeBranchLike | null | undefined,
  directActions: JudgeActionLike[] = [],
  variableResolutionMap?: ScriptVariableResolutionMap | null
): RequiredMessage[] {
  const actions = [...directActions, ...(activeBranch?.actions ?? [])];
  return getRequiredMessagesFromActions(actions, variableResolutionMap);
}

function getScriptedQuestionsFromActions(
  actions: JudgeActionLike[],
  variableResolutionMap?: ScriptVariableResolutionMap | null
): string[] {
  return actions
    .filter(
      (action) =>
        action.actionType === 'ask_question' &&
        typeof action.content === 'string' &&
        action.content.trim().length > 0
    )
    .map((action) =>
      (
        applyResolvedScriptVariables(action.content, variableResolutionMap) ??
        action.content ??
        ''
      ).trim()
    )
    .filter((content) => content.length > 0);
}

function getActiveBranchScriptedQuestions(
  activeBranch: JudgeBranchLike | null | undefined,
  directActions: JudgeActionLike[] = [],
  variableResolutionMap?: ScriptVariableResolutionMap | null
): string[] {
  const actions = [...directActions, ...(activeBranch?.actions ?? [])];
  return getScriptedQuestionsFromActions(actions, variableResolutionMap);
}

function resolveMessageContentsForGate(
  contents: string[],
  variableResolutionMap?: ScriptVariableResolutionMap | null
): string[] {
  return contents
    .map((content) =>
      (
        applyResolvedScriptVariables(content, variableResolutionMap) ?? content
      ).trim()
    )
    .filter((content) => content.length > 0);
}

function collectCurrentStepVariableTexts(
  step: JudgeStepLike | null | undefined
): string[] {
  if (!step) return [];
  const actions = [
    ...step.actions,
    ...step.branches.flatMap((branch) => branch.actions)
  ];
  return Array.from(
    new Set(
      actions
        .filter(
          (action) =>
            (action.actionType === 'send_message' ||
              action.actionType === 'ask_question') &&
            typeof action.content === 'string' &&
            action.content.trim().length > 0
        )
        .map((action) => action.content!.trim())
    )
  );
}

type UrlActionLike = {
  actionType?: string | null;
  content?: string | null;
  linkUrl?: string | null;
};

function addAllowedUrlsFromAction(
  action: UrlActionLike | null | undefined,
  urls: Set<string>
): void {
  if (!action) return;
  if (typeof action.linkUrl === 'string' && action.linkUrl.trim()) {
    urls.add(action.linkUrl.trim());
  }
  for (const url of extractUrlsFromText(action.content)) {
    urls.add(url);
  }
}

function addPersonaFallbackUrls(
  persona: ScriptStateSnapshot['persona'] | null | undefined,
  urls: Set<string>,
  hasActiveRelationalScript: boolean
): void {
  if (!persona) return;
  const promptConfig = persona.promptConfig;
  urls.add(persona.freeValueLink ?? '');
  urls.add(getJsonStringField(persona.downsellConfig, 'link') ?? '');
  urls.add(getJsonStringField(promptConfig, 'downsellLink') ?? '');
  urls.add(getJsonStringField(promptConfig, 'youtubeFallbackUrl') ?? '');
  urls.add(getJsonStringField(promptConfig, 'freeValueLink') ?? '');

  if (!hasActiveRelationalScript) {
    urls.add(getJsonStringField(promptConfig, 'bookingTypeformUrl') ?? '');
    urls.add(getJsonStringField(promptConfig, 'typeformUrl') ?? '');
    const assetLinks =
      promptConfig &&
      typeof promptConfig === 'object' &&
      !Array.isArray(promptConfig)
        ? (promptConfig as Record<string, unknown>).assetLinks
        : null;
    if (
      assetLinks &&
      typeof assetLinks === 'object' &&
      !Array.isArray(assetLinks)
    ) {
      const bookingLink = (assetLinks as Record<string, unknown>).bookingLink;
      if (typeof bookingLink === 'string') urls.add(bookingLink);
    }
  }
}

function addCapturedTemplateUrls(
  capturedDataPoints:
    | ScriptStateSnapshot['capturedDataPoints']
    | null
    | undefined,
  urls: Set<string>
): void {
  if (!capturedDataPoints) return;
  for (const point of Object.values(capturedDataPoints)) {
    if (!point) continue;
    const rawValue =
      typeof point === 'object' && 'value' in point
        ? (point as { value?: unknown }).value
        : point;
    if (typeof rawValue === 'string') {
      for (const url of extractUrlsFromText(rawValue)) urls.add(url);
    }
  }
}

function collectCurrentTurnAllowedUrls(params: {
  snapshot: ScriptStateSnapshot | null;
  currentStepNumber: number | null | undefined;
}): string[] {
  const urls = new Set<string>();
  const script = params.snapshot?.script ?? null;
  const currentStep =
    script && typeof params.currentStepNumber === 'number'
      ? script.steps.find(
          (step) => step.stepNumber === params.currentStepNumber
        )
      : null;

  if (currentStep) {
    for (const action of currentStep.actions ?? []) {
      addAllowedUrlsFromAction(action as UrlActionLike, urls);
    }
    for (const branch of currentStep.branches ?? []) {
      for (const action of branch.actions ?? []) {
        addAllowedUrlsFromAction(action as UrlActionLike, urls);
      }
    }
  }

  addPersonaFallbackUrls(params.snapshot?.persona, urls, !!script);
  addCapturedTemplateUrls(params.snapshot?.capturedDataPoints, urls);

  return Array.from(urls).filter((url) => normalizeUrlForAllowlist(url));
}

type FutureStepMismatchSeverity = 'none' | 'minor' | 'critical';

function normalizeForFutureStepMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlapRatio(expected: string, generated: string): number {
  const expectedTokens = Array.from(
    new Set(normalizeForFutureStepMatch(expected).split(' ').filter(Boolean))
  );
  if (expectedTokens.length === 0) return 0;
  const generatedTokens = new Set(
    normalizeForFutureStepMatch(generated).split(' ').filter(Boolean)
  );
  const matched = expectedTokens.filter((token) => generatedTokens.has(token));
  return matched.length / expectedTokens.length;
}

function detectFutureStepContentMismatch(params: {
  snapshot: ScriptStateSnapshot | null;
  currentStepNumber: number | null | undefined;
  messages: string[];
  currentAllowedUrls: string[];
}): {
  detectedFutureStepContent: boolean;
  mismatchSeverity: FutureStepMismatchSeverity;
  matchedStepNumber: number | null;
  matchedReason: string | null;
} {
  const script = params.snapshot?.script ?? null;
  if (!script || typeof params.currentStepNumber !== 'number') {
    return {
      detectedFutureStepContent: false,
      mismatchSeverity: 'none',
      matchedStepNumber: null,
      matchedReason: null
    };
  }

  const currentStepNumber = params.currentStepNumber;
  const generated = params.messages.join('\n');
  const futureSteps = script.steps
    .filter((step) => step.stepNumber > currentStepNumber)
    .sort((a, b) => a.stepNumber - b.stepNumber);
  const currentAllowedUrls = params.currentAllowedUrls;

  for (const step of futureSteps) {
    const stepActions: UrlActionLike[] = [
      ...(step.actions as UrlActionLike[]),
      ...step.branches.flatMap((branch) => branch.actions as UrlActionLike[])
    ];
    for (const action of stepActions) {
      const actionUrls = [
        ...(typeof action.linkUrl === 'string' ? [action.linkUrl] : []),
        ...extractUrlsFromText(action.content)
      ];
      for (const url of actionUrls) {
        if (generated.includes(url) && !isUrlAllowed(url, currentAllowedUrls)) {
          return {
            detectedFutureStepContent: true,
            mismatchSeverity:
              step.stepNumber - currentStepNumber >= 2 ? 'critical' : 'minor',
            matchedStepNumber: step.stepNumber,
            matchedReason: 'future_step_url'
          };
        }
      }

      const content = action.content?.trim();
      if (
        !content ||
        content.length < 24 ||
        isRuntimePlaceholderOnly(content)
      ) {
        continue;
      }
      const overlap = tokenOverlapRatio(content, generated);
      if (overlap >= 0.82) {
        return {
          detectedFutureStepContent: true,
          mismatchSeverity:
            step.stepNumber - currentStepNumber >= 2 ? 'critical' : 'minor',
          matchedStepNumber: step.stepNumber,
          matchedReason: 'future_step_literal_overlap'
        };
      }
    }
  }

  return {
    detectedFutureStepContent: false,
    mismatchSeverity: 'none',
    matchedStepNumber: null,
    matchedReason: null
  };
}

function actionSimilarityScore(actionContent: string, generated: string) {
  const actionTokens = new Set(tokenizeForJudgeMatch(actionContent));
  if (actionTokens.size === 0) return 0;
  const generatedTokens = new Set(tokenizeForJudgeMatch(generated));
  let matches = 0;
  for (const token of Array.from(actionTokens)) {
    if (generatedTokens.has(token)) matches++;
  }
  return matches / actionTokens.size;
}

function missingRequiredBranchActions(
  actions: JudgeActionLike[],
  generated: string,
  threshold = 0.45
): string[] {
  return actions
    .filter((action) => {
      const content = action.content?.trim();
      if (!content) return false;
      const normalizedGenerated = generated.toLowerCase();
      const normalizedContent = content.toLowerCase();
      if (
        normalizedContent.length >= 18 &&
        normalizedGenerated.includes(normalizedContent.slice(0, 40).trim())
      ) {
        return false;
      }
      return actionSimilarityScore(content, generated) < threshold;
    })
    .map((action) => action.content?.trim())
    .filter((content): content is string => !!content);
}

export async function buildJudgeClassificationDirective(params: {
  step: JudgeStepLike | null | undefined;
  latestLeadMessage?: string | null;
  accountId?: string | null;
  cache?: JudgeBranchSelectionCache;
  variableResolutionMap?: ScriptVariableResolutionMap | null;
}): Promise<string> {
  const { step, latestLeadMessage, accountId, cache, variableResolutionMap } =
    params;
  if (!step || !hasRuntimeJudgmentAction(step)) return '';

  const match = await selectJudgeBranchForLead(step, latestLeadMessage, {
    accountId,
    cache
  });
  const matchedBranch = match.branchLabel
    ? step.branches.find((branch) => branch.branchLabel === match.branchLabel)
    : null;
  const directiveBranches = matchedBranch ? [matchedBranch] : step.branches;
  const branchLines = directiveBranches.map((branch) => {
    const condition = branch.conditionDescription?.trim()
      ? ` — ${branch.conditionDescription.trim()}`
      : '';
    return `- ${branch.branchLabel}${condition}`;
  });
  const matchedActions =
    matchedBranch && scriptedBranchActions(matchedBranch).length > 0
      ? scriptedBranchActions(matchedBranch)
          .map((action) => {
            const tag =
              action.actionType === 'ask_question'
                ? 'ASK'
                : action.actionType === 'send_message'
                  ? 'MSG'
                  : 'ACTION';
            const content =
              applyResolvedScriptVariables(
                action.content?.trim() ?? '',
                variableResolutionMap
              )?.trim() ?? '';
            return `  [${tag}] ${content}`;
          })
          .join('\n')
      : null;

  return `\n\n===== SCRIPT [JUDGE] CLASSIFICATION GATE =====\nThe CURRENT script step contains a [JUDGE] action. This is a mandatory branch-classification gate, not optional guidance.\n\nCurrent step: Step ${step.stepNumber}: ${step.title}\nLatest lead message: "${(latestLeadMessage || '').slice(0, 500)}"\n\n${matchedBranch ? 'Locked branch:' : 'Branch candidates:'}\n${branchLines.join('\n') || '- (no branches configured)'}\n\nEngine classification: ${
    match.branchLabel
      ? `the latest lead message matches "${match.branchLabel}" (${match.confidence} confidence). Run that branch's actions now.`
      : 'no branch matched with enough confidence. Ask ONE concise clarification from the current step instead of defaulting to any branch.'
  }${
    matchedActions
      ? `\n\nMatched branch actions to use:\n${matchedActions}`
      : ''
  }\n\nRules:\n- Choose a branch before proceeding.\n- Do not default to the first, loudest, or most common branch.\n- Do not jump to the NEXT STEP preview until the selected branch's [MSG]/[ASK]/[WAIT] actions have been completed.\n- If the lead has already supplied enough information for a branch, do not ask the skipped branch's question.\n=====`;
}

export async function detectJudgeBranchViolation(params: {
  step: JudgeStepLike | null | undefined;
  latestLeadMessage?: string | null;
  generatedMessages: string[];
  accountId?: string | null;
  cache?: JudgeBranchSelectionCache;
  classifier?: JudgeBranchClassifier;
  variableResolutionMap?: ScriptVariableResolutionMap | null;
}): Promise<JudgeBranchViolation> {
  const {
    step,
    latestLeadMessage,
    generatedMessages,
    accountId,
    cache,
    classifier,
    variableResolutionMap
  } = params;
  if (!step || !hasRuntimeJudgmentAction(step)) {
    return {
      blocked: false,
      reason: null,
      matchedBranchLabel: null,
      fallbackMessages: []
    };
  }

  const match = await selectJudgeBranchForLead(step, latestLeadMessage, {
    accountId,
    cache,
    classifier
  });
  if (!match.branchLabel) {
    return {
      blocked: false,
      reason: null,
      matchedBranchLabel: null,
      fallbackMessages: []
    };
  }

  const expectedBranch = step.branches.find(
    (branch) => branch.branchLabel === match.branchLabel
  );
  if (!expectedBranch) {
    return {
      blocked: false,
      reason: null,
      matchedBranchLabel: null,
      fallbackMessages: []
    };
  }

  const expectedActions = scriptedBranchActions(expectedBranch).map(
    (action) => ({
      ...action,
      content:
        applyResolvedScriptVariables(
          action.content ?? '',
          variableResolutionMap
        )?.trim() ?? action.content
    })
  );
  if (expectedActions.length === 0) {
    return {
      blocked: false,
      reason: null,
      matchedBranchLabel: match.branchLabel,
      fallbackMessages: []
    };
  }

  const generated = generatedMessages.join('\n');
  const missingActions = missingRequiredBranchActions(
    expectedActions,
    generated
  );
  if (missingActions.length === 0) {
    return {
      blocked: false,
      reason: null,
      matchedBranchLabel: match.branchLabel,
      fallbackMessages: []
    };
  }

  return {
    blocked: true,
    reason: `Current [JUDGE] step matched branch "${match.branchLabel}", but the generated reply skipped required scripted action(s): ${missingActions.map((action) => `"${action}"`).join(', ')}.`,
    matchedBranchLabel: match.branchLabel,
    fallbackMessages: expectedActions
      .map((action) => action.content?.trim())
      .filter((content): content is string => !!content)
      .slice(0, 3)
  };
}

type LLMContentPart = LLMTextContentPart | LLMImageContentPart;
type LLMMessageContent = string | LLMContentPart[];
type LLMMessage = {
  role: 'user' | 'assistant';
  content: LLMMessageContent;
};

/**
 * R24 capital-verification outcome for the current turn — exposed so
 * the webhook-processor can drive the `Lead.stage` update from the
 * gate result instead of blindly mapping conversation-stage names.
 *
 *  - `passed`: lead's stated amount meets or exceeds the threshold
 *    (or confirmed affirmative on a threshold-confirming Q).
 *  - `failed`: lead disqualified on capital (stated below threshold
 *    or hit a disqualifier phrase like "broke" / "jobless").
 *  - `hedging`: lead hedged without a concrete number — wait for it.
 *  - `ambiguous`: lead's reply didn't parse — wait for clarification.
 *  - `not_asked`: verification Q wasn't found in history (or asked
 *    but not yet answered) — not enough signal to classify.
 *  - `not_evaluated`: R24 wasn't evaluated this turn (no threshold
 *    configured, or this turn wasn't routing to booking handoff).
 */
export type CapitalOutcome =
  | 'passed'
  | 'failed'
  | 'hedging'
  | 'ambiguous'
  | 'not_asked'
  | 'not_evaluated';

type VoiceGateCapitalOutcome = 'failed' | undefined;

export type ConversationCurrency =
  | 'USD'
  | 'GBP'
  | 'ZAR'
  | 'NGN'
  | 'GHS'
  | 'KES'
  | 'PHP'
  | 'UGX'
  | 'EUR'
  | 'CAD'
  | 'AUD'
  | 'NZD';

// Approximate USD conversion rates for capital-gate sanity checks.
// Update quarterly, or replace with an FX API in Sprint 7. Exactness
// matters less than catching obvious misses like R2000 ≈ $108.
const CAPITAL_CURRENCY_TO_USD: Record<ConversationCurrency, number> = {
  USD: 1,
  GBP: 1.25,
  ZAR: 1 / 18.5,
  NGN: 1 / 1600,
  GHS: 1 / 15,
  KES: 1 / 130,
  PHP: 1 / 58,
  UGX: 1 / 3700,
  EUR: 1.08,
  CAD: 0.74,
  AUD: 0.65,
  NZD: 0.61
};

export function convertCapitalAmountToUsd(
  amount: number,
  currency: ConversationCurrency | null | undefined
): number {
  const rate = CAPITAL_CURRENCY_TO_USD[currency ?? 'USD'] ?? 1;
  return amount * rate;
}

function buildApplicationContextBlock(params: {
  submittedAt: Date;
  capitalConfirmed: number | null;
  callScheduledAt: Date | null;
  typeformAnswers: Prisma.JsonValue | null;
  closerName?: string | null;
}): string {
  const lines = [
    '<application_context>',
    'This lead submitted their application form.',
    `Submitted: ${params.submittedAt.toISOString()}`
  ];

  if (typeof params.capitalConfirmed === 'number') {
    lines.push(
      '',
      `Capital confirmed in application: $${params.capitalConfirmed.toLocaleString('en-US')}`
    );
  }
  if (params.callScheduledAt) {
    const closerLabel = (params.closerName || 'the closer').trim();
    lines.push(
      '',
      `Call scheduled for: ${params.callScheduledAt.toISOString()}`,
      `The lead has booked their call with ${closerLabel}.`
    );
  }

  const answerLines = formatTypeformAnswersForPrompt(params.typeformAnswers);
  if (answerLines.length > 0) {
    lines.push('', 'Additional context from their application:');
    lines.push(...answerLines);
  }

  lines.push(
    '',
    'Do NOT ask questions already answered in their application.',
    'Do NOT ask about capital if it was confirmed in the form.',
    'Reference the call time naturally if relevant.',
    '</application_context>'
  );
  return `\n\n${lines.join('\n')}`;
}

function formatTypeformAnswersForPrompt(
  typeformAnswers: Prisma.JsonValue | null
): string[] {
  if (!typeformAnswers || typeof typeformAnswers !== 'object') return [];
  const root = typeformAnswers as {
    parsed?: Record<string, unknown>;
    answers?: Array<{
      fieldTitle?: string | null;
      fieldId?: string;
      value?: unknown;
    }>;
  };
  const parsed =
    root.parsed && typeof root.parsed === 'object' ? root.parsed : {};
  const preferredKeys = [
    'fullName',
    'email',
    'instagramUsername',
    'tradingExperience'
  ];
  const lines: string[] = [];
  for (const key of preferredKeys) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) {
      lines.push(`- ${humanizeApplicationKey(key)}: ${value.trim()}`);
    }
  }
  if (Array.isArray(root.answers)) {
    for (const answer of root.answers.slice(0, 8)) {
      if (lines.length >= 8) break;
      const label = answer.fieldTitle || answer.fieldId || 'Field';
      const value = answer.value;
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        const rendered = String(value).trim();
        if (
          rendered &&
          !lines.some((line) =>
            line.toLowerCase().includes(rendered.toLowerCase())
          )
        ) {
          lines.push(`- ${label}: ${rendered}`);
        }
      }
    }
  }
  return lines;
}

function humanizeApplicationKey(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

function buildR34MetadataLeakDirective(matchedText?: string | null): string {
  const matched = matchedText ? `\nMatched leak: "${matchedText}"\n` : '\n';
  return `\n\n===== R34 METADATA LEAK OVERRIDE =====${matched}Your previous response put internal system metadata inside the lead-facing message body. That can NEVER be visible to the lead.\n\nForbidden in message/message bubbles: stage_confidence:1.0, quality_score:71, confidence:0.8, intent:HOT_LEAD, stage:BOOKING, next_action, script_step, [BOOKING LINK], {{name}}, JSON fragments, debug notes, or any system key:value fields.\n\nRegenerate with ONLY the human-facing conversational text in "message" / "messages". Put stage, confidence, intent, and all structured fields ONLY in the separate JSON fields.\n=====`;
}

function stripMetadataLeaksFromMessages(messages: string[]): {
  success: boolean;
  messages: string[];
  matchedText: string | null;
  matchedPattern: string | null;
} {
  const strippedMessages: string[] = [];
  let anyStripped = false;
  let firstMatchedText: string | null = null;
  let firstMatchedPattern: string | null = null;

  for (const message of messages) {
    let current = message;
    for (let i = 0; i < 5; i++) {
      const leak = detectMetadataLeak(current);
      if (!leak.leak || !leak.matchedText) break;
      anyStripped = true;
      firstMatchedText ??= leak.matchedText;
      firstMatchedPattern ??= leak.matchedPattern;
      const stripped = surgicalStripMetadataLeak(current, leak.matchedText);
      if (!stripped.success) {
        return {
          success: false,
          messages: [],
          matchedText: firstMatchedText,
          matchedPattern: firstMatchedPattern
        };
      }
      current = stripped.content;
    }
    if (detectMetadataLeak(current).leak) {
      return {
        success: false,
        messages: [],
        matchedText: firstMatchedText,
        matchedPattern: firstMatchedPattern
      };
    }
    strippedMessages.push(current);
  }

  return {
    success: anyStripped && strippedMessages.some((m) => m.trim().length > 0),
    messages: strippedMessages.filter((m) => m.trim().length > 0),
    matchedText: firstMatchedText,
    matchedPattern: firstMatchedPattern
  };
}

async function recordR34MetadataLeakCatch(params: {
  accountId: string;
  conversationId: string | null;
  attempt: number;
  matchedText: string | null;
  matchedPattern: string | null;
  replyPreview: string;
  stage: string | null;
  leadMessage: string | null;
}) {
  const failureReason = `r34_metadata_leak: matched "${params.matchedText ?? 'unknown'}" via ${params.matchedPattern ?? 'unknown_pattern'}`;
  await prisma.voiceQualityFailure
    .create({
      data: {
        accountId: params.accountId,
        message: params.replyPreview,
        score: 0,
        hardFails: [failureReason],
        attempt: params.attempt,
        leadMessage: params.leadMessage?.slice(0, 500) || null
      }
    })
    .catch((err) =>
      console.error('[ai-engine] R34 VoiceQualityFailure log failed:', err)
    );

  if (params.conversationId) {
    await prisma.bookingRoutingAudit
      .create({
        data: {
          conversationId: params.conversationId,
          accountId: params.accountId,
          routingAllowed: false,
          regenerationForced: true,
          blockReason: 'r34_metadata_leak',
          aiStageReported: params.stage,
          aiSubStageReported: 'R34_METADATA_LEAK',
          contentPreview: params.replyPreview.slice(0, 200)
        }
      })
      .catch((err) =>
        console.error('[ai-engine] R34 BookingRoutingAudit log failed:', err)
      );
  }

  await maybeAlertR34Spike(params.accountId).catch((err) =>
    console.error('[ai-engine] R34 spike alert failed:', err)
  );
}

async function maybeAlertR34Spike(accountId: string) {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const rows = await prisma.voiceQualityFailure.findMany({
    where: { accountId, createdAt: { gte: hourAgo } },
    select: { hardFails: true }
  });
  const r34Count = rows.filter((row) =>
    JSON.stringify(row.hardFails).includes('r34_metadata_leak')
  ).length;
  if (r34Count <= 5) return;

  const existing = await prisma.notification.findFirst({
    where: {
      accountId,
      type: 'SYSTEM',
      title: { contains: 'R34 metadata leak guard' },
      createdAt: { gte: hourAgo }
    },
    select: { id: true }
  });
  if (existing) return;

  const title = `R34 metadata leak guard fired ${r34Count}x in 1h`;
  const body = `R34 caught ${r34Count} metadata leak attempt${r34Count === 1 ? '' : 's'} in the last hour. Check the master prompt and recent AI generations for structured fields leaking into message content.`;
  await prisma.notification
    .create({
      data: { accountId, type: 'SYSTEM', title, body }
    })
    .catch((err) =>
      console.error('[ai-engine] R34 spike notification failed:', err)
    );

  const webhook =
    process.env.SLACK_WEBHOOK_URL || process.env.OPERATOR_SLACK_WEBHOOK_URL;
  if (!webhook) return;
  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `R34 metadata leak guard fired ${r34Count}x in the last hour on account ${accountId}. Check master prompt and voice gate patterns.`
    })
  }).catch((err) =>
    console.error('[ai-engine] R34 Slack webhook failed:', err)
  );
}

export interface GenerateReplyResult {
  reply: string;
  /**
   * Multi-bubble output. Always a populated array — single-message
   * responses appear as `[reply]` (backward compat). When the persona
   * has multiBubbleEnabled=true AND the LLM emits messages[], this
   * contains 2-4 ordered bubbles that sendAIReply delivers as
   * separate platform sends.
   */
  messages: string[];
  format: 'text' | 'voice_note';
  stage: string;
  subStage: string | null;
  stageConfidence: number;
  sentimentScore: number;
  experiencePath: string | null;
  objectionDetected: string | null;
  stallType: string | null;
  affirmationDetected: boolean;
  followUpNumber: number | null;
  softExit: boolean;
  /** R20: AI has detected it's stuck in a loop or can't resolve — hand off to a human. */
  escalateToHuman: boolean;
  // Booking-stage extracted fields (Stage 7)
  leadTimezone: string | null;
  selectedSlotIso: string | null;
  leadEmail: string | null;
  suggestedTag: string;
  suggestedTags: string[];
  shouldVoiceNote: boolean;
  voiceNoteAction: { slot_id: string } | null;
  qualityScore: number;
  qualityGateTerminalFailure?: boolean;
  qualityGateFailureReason?: string | null;
  qualityGateHardFails?: string[];
  qualityGateAttempts?: number;
  suggestedDelay: number;
  systemPromptVersion: string;
  // Closed-loop training
  suggestionId: string | null;
  /**
   * R24 gate outcome for the CURRENT turn. Used by the delivery layer
   * to set `Lead.stage` correctly — a `failed` outcome routes the lead
   * to UNQUALIFIED, `passed` unlocks QUALIFIED, everything else keeps
   * the lead's prior stage (reaching FINANCIAL_SCREENING without
   * passing should NOT promote to QUALIFIED).
   */
  capitalOutcome: CapitalOutcome;
  /**
   * Layer 2 safety net: the last LEAD message matched the distress
   * detector. When true, sendAIReply MUST abort the normal ship path
   * and route through the distress / supportive response flow
   * instead (flip aiActive=false, flag the conversation, notify the
   * operator, ship a dedicated non-sales message via Haiku). Layer 1
   * (webhook-processor pre-generation gate) normally catches this —
   * Layer 2 is the backstop for race conditions, retried webhooks, or
   * any future entry point that bypasses Layer 1.
   */
  distressDetected?: boolean;
  distressMatch?: string | null;
  distressLabel?: string | null;
  /** Typeform was filled but no booking slot was selected. Expected screen-out path. */
  typeformFilledNoBooking?: boolean;
  /**
   * Multi-tenant safety: the calling persona has zero training messages.
   * Without training, the master prompt's hardcoded brand fixtures (legacy
   * daetradez voice references) bleed into the reply. sendAIReply MUST
   * abort delivery, flip aiActive=false on the conversation, and notify
   * the operator that this persona needs training data before AI replies
   * can resume. (Fix for cross-tenant leak — nickdoesfutures 2026-05-07.)
   */
  noTrainingSuppressed?: boolean;
  /** Script-state recovery metadata, when deterministic recovery/override ran. */
  selfRecovered?: boolean;
  selfRecoveryEventId?: string | null;
  selfRecoveryReason?: string | null;
  systemStage?: string | null;
  currentScriptStep?: number | null;
  stageOverrideReason?: string | null;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Generate an AI reply for a conversation.
 *
 * @param accountId - The account ID (for credential lookup + account-scoped fields).
 * @param personaId - The AIPersona that owns this conversation. **Required**
 *   (audit F3.1). Every caller must source this from `Conversation.personaId`
 *   on the live conversation, the operator's UI selection, or a test fixture
 *   that explicitly creates a persona. The engine no longer guesses the
 *   active persona via `findFirst({accountId, isActive})` — guessing was
 *   non-deterministic for multi-persona accounts and the root of multiple
 *   cross-persona context-bleed findings (audit F3.2 closes the read sites
 *   in the next phase).
 * @param conversationHistory - Full ordered message history.
 * @param leadContext - Lead metadata for prompt personalization.
 */
export async function generateReply(
  accountId: string,
  personaId: string,
  conversationHistory: ConversationMessage[],
  leadContext: LeadContext,
  scoringContext?: string
): Promise<GenerateReplyResult> {
  // 0. Extract the last lead message for few-shot retrieval
  const lastLeadMsg = [...conversationHistory]
    .reverse()
    .find((m) => isLeadCapitalParseCandidate(m));
  const lastAiMsg = [...conversationHistory]
    .reverse()
    .find((m) => m.sender === 'AI');
  const rescheduleFlow = leadContext.rescheduleFlow === true;

  // 0a. LAYER 2 SAFETY NET — distress detection on the last LEAD
  // message. Layer 1 (webhook-processor.ts pre-generation gate) is the
  // primary defense; this fires when Layer 1 was somehow bypassed
  // (retried webhook, race condition with a cron-fired ScheduledReply
  // that predates the lead's new message, or any future code path
  // that enters generateReply without going through processIncomingMessage).
  // On detection we short-circuit — no LLM call, no retry loop. Return
  // a sentinel result with `distressDetected: true` so sendAIReply
  // aborts normal delivery and routes through the supportive response
  // flow (identical to Layer 1's path). This wastes zero tokens and
  // guarantees a distress message can never receive a sales reply.
  if (lastLeadMsg) {
    try {
      const { detectDistress } = await import('@/lib/distress-detector');
      const distress = detectDistress(lastLeadMsg.content);
      if (distress.detected) {
        console.warn(
          `[ai-engine] LAYER 2 distress detected — aborting generation. label=${distress.label} match="${distress.match}"`
        );
        return {
          reply: '',
          messages: [],
          format: 'text',
          stage: '',
          subStage: null,
          stageConfidence: 0,
          sentimentScore: 0,
          experiencePath: null,
          objectionDetected: null,
          stallType: null,
          affirmationDetected: false,
          followUpNumber: null,
          softExit: false,
          escalateToHuman: true,
          leadTimezone: null,
          selectedSlotIso: null,
          leadEmail: null,
          suggestedTag: '',
          suggestedTags: [],
          shouldVoiceNote: false,
          voiceNoteAction: null,
          qualityScore: 0,
          suggestedDelay: 0,
          systemPromptVersion: 'distress-layer2',
          suggestionId: null,
          capitalOutcome: 'not_evaluated',
          distressDetected: true,
          distressMatch: distress.match,
          distressLabel: distress.label
        };
      }
    } catch (err) {
      // Detection errors must NEVER block normal generation. The Layer 1
      // gate in webhook-processor.ts already caught anything critical
      // at the entry point. Log loudly and continue.
      console.error(
        '[ai-engine] Layer 2 distress detector threw (non-fatal, continuing):',
        err
      );
    }
  }

  // 0a-ii. TYPEFORM SCREEN-OUT SAFETY NET. The webhook processor
  // catches this before generation in normal live flow. This backstop
  // covers retries, tests, and any future entry point that calls
  // generateReply directly.
  if (
    detectTypeformFilledNoBookingContext(
      lastAiMsg?.content,
      lastLeadMsg?.content
    )
  ) {
    return {
      reply: TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE,
      messages: [TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE],
      format: 'text',
      stage: 'UNQUALIFIED',
      subStage: 'TYPEFORM_NO_BOOKING',
      stageConfidence: 1,
      sentimentScore: 0,
      experiencePath: null,
      objectionDetected: null,
      stallType: null,
      affirmationDetected: false,
      followUpNumber: null,
      softExit: true,
      escalateToHuman: false,
      leadTimezone: null,
      selectedSlotIso: null,
      leadEmail: null,
      suggestedTag: 'typeform-screened-out',
      suggestedTags: ['typeform-screened-out'],
      shouldVoiceNote: false,
      voiceNoteAction: null,
      qualityScore: 100,
      suggestedDelay: 0,
      systemPromptVersion: 'typeform-no-booking-screenout',
      suggestionId: null,
      capitalOutcome: 'not_evaluated',
      typeformFilledNoBooking: true
    };
  }

  // F3.1 cross-account FK guard. The personaId parameter locks this
  // turn to the AIPersona that owns Conversation.personaId. F3.2 will
  // replace every internal findFirst({accountId, isActive}) read with
  // findUnique({id: personaId}). Until then, eagerly verify the
  // persona exists AND belongs to accountId so any caller bug surfaces
  // here instead of later as a cross-persona context bleed.
  // Placed AFTER the early-exit safety nets (distress, typeform-no-
  // booking) so synthetic in-memory tests that exit early don't need
  // a real persona row.
  {
    const personaCheck = await prisma.aIPersona.findUnique({
      where: { id: personaId },
      select: { accountId: true }
    });
    if (!personaCheck) {
      throw new Error(
        `[ai-engine] generateReply: AIPersona ${personaId} not found (caller passed accountId=${accountId})`
      );
    }
    if (personaCheck.accountId !== accountId) {
      throw new Error(
        `[ai-engine] generateReply: persona ${personaId} belongs to account ${personaCheck.accountId} but generation was called with accountId=${accountId}. Cross-account call rejected.`
      );
    }
  }

  // No-training guard. The master prompt template still contains hardcoded
  // brand-identity strings (legacy daetradez fixtures — Anthony, Daniel,
  // Session Liquidity Model). For a persona with zero training messages,
  // those fixtures dominate the reply because there is no own-voice signal
  // to anchor against. Refusing to generate is safer than emitting a reply
  // in another tenant's voice. The webhook processor handles the suppressed
  // result by flipping aiActive=false and notifying the operator to upload
  // training data before re-enabling AI.
  {
    const trainingCount = await prisma.trainingMessage.count({
      where: {
        conversation: {
          accountId,
          personaId
        }
      }
    });
    if (trainingCount === 0) {
      console.warn(
        `[ai-engine] generateReply: persona ${personaId} (account ${accountId}) has zero training messages — suppressing AI reply to prevent cross-tenant voice bleed.`
      );
      return {
        reply: '',
        messages: [],
        format: 'text',
        stage: '',
        subStage: null,
        stageConfidence: 0,
        sentimentScore: 0,
        experiencePath: null,
        objectionDetected: null,
        stallType: null,
        affirmationDetected: false,
        followUpNumber: null,
        softExit: false,
        escalateToHuman: true,
        leadTimezone: null,
        selectedSlotIso: null,
        leadEmail: null,
        suggestedTag: '',
        suggestedTags: [],
        shouldVoiceNote: false,
        voiceNoteAction: null,
        qualityScore: 0,
        suggestedDelay: 0,
        systemPromptVersion: 'no-training-suppressed',
        suggestionId: null,
        capitalOutcome: 'not_evaluated',
        noTrainingSuppressed: true
      };
    }
  }

  // 0b. Retrieve few-shot examples from training data (non-fatal)
  //     Uses metadata-filtered 3-tier retrieval when context is available.
  let fewShotBlock: string | null = null;
  let detectedIntent: string | undefined;
  if (lastLeadMsg) {
    try {
      // Classify intent for metadata-aware retrieval (non-fatal)
      try {
        const { classifyContentIntent } = await import(
          '@/lib/content-intent-classifier'
        );
        const intentResult = await classifyContentIntent(
          accountId,
          lastLeadMsg.content,
          conversationHistory
            .slice(-5)
            .map((m) => `${m.sender}: ${m.content}`)
            .join('\n')
        );
        if (intentResult?.intent) {
          detectedIntent = intentResult.intent;
        }
      } catch {
        // Intent classification is optional — continue without it
      }

      fewShotBlock = await retrieveFewShotExamples({
        accountId,
        // F3.3: scope few-shot retrieval to the calling persona so
        // persona A's hand-curated training examples don't bleed into
        // persona B's prompt context.
        personaId,
        currentLeadMessage: lastLeadMsg.content,
        leadStage: leadContext.status,
        leadExperience: leadContext.experience,
        detectedIntent,
        conversationHistory: conversationHistory.slice(-5).map((m) => m.content)
      });
    } catch (err) {
      console.error('[ai-engine] Few-shot retrieval failed (non-fatal):', err);
    }
  }

  // 1. Build the dynamic system prompt with few-shot examples
  // Prior AI-side messages drive the "links already sent" context
  // block so the LLM doesn't resend the same URL when the lead asks
  // for "another video". Pass full history (no slice) — dedup + most-
  // recent-wins selection happens inside buildDynamicSystemPrompt.
  const priorAIMessages = conversationHistory
    .filter((m) => m.sender === 'AI')
    .map((m) => ({ content: m.content, timestamp: m.timestamp }));
  const priorAITurns = groupAIMessagesIntoTurns(conversationHistory);
  const lastAiTurn =
    priorAITurns.length > 0 ? priorAITurns[priorAITurns.length - 1] : null;
  const priorMessageStructures = priorAITurns.map((turn) =>
    classifyMessageStructure(turn.messages)
  );
  const priorValidationOnlyCount = (() => {
    let count = 0;
    for (let i = priorAIMessages.length - 1; i >= 0; i--) {
      if (!isValidationOnlyMessage(priorAIMessages[i].content || '')) break;
      count++;
    }
    return count;
  })();
  const priorFactsBroCount = priorAIMessages.filter((m) =>
    /\bfacts bro\b/i.test(m.content || '')
  ).length;
  const priorYeahBroCount = priorAIMessages.filter((m) =>
    /\byeah bro\b/i.test(m.content || '')
  ).length;
  // Souljah J 2026-04-25 — Fix 3 + Fix 4 inputs.
  const priorHumanMessages = conversationHistory
    .filter((m) => m.sender === 'HUMAN')
    .map((m) => ({ content: m.content, timestamp: m.timestamp }));
  const conversationCurrency =
    detectCurrencyFromTexts(
      conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .map((m) => m.content)
    ) ?? 'USD';
  // Rodrigo Moran 2026-04-26 — when conversation has gotten long enough
  // for the LLM to start losing facts buried in the middle, extract a
  // tight bullet block of established facts from LEAD-side messages and
  // prepend it to the prompt. Threshold of 20 total messages is empirical
  // — short conversations don't need it (the chat history is already
  // small enough for the model to track), and long ones empirically
  // exhibit re-asks past that mark.
  const ESTABLISHED_FACTS_MIN_MESSAGES = 20;
  let establishedFactsBlock: string | null = null;
  if (conversationHistory.length >= ESTABLISHED_FACTS_MIN_MESSAGES) {
    try {
      const { extractEstablishedFacts, buildEstablishedFactsBlock } =
        await import('@/lib/conversation-facts');
      const leadMessagesContent = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .map((m) => ({ content: m.content }));
      const facts = extractEstablishedFacts(leadMessagesContent);
      establishedFactsBlock = buildEstablishedFactsBlock(
        facts,
        leadContext.leadName ?? null
      );
    } catch (err) {
      console.error(
        '[ai-engine] established-facts extraction failed (non-fatal):',
        err
      );
    }
  }

  // Resolve the active conversationId once. Prefer the explicit
  // leadContext.conversationId so first-turn / empty-history paths can still
  // persist script state before generation; fall back to the last persisted
  // Message row for older callers that only pass message ids.
  const lastHistoryMsgWithId = [...conversationHistory]
    .reverse()
    .find((m) => m.id);
  let activeConversationId: string | null = leadContext.conversationId ?? null;
  if (!activeConversationId && lastHistoryMsgWithId?.id) {
    const msgRow = await prisma.message.findUnique({
      where: { id: lastHistoryMsgWithId.id },
      select: { conversationId: true }
    });
    activeConversationId = msgRow?.conversationId || null;
  }
  const writeGenerateReplyTrace = (patch: Record<string, unknown>) =>
    persistGenerateReplyTrace({
      conversationId: activeConversationId,
      patch
    });
  await writeGenerateReplyTrace({
    checkpoint1_entryReached: true,
    checkpoint2_prepareScriptStateComplete: false,
    checkpoint3_promptBuilt: false,
    checkpoint4_classifierBlockReached: false,
    checkpoint5_llmCallStarted: false,
    checkpoint6_responseGenerated: false,
    checkpoint7_qualityGateRun: false,
    checkpoint8_aiSuggestionWritten: false,
    earlyExitReason: null,
    lastCheckpoint: 'checkpoint1_entryReached',
    accountId,
    personaId,
    leadMessageId: lastLeadMsg?.id ?? null,
    leadMessageFirst100: lastLeadMsg?.content?.slice(0, 100) ?? null,
    historyMessageCount: conversationHistory.length
  });

  const conversationCallState = activeConversationId
    ? await prisma.conversation.findUnique({
        where: { id: activeConversationId },
        select: {
          scheduledCallAt: true,
          source: true,
          leadSource: true,
          currentScriptStep: true,
          systemStage: true,
          manyChatOpenerMessage: true,
          manyChatTriggerType: true,
          manyChatCommentText: true,
          manyChatFiredAt: true,
          typeformSubmittedAt: true,
          typeformCapitalConfirmed: true,
          typeformCallScheduledAt: true,
          typeformAnswers: true,
          _count: { select: { messages: true } }
        }
      })
    : null;

  const hasConfiguredScriptForColdStartGate =
    await hasConfiguredScriptForColdStart({
      accountId,
      personaId
    });
  const coldStartStep1Inbound = shouldForceColdStartStep1Inbound({
    conversationHistory,
    hasActiveScript: hasConfiguredScriptForColdStartGate,
    conversationSource: conversationCallState?.source ?? null,
    leadSource: conversationCallState?.leadSource ?? leadContext.source ?? null,
    manyChatFiredAt: conversationCallState?.manyChatFiredAt ?? null,
    systemStage: conversationCallState?.systemStage ?? null,
    currentScriptStep: conversationCallState?.currentScriptStep ?? null,
    conversationMessageCount: conversationCallState?._count.messages ?? null
  });
  if (coldStartStep1Inbound && activeConversationId) {
    await prisma.conversation
      .update({
        where: { id: activeConversationId },
        data: {
          currentScriptStep: 1,
          systemStage: 'STEP_1_INBOUND'
        }
      })
      .catch((err) =>
        console.error(
          '[ai-engine] cold-start pre-prompt state persist failed (non-fatal):',
          err
        )
      );
  }

  // Script-state self-recovery pre-pass. This must run before the prompt is
  // built so serializeScriptForPrompt focuses on the authoritative step from
  // conversation history instead of inferring from raw AI message count.
  let scriptStateSnapshot: ScriptStateSnapshot | null = null;
  let scriptStateError: string | null = null;
  if (activeConversationId) {
    try {
      scriptStateSnapshot = await prepareScriptState({
        accountId,
        conversationId: activeConversationId,
        history: conversationHistory
      });
    } catch (err) {
      scriptStateError = err instanceof Error ? err.message : String(err);
      console.error(
        '[ai-engine] script-state pre-pass failed (non-fatal):',
        err
      );
    }
  }
  const stepCompletionTraceAfterPrepare = asJsonObject(
    (
      scriptStateSnapshot?.capturedDataPoints as
        | Record<string, unknown>
        | undefined
    )?.lastStepCompletionTrace as Prisma.JsonValue
  );
  await writeGenerateReplyTrace({
    checkpoint2_prepareScriptStateComplete: true,
    lastCheckpoint: 'checkpoint2_prepareScriptStateComplete',
    prepareScriptStateError: scriptStateError,
    snapshotCurrentScriptStep: scriptStateSnapshot?.currentScriptStep ?? null,
    snapshotSystemStage: scriptStateSnapshot?.systemStage ?? null,
    snapshotCurrentStepNumber:
      scriptStateSnapshot?.currentStep?.stepNumber ?? null,
    snapshotCurrentStepTitle: scriptStateSnapshot?.currentStep?.title ?? null,
    snapshotBranchLabels:
      scriptStateSnapshot?.currentStep?.branches.map(
        (branch) => branch.branchLabel
      ) ?? [],
    stepCompletionAttempted:
      typeof stepCompletionTraceAfterPrepare.stepCompletionAttempted ===
      'boolean'
        ? stepCompletionTraceAfterPrepare.stepCompletionAttempted
        : null,
    stepCompletionReason:
      typeof stepCompletionTraceAfterPrepare.stepCompletionReason === 'string'
        ? stepCompletionTraceAfterPrepare.stepCompletionReason
        : null,
    previousSelectedBranch:
      typeof stepCompletionTraceAfterPrepare.previousSelectedBranch === 'string'
        ? stepCompletionTraceAfterPrepare.previousSelectedBranch
        : null,
    currentSelectedBranch: null,
    selectedSuggestionId:
      typeof stepCompletionTraceAfterPrepare.selectedSuggestionId === 'string'
        ? stepCompletionTraceAfterPrepare.selectedSuggestionId
        : null,
    historyMessagesWithSelectedSuggestionId:
      typeof stepCompletionTraceAfterPrepare.historyMessagesWithSelectedSuggestionId ===
      'number'
        ? stepCompletionTraceAfterPrepare.historyMessagesWithSelectedSuggestionId
        : null
  });

  if (coldStartStep1Inbound && activeConversationId && scriptStateSnapshot) {
    await persistColdStartStep1InboundState({
      conversationId: activeConversationId,
      snapshot: scriptStateSnapshot
    });
    console.warn('[ai-engine] cold-start Step 1 Inbound forced', {
      conversationId: activeConversationId,
      messageCount:
        conversationCallState?._count.messages ?? conversationHistory.length,
      source: conversationCallState?.source ?? leadContext.source ?? null
    });
  }

  const leadContextForPrompt =
    coldStartStep1Inbound && leadContext.preQualified
      ? { ...leadContext, preQualified: undefined }
      : leadContext;

  // Classify the active branch BEFORE prompt construction so the serializer
  // can hide sibling branches from the LLM. Gate-only active-branch scoping is
  // too late: once all branches are visible in the prompt, the model can still
  // generate from the wrong branch and burn through retries.
  const currentStepNumberForGate =
    typeof scriptStateSnapshot?.currentScriptStep === 'number' &&
    scriptStateSnapshot.currentScriptStep > 0
      ? scriptStateSnapshot.currentScriptStep
      : (scriptStateSnapshot?.currentStep?.stepNumber ?? null);
  const judgeBranchSelectionCache: JudgeBranchSelectionCache = new Map();
  const currentJudgeBranchMatch = await selectJudgeBranchForLead(
    scriptStateSnapshot?.currentStep ?? null,
    lastLeadMsg?.content ?? null,
    {
      accountId,
      cache: judgeBranchSelectionCache
    }
  );
  const currentJudgeBranchLocked = isJudgeBranchLockConfidence(
    currentJudgeBranchMatch.confidence
  );
  const smartModeActive =
    hasRuntimeJudgmentAction(scriptStateSnapshot?.currentStep ?? null) &&
    shouldUseSmartModeForJudgeConfidence(currentJudgeBranchMatch.confidence);
  let selectedCurrentJudgeBranch =
    currentJudgeBranchLocked && currentJudgeBranchMatch.branchLabel
      ? scriptStateSnapshot?.currentStep?.branches.find(
          (branch) => branch.branchLabel === currentJudgeBranchMatch.branchLabel
        )
      : null;
  if (
    !selectedCurrentJudgeBranch &&
    scriptStateSnapshot?.currentStep?.stepNumber === 1 &&
    scriptStateSnapshot.currentStep.branches.length > 0
  ) {
    const selectedStep1Branches = selectStep1BranchesForPrompt(
      scriptStateSnapshot.currentStep.branches,
      {
        conversationSource: coldStartStep1Inbound
          ? 'INBOUND'
          : (conversationCallState?.source ?? null),
        leadSource: coldStartStep1Inbound
          ? 'INBOUND'
          : (conversationCallState?.leadSource ?? leadContext.source ?? null),
        manyChatFiredAt: conversationCallState?.manyChatFiredAt ?? null
      }
    );
    if (selectedStep1Branches.length === 1) {
      selectedCurrentJudgeBranch = selectedStep1Branches[0];
    }
  }
  if (scriptStateSnapshot) {
    scriptStateSnapshot = {
      ...scriptStateSnapshot,
      activeBranch: selectedCurrentJudgeBranch ?? null,
      selectedBranchLabel: selectedCurrentJudgeBranch?.branchLabel ?? null
    };
  }

  const scriptVariableResolutionContext: ScriptVariableResolutionContext = {
    conversationId: activeConversationId,
    capturedDataPoints: scriptStateSnapshot?.capturedDataPoints ?? null,
    conversationHistory: conversationHistory.map((message) => ({
      id: message.id ?? null,
      sender: message.sender,
      content: message.content,
      timestamp: message.timestamp
    })),
    leadContext: leadContextForPrompt as unknown as Record<string, unknown>
  };
  const gateVariableResolutionTexts = collectCurrentStepVariableTexts(
    scriptStateSnapshot?.currentStep ?? null
  );
  const gateVariableResolutionMap = gateVariableResolutionTexts.some((text) =>
    /\{\{\s*[^}]+\s*\}\}/.test(text)
  )
    ? await resolveScriptVariablesForTexts(gateVariableResolutionTexts, {
        accountId,
        context: scriptVariableResolutionContext
      })
    : null;
  if (gateVariableResolutionMap) {
    await persistScriptVariableResolutions({
      conversationId: activeConversationId,
      resolutions: gateVariableResolutionMap.resolvedVariables
    }).catch((err) => {
      console.error('[ai-engine] variable resolution persist failed:', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  let systemPrompt = await buildDynamicSystemPrompt(
    accountId,
    personaId,
    leadContextForPrompt,
    fewShotBlock || undefined,
    priorAIMessages,
    priorHumanMessages,
    conversationCurrency,
    establishedFactsBlock,
    {
      conversationSource: conversationCallState?.source ?? null,
      leadSource:
        conversationCallState?.leadSource ?? leadContext.source ?? null,
      manyChatFiredAt: conversationCallState?.manyChatFiredAt ?? null,
      selectedBranchStepNumber:
        selectedCurrentJudgeBranch && currentStepNumberForGate
          ? currentStepNumberForGate
          : null,
      selectedBranchLabel: selectedCurrentJudgeBranch?.branchLabel ?? null,
      smartMode: smartModeActive,
      smartModeStepNumber:
        smartModeActive && currentStepNumberForGate
          ? currentStepNumberForGate
          : null,
      variableResolutionContext: scriptVariableResolutionContext
    },
    scriptStateSnapshot?.currentScriptStep ?? null
  );
  await writeGenerateReplyTrace({
    checkpoint3_promptBuilt: true,
    lastCheckpoint: 'checkpoint3_promptBuilt',
    promptLength: systemPrompt.length,
    authoritativeCurrentScriptStep:
      scriptStateSnapshot?.currentScriptStep ?? null,
    currentSelectedBranch: selectedCurrentJudgeBranch?.branchLabel ?? null
  });

  // 1b. Append scoring intelligence if available
  if (scoringContext) {
    systemPrompt += '\n\n' + scoringContext;
  }

  // 1b-ii. Voice-note received block. When transcription succeeded, the
  // context builder injects the actual transcript and this block stays off.
  // If processing failed, force the warm fallback instead of hallucinating or
  // using the old "couldn't catch / type it out" wording.
  const lastLeadWasVoice =
    lastLeadMsg?.isVoiceNote === true || lastLeadMsg?.mediaType === 'audio';
  if (lastLeadWasVoice && !lastLeadMsg?.transcription?.trim()) {
    systemPrompt += `\n\n<voice_note_received>\nThe lead just sent a voice note, but media transcription failed or timed out. You do NOT have the audio content. Do NOT pretend you understood it. Do NOT make up content. Send exactly one warm fallback bubble and stop:\n"yo bro something glitched on my end with the audio, drop me the key points in text and i got you"\n</voice_note_received>`;
  }

  // 1c. Promise-tracking: if the last AI turn was an unkept promise
  // (e.g., "My G! I'll explain" with nothing that followed), the LLM
  // must deliver on that promise this turn before advancing the funnel.
  // This fires regardless of voice note availability — it's about
  // conversational continuity, not voice notes specifically.
  const unkeptPattern = lastAiMsg ? isUnkeptPromise(lastAiMsg.content) : null;
  if (unkeptPattern) {
    const promiseText = lastAiMsg!.content.trim();
    // Find the last lead message BEFORE that promise — it's what the
    // explanation is supposed to address.
    const promiseIdx = conversationHistory.findIndex((m) => m === lastAiMsg);
    const priorLeadMsg =
      promiseIdx > 0
        ? [...conversationHistory.slice(0, promiseIdx)]
            .reverse()
            .find((m) => m.sender === 'LEAD')
        : null;
    const priorLeadText = priorLeadMsg?.content?.trim() || '';
    systemPrompt += `\n\n## PROMISE-KEEPING (CRITICAL — READ CAREFULLY)
Your previous message to the lead was: "${promiseText}"
${priorLeadText ? `It was in response to the lead saying: "${priorLeadText.slice(0, 300)}"` : ''}

That message promised follow-up content but did not deliver it. The lead is now waiting and expecting you to explain or show what you said you would. Your next message MUST:

1. Deliver substantive content that fulfills the promise. Actually explain. Actually show. Actually tell them what you said you would.
2. Do NOT open with another qualifying question before delivering. The lead already said they're ready to hear you — don't make them wait again.
3. Do NOT repeat the same preamble ("I'll explain", "lemme explain", "let me show you"). Just deliver the content directly.
4. You CAN follow the explanation with a short forward-moving question to continue the conversation, but only AFTER the substance is there.
5. Keep your established voice: casual texting style, short sentences, no corporate tone.

**LENGTH CONSTRAINT:** Total message MUST be under 450 characters. That's about 2-4 short text-message sentences, not a paragraph. Don't lecture. Pick ONE key point and hit it, then ask the next question. If you can't fit the full explanation in 450 chars, give the high-level gist — they'll ask for more if they want it.

This rule overrides stage progression — even if the funnel says you should be asking a Discovery question next, deliver the promised explanation FIRST, then ask the next question in the SAME message.`;
    console.log(
      `[ai-engine] Promise-tracking triggered: last AI turn "${promiseText}" — injecting delivery directive`
    );
  }

  // ── FINAL OUTPUT FORMAT REMINDER ──────────────────────────────
  // Stacked directive blocks (pre_qualified_context, promise-keeping,
  // voice-notes-disabled) sometimes confuse the LLM into replying with
  // plain text instead of the required JSON. This trailer lands as the
  // LAST thing the model reads before generating, which carries more
  // recency weight than instructions buried hundreds of lines up.
  systemPrompt += `\n\n## OUTPUT FORMAT — NON-NEGOTIABLE (READ LAST)
Your entire response MUST be a single valid JSON object matching the RESPONSE FORMAT schema at the top of this system prompt. No prose. No markdown. No code fences.

At minimum, your JSON must include these fields with valid values:
- "format": "text" (or "voice_note" if enabled)
- "message": the actual reply you want sent to the lead, written in your configured voice (lowercase opener, casual)
- "stage": one of OPENING | SITUATION_DISCOVERY | GOAL_EMOTIONAL_WHY | URGENCY | SOFT_PITCH_COMMITMENT | FINANCIAL_SCREENING | BOOKING — whichever stage you are ACTUALLY in right now based on the conversation
- "stage_confidence": a number 0.0–1.0

The "message" field is lead-facing only. Never put structured metadata inside it: no stage_confidence:1.0, quality_score, stage:, intent:, JSON fragments, placeholders, debug notes, or key:value fields. Those belong ONLY in separate JSON fields.

If you catch yourself writing plain text, stop and rewrite as JSON. The entire pipeline breaks when stage is missing — downstream systems rely on it to track funnel progression.`;

  // 2. Resolve AI provider credentials (per-account BYOK → env fallback)
  const { provider, apiKey, model, fallback } =
    await resolveAIProvider(accountId);

  if (!apiKey) {
    throw new Error(
      'No AI provider configured. Please add your OpenAI or Anthropic API key in Settings → Integrations.'
    );
  }

  // Accumulate usage + final modelUsed across voice-gate retries. The
  // last successful callLLM sets modelUsed — which is the shipped model.
  // usageTotal is the sum of input/output/cache tokens across EVERY
  // attempt so cost tracking reflects the full generation cost.
  let modelUsedFinal: string = model;
  let usageTotal: LLMUsage = { ...EMPTY_USAGE };

  // 3. Format conversation history for the LLM
  const messages = formatConversationForLLM(conversationHistory);

  // R24 — capital verification gate data. We fetch the persona's
  // threshold + optional custom phrasing ONCE, reuse inside the retry
  // loop. When the threshold is null, the gate is disabled entirely
  // (backward compatible for accounts that haven't configured it).
  // F3.2: load the EXACT persona threaded from the caller, not a
  // findFirst({accountId, isActive}) guess. F3.1's cross-account FK
  // guard upstream proved persona.accountId === accountId so this is
  // safe to scope by id alone.
  const personaForGate = await prisma.aIPersona.findUnique({
    where: { id: personaId },
    select: {
      minimumCapitalRequired: true,
      capitalVerificationPrompt: true,
      closerName: true,
      freeValueLink: true,
      downsellConfig: true,
      // Fix B uses closer names to catch "call with {closerName}" / "chat
      // with {closerName}" phrases at any stage.
      promptConfig: true
    }
  });
  const capitalThreshold = personaForGate?.minimumCapitalRequired ?? null;
  const capitalCustomPrompt = personaForGate?.capitalVerificationPrompt ?? null;
  // Audit F2.2 — multi-tenant downsell wording. Pull product name + price
  // from persona.downsellConfig with daetradez-compatible fallbacks so
  // override directives reference the right product/price for any account.
  const downsellCfgForGate = (personaForGate?.downsellConfig || {}) as Record<
    string,
    unknown
  >;
  const downsellProductName =
    typeof downsellCfgForGate.productName === 'string' &&
    downsellCfgForGate.productName.trim()
      ? downsellCfgForGate.productName.trim()
      : 'Session Liquidity Model';
  const downsellPriceStr = (() => {
    const raw = downsellCfgForGate.price;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'string' && raw.trim()) {
      return raw.trim().replace(/^\$/, '');
    }
    return '497';
  })();
  const downsellPriceWithSign = `$${downsellPriceStr}`;
  const promptConfigForGate = (personaForGate?.promptConfig || {}) as {
    callHandoff?: { closerName?: string };
    homeworkUrl?: unknown;
    earlyCapitalGate?: boolean;
  };
  const earlyCapitalGateEnabled = promptConfigForGate.earlyCapitalGate === true;
  const homeworkUrl =
    typeof promptConfigForGate.homeworkUrl === 'string' &&
    /^https?:\/\//i.test(promptConfigForGate.homeworkUrl.trim())
      ? promptConfigForGate.homeworkUrl.trim()
      : null;

  // Path B(1): suppress legacy pacing gates when an active relational
  // Script is present. Those message-count gates were tuned for the old
  // collapsed script and conflict with the parsed 22-step flow where
  // capital is Step 18 after call-proposal acceptance.
  const personaPromptConfig =
    (scriptStateSnapshot?.persona?.promptConfig as Record<
      string,
      unknown
    > | null) || null;
  const explicitSkipLegacyPacingGates =
    personaPromptConfig &&
    typeof personaPromptConfig.skipLegacyPacingGates === 'boolean'
      ? (personaPromptConfig.skipLegacyPacingGates as boolean)
      : null;
  const hasParsedScript = !!scriptStateSnapshot?.script;
  const skipLegacyPacingGates =
    explicitSkipLegacyPacingGates !== null
      ? explicitSkipLegacyPacingGates
      : hasParsedScript;

  // R24 early exit: if the lead has explicitly named capital as the
  // blocker, treat it as the capital answer. Do not ask a verification
  // question on top of it, and do not let the model pitch a call.
  if (lastLeadMsg && hasExplicitCapitalConstraintSignal(lastLeadMsg.content)) {
    if (activeConversationId) {
      await prisma.conversation
        .update({
          where: { id: activeConversationId },
          data: { capitalVerificationStatus: 'VERIFIED_UNQUALIFIED' }
        })
        .catch((err) =>
          console.error(
            '[ai-engine] explicit-capital early-exit state update failed (non-fatal):',
            err
          )
        );
    }

    const reply = buildExplicitCapitalConstraintSoftExit(personaForGate);
    await writeGenerateReplyTrace({
      earlyExitReason: 'explicit_capital_constraint',
      lastCheckpoint: 'early_exit_explicit_capital_constraint',
      checkpoint5_llmCallStarted: false,
      checkpoint6_responseGenerated: true,
      responseFirst100: reply.slice(0, 100),
      responseStage: 'FINANCIAL_SCREENING',
      responseSubStage: 'LOW_TICKET'
    });
    return {
      reply,
      messages: [reply],
      format: 'text',
      stage: 'FINANCIAL_SCREENING',
      subStage: 'LOW_TICKET',
      stageConfidence: 1,
      sentimentScore: 0,
      experiencePath: null,
      objectionDetected: 'capital_constraint',
      stallType: null,
      affirmationDetected: false,
      followUpNumber: null,
      softExit: true,
      escalateToHuman: false,
      leadTimezone: null,
      selectedSlotIso: null,
      leadEmail: null,
      suggestedTag: 'capital-unqualified',
      suggestedTags: ['capital-unqualified'],
      shouldVoiceNote: false,
      voiceNoteAction: null,
      qualityScore: 100,
      suggestedDelay: 0,
      systemPromptVersion: await getPromptVersion(accountId),
      suggestionId: null,
      capitalOutcome: 'failed'
    };
  }

  // ManyChat outbound-context block. When the conversation originated
  // as a ManyChat handoff, prepend an instruction so the AI doesn't
  // send its own greeting and starts at the configured script step.
  // Reads metadata (openerMessage, entryStep) from the persona-level
  // MANYCHAT integration credential. Fail-closed: any read error
  // skips the block, AI uses its default opener flow.
  // Outbound-context injection gate: only fire when the ManyChat
  // handoff is RECENT (within 2 hours). A conversation that originally
  // came in via ManyChat weeks ago and is now receiving a fresh direct
  // DM should NOT get this outbound-context block — the lead isn't
  // responding to the old ManyChat opener, they're sending a new
  // message. (Bug-fix 2026-05-10 — tegaumukoro_ stuck on CTA Inbound
  // branch because May 4 ManyChat opener fired the block on every
  // subsequent DM.)
  if (
    isManyChatRecentlyActive(
      conversationCallState?.source,
      conversationCallState?.manyChatFiredAt
    )
  ) {
    try {
      const { getCredentials } = await import('@/lib/credential-store');
      const mcCreds = await getCredentials(accountId, 'MANYCHAT');
      const opener =
        conversationCallState?.manyChatOpenerMessage?.trim() ||
        (typeof mcCreds?.openerMessage === 'string'
          ? mcCreds.openerMessage.trim()
          : '');
      const triggerType =
        conversationCallState?.manyChatTriggerType || 'new_follower';
      const commentText =
        conversationCallState?.manyChatCommentText?.trim() || '';
      const entryStep =
        typeof mcCreds?.entryStep === 'number' && mcCreds.entryStep >= 1
          ? mcCreds.entryStep
          : 1;
      const stepDescriptor =
        entryStep === 1
          ? 'the very start (Step 1)'
          : entryStep === 2
            ? 'Step 2 (skip the intro, start with discovery)'
            : entryStep === 3
              ? 'Step 3 (skip the intro and breakdown, start with work background)'
              : `Step ${entryStep}`;
      const triggerLine =
        triggerType === 'comment'
          ? `They commented "${commentText || 'unknown'}" on a post and received this DM: "${opener || 'opener not configured'}"`
          : triggerType === 'story_reply'
            ? `They replied to a story and received: "${opener || 'opener not configured'}"`
            : triggerType === 'new_follower'
              ? `They just followed the account and received this opener: "${opener || 'opener not configured'}"`
              : `They received this outbound DM: "${opener || 'opener not configured'}"`;
      const outboundHookLabel = opener
        ? `"${opener}"`
        : `the ${downsellProductName}`;
      const outboundBridgeReference = opener
        ? 'that outbound content'
        : `the ${downsellProductName}`;
      const outboundBlock = `\n\n<outbound_context>\nThis lead was contacted via outbound automation.\n\nTrigger type: ${triggerType}\n${triggerLine}\nOutbound hook to reference: ${outboundHookLabel}\n\nThe outbound opener has already fired.\nThe lead accepting, asking for, or showing interest in the outbound content is NOT soft-pitch acceptance. It is opening engagement.\nRequired stage order: discovery -> goal -> urgency -> soft pitch -> capital.\nDo NOT jump to financial screening. Do NOT ask about capital until discovery/work background and income goal have happened.\nNatural bridge: since they expressed interest in ${outboundHookLabel}, open with a question that connects their interest to their current situation. Start with trading background/current experience/how long they have been trading, then move through goal, urgency, soft pitch, and only then capital.\nReference ${outboundBridgeReference} so the reply does not read as a fresh start.\n\nDo NOT send another opener or greeting.\nThe lead is responding to outreach.\nThey already know who you are.\nConfigured entry-step hint: ${stepDescriptor}. Use this only if it does not skip the required stage order above.\n</outbound_context>`;
      systemPrompt = outboundBlock + '\n' + systemPrompt;
    } catch (mcErr) {
      console.warn(
        '[ai-engine] ManyChat outbound-context prompt injection failed (non-fatal):',
        mcErr
      );
    }
  }

  if (conversationCallState?.typeformSubmittedAt) {
    const applicationBlock = buildApplicationContextBlock({
      submittedAt: conversationCallState.typeformSubmittedAt,
      capitalConfirmed: conversationCallState.typeformCapitalConfirmed,
      callScheduledAt: conversationCallState.typeformCallScheduledAt,
      typeformAnswers: conversationCallState.typeformAnswers,
      closerName: personaForGate?.closerName ?? null
    });
    if (applicationBlock) {
      systemPrompt = applicationBlock + '\n' + systemPrompt;
    }
  }

  // Harvest closer names from both the legacy closerName field and the
  // newer promptConfig.callHandoff.closerName. Lowercased for case-
  // insensitive regex construction inside detectBookingAdvancement.
  const closerNames: string[] = [];
  if (personaForGate?.closerName) closerNames.push(personaForGate.closerName);
  const handoffCfg = promptConfigForGate.callHandoff ?? null;
  if (
    handoffCfg?.closerName &&
    handoffCfg.closerName !== personaForGate?.closerName
  ) {
    closerNames.push(handoffCfg.closerName);
  }

  // 4. Call the LLM with quality gate (retry up to 2x on voice fails
  //    AND/OR R24 capital-verification-gate fails). systemPromptForLLM
  //    is a mutable copy so we can append an override directive when
  //    R24 blocks — the next attempt sees the extra instruction.
  const MAX_RETRIES = 2;
  let parsed: ParsedAIResponse | null = null;
  let qualityGateAttempts = 0;
  let finalQualityScore: number | null = null;
  let qualityGatePassedFirstAttempt = false;
  let preGenerationRecovery: RecoveryResult | null = null;
  let qualityGateTerminalFailure = false;
  let qualityGateFailureReason: string | null = null;
  let qualityGateHardFails: string[] = [];

  // UNQUALIFIED post-exit guard (Kelvin Kelvot 2026-04-24 incident).
  // When lead.stage is already UNQUALIFIED, the AI shouldn't continue
  // qualifying — the conversation has concluded. Valid follow-ups are
  // narrow: repeat the downsell pitch if the lead re-engaged, send the
  // free-resource YouTube link, or soft-exit. Without this block the
  // LLM drifts back into trading-strategy questions and keeps the
  // conversation going like nothing happened.
  const unqualifiedGuard =
    leadContext.status === 'UNQUALIFIED'
      ? `\n\n===== POST-UNQUALIFIED CONVERSATION GUARD =====\nThis lead has already been marked UNQUALIFIED (insufficient capital confirmed earlier in the thread). The sales conversation is effectively over. Your ONLY valid next actions are:\n  (a) Repeat the downsell pitch (lower-ticket course / funding partner) if the lead is re-engaging on that.\n  (b) Send the free-resource YouTube link per the script if they ask for help.\n  (c) Soft-exit with dignity — "when you're in a better spot hit me up" style.\nDo NOT ask trading strategy questions. Do NOT give market advice. Do NOT continue qualification (no Goal/Why, Urgency, Soft Pitch, Financial). Do NOT invite them to book a call. Do NOT send the Typeform / application link. The qualification flow is DONE. A short, warm, non-coaching reply is the correct output.\n=====`
      : '';
  // baseSystemPrompt always carries the unqualified guard when relevant.
  // Retry-loop override assignments below use this as their base so the
  // guard doesn't get stripped when a more-specific override (R24, Fix B,
  // fabrication, ack-truncation, link-promise, markdown) fires.
  const priorAIMessagesForPacing = conversationHistory.filter(
    (m) => m.sender === 'AI' && m.systemPromptVersion !== 'manychat-automation'
  );
  const priorAIQuestions = extractLastAIQuestions(
    priorAIMessagesForPacing.map((m) => m.content),
    3
  );
  const incomeGoalAsked = priorAIMessagesForPacing.some((m) =>
    containsIncomeGoalQuestion(m.content)
  );
  const capitalQuestionAsked = conversationHistory.some(
    (m) =>
      (m.sender === 'AI' || m.sender === 'HUMAN') &&
      containsCapitalQuestion(m.content)
  );
  const capitalVerificationSatisfied =
    hasCapitalVerificationQuestionAndAnswer(conversationHistory);
  const botDetectionCount = conversationHistory.filter(
    (m) => isLeadCapitalParseCandidate(m) && isBotDetectionQuestion(m.content)
  ).length;
  const botDetectionDirective =
    botDetectionCount >= 2
      ? `\n\n===== BOT-DETECTION PATTERN BREAK =====\nThe lead has asked if you are automated twice. Your response pattern has become detectable. Change your approach immediately — respond with something unexpected and personal, then advance to the call pitch. Do not ask another discovery question. If the capital gate is still unmet, the only acceptable advancement question is the capital question; do not ask another trading / setup / strategy question first.\n=====`
      : '';
  const lastLeadHadImage = Boolean(
    lastLeadMsg?.hasImage || lastLeadMsg?.imageUrl
  );
  // Early capital gate (FIX G, 2026-04-30). When the persona has the
  // toggle on AND we've already had 4+ AI messages without surfacing
  // the capital question AND the lead is still in early funnel, force
  // the next turn to ask for capital instead of continuing discovery.
  // Off by default — preserves current pacing behaviour.
  const earlyCapitalGateDirective =
    !skipLegacyPacingGates &&
    earlyCapitalGateEnabled &&
    typeof capitalThreshold === 'number' &&
    capitalThreshold > 0 &&
    !capitalQuestionAsked &&
    priorAIMessagesForPacing.length >= 4 &&
    (leadContext.status === 'NEW_LEAD' ||
      leadContext.status === 'ENGAGED' ||
      leadContext.status === 'QUALIFYING' ||
      !leadContext.status)
      ? `\n\n===== EARLY CAPITAL GATE =====\nBy AI message #4 the capital question must be on the table. You've already had ${priorAIMessagesForPacing.length} AI message${priorAIMessagesForPacing.length === 1 ? '' : 's'} without asking. Skip remaining discovery and ask the capital question on this turn — open-ended is fine ("how much do you have set aside for the markets right now?"). The minimum threshold for this account is $${capitalThreshold.toLocaleString('en-US')}. Do NOT continue Goal/Why or Urgency questions before pinning down capital.\n=====`
      : '';
  // Next-slot directive (SMOKE 13, 2026-05-04). When the AI's last
  // turn was the urgency question and capital hasn't been asked, the
  // qualification flow says CAPITAL is next. Without this, the LLM
  // either regresses to discovery probing ("what's the real why...")
  // or jumps straight to BOOKING_HANDOFF — the latter trips R24, which
  // ships the canned R24-blocked fallback. Both fail the
  // capital-before-soft-pitch contract. Fires on the first attempt so
  // the LLM never produces the bad reply in the first place.
  const lastAiAskedUrgency = lastAiMsg
    ? containsUrgencyQuestion(lastAiMsg.content)
    : false;
  const nextSlotIsCapitalDirective =
    !skipLegacyPacingGates &&
    lastAiAskedUrgency &&
    !capitalQuestionAsked &&
    typeof capitalThreshold === 'number' &&
    capitalThreshold > 0
      ? `\n\n===== NEXT SLOT: CAPITAL =====\nYou just asked the urgency question and the lead just answered it. Per the qualification flow, the next required slot is CAPITAL — ask it on THIS turn. Open-ended phrasings are fine: "real quick, what's your capital situation like for the markets right now?", "how much you got set aside for trading?", "what're you sitting on as far as capital goes?", "you ready to deploy at least $${capitalThreshold.toLocaleString('en-US')}?". Do NOT pitch a call. Do NOT route to booking, application, Typeform, or send a "team will reach out" message. Do NOT regress to discovery probes like "what's the real why", "what would that change for you", or "what's been holding you back". Acknowledge the lead's urgency answer in one short opener (e.g., "bet, love the urgency"), then ask the capital question.\n=====`
      : '';
  // Operator correction directive — fires when the most recent
  // setter-side message (AI or HUMAN) carries isHumanCorrection=true,
  // meaning the operator unsent the prior AI message and replaced it
  // with a manual correction within 2 minutes. The LLM must treat the
  // operator's correction as the canonical prior turn and ignore the
  // unsent message (which has already been filtered out of the
  // history at the DB layer via deletedAt).
  const lastSetterMsg = [...conversationHistory]
    .reverse()
    .find((m) => m.sender === 'AI' || m.sender === 'HUMAN');
  const operatorCorrectionDirective =
    lastSetterMsg?.isHumanCorrection === true
      ? `\n\n===== OPERATOR CORRECTION =====\nThe operator unsent the previous AI message and replaced it with the most recent setter message you see in the history. The unsent message is GONE — it was retracted before the lead acted on it. Treat the operator's correction as the canonical prior turn. Do NOT reference the unsent message's content. Do NOT apologise for the prior message. Continue the conversation forward from the operator's correction as if that's exactly what was sent.\n=====`
      : '';
  // Prior captured signals — surface variables the LLM captured on
  // earlier turns via runtime_judgment so it keeps referencing them
  // (e.g. early_obstacle, willingness_to_invest). Filtered to keys the
  // active script's runtime judgments actually define so unrelated
  // structured fields don't pollute the block.
  let priorCapturedSignalsDirective = '';
  try {
    const knownVariableNames =
      await collectRuntimeJudgmentVariableNames(accountId);
    const block = buildPriorCapturedSignalsBlock(
      scriptStateSnapshot?.capturedDataPoints ?? null,
      knownVariableNames
    );
    if (block) {
      priorCapturedSignalsDirective = '\n\n' + block;
    }
  } catch (err) {
    console.error(
      '[ai-engine] prior captured signals block build failed (non-fatal):',
      err
    );
  }
  const capturedDataPointsForGate = scriptStateSnapshot?.capturedDataPoints;
  const incomeGoalCapturedForStep10 = incomeGoalSatisfiedByExpectedStep(
    capturedDataPointsForGate ?? null,
    9
  );
  const deepWhyCapturedForStep10 =
    hasCapturedDataPoint(capturedDataPointsForGate ?? null, 'deepWhy') ||
    hasCapturedDataPoint(capturedDataPointsForGate ?? null, 'deep_why') ||
    hasCapturedDataPoint(capturedDataPointsForGate ?? null, 'desiredOutcome') ||
    hasCapturedDataPoint(capturedDataPointsForGate ?? null, 'desired_outcome');
  const step10DeepWhyDirective =
    incomeGoalCapturedForStep10 && !deepWhyCapturedForStep10
      ? buildStep10DeepWhyDirective(
          formatGoalForDeepWhyAsk(
            capturedPointRawValue(capturedDataPointsForGate ?? null, [
              'incomeGoal',
              'income_goal'
            ]),
            lastLeadMsg?.content ?? null
          )
        )
      : '';
  const coldStartStep1Directive = coldStartStep1Inbound
    ? buildColdStartStep1InboundDirective()
    : '';
  const judgeClassificationDirective = await buildJudgeClassificationDirective({
    step: scriptStateSnapshot?.currentStep ?? null,
    latestLeadMessage: lastLeadMsg?.content ?? null,
    accountId,
    cache: judgeBranchSelectionCache,
    variableResolutionMap: gateVariableResolutionMap
  });
  const smartModeDirective = smartModeActive
    ? `\n\n===== SMART MODE RESPONSE =====\nThe branch router could not confidently lock a branch for the current [JUDGE] step (${currentJudgeBranchMatch.confidence} confidence). Do not force the lead into a default branch.\n\nRespond naturally in the persona's voice. Address the lead's actual message, use the current step description and goal as direction, and end with one question that progresses the conversation toward this step's goal.\n\nDo not copy literal [MSG]/[ASK] content from sibling branches unless it clearly fits what the lead just said. Do not invent URLs, booking details, capital facts, or outcomes.\n=====`
    : '';

  const baseSystemPrompt =
    coldStartStep1Directive +
    systemPrompt +
    unqualifiedGuard +
    botDetectionDirective +
    earlyCapitalGateDirective +
    nextSlotIsCapitalDirective +
    operatorCorrectionDirective +
    priorCapturedSignalsDirective +
    step10DeepWhyDirective +
    judgeClassificationDirective +
    smartModeDirective;
  let systemPromptForLLM = baseSystemPrompt;
  let r24GateEverForcedRegen = false;
  let r24LastResult: R24GateResult = {
    blocked: false,
    reason: 'confirmed_affirmative',
    parsedAmount: null,
    verificationAskedAt: null,
    verificationConfirmedAt: null
  };
  let r24WasEvaluatedThisTurn = false;
  let lastR24Override = '';

  // Resolve the action shape from prepareScriptState's authoritative current
  // step. Multi-bubble delivery means AI message count is not a reliable
  // proxy for script position; the serializer and quality gates must inspect
  // the same step.
  const currentStepShape = scriptStateSnapshot?.script
    ? getStepActionShape(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        scriptStateSnapshot.script as any,
        currentStepNumberForGate ?? 1
      )
    : null;
  await writeGenerateReplyTrace({
    checkpoint4_classifierBlockReached: true,
    lastCheckpoint: 'checkpoint4_classifierBlockReached',
    inferredStepNumberForGate: currentStepNumberForGate,
    snapshotCurrentScriptStep: scriptStateSnapshot?.currentScriptStep ?? null,
    classifierStepNumber: scriptStateSnapshot?.currentStep?.stepNumber ?? null,
    classifierStepTitle: scriptStateSnapshot?.currentStep?.title ?? null,
    classifierBranchLabels:
      scriptStateSnapshot?.currentStep?.branches.map(
        (branch) => branch.branchLabel
      ) ?? []
  });
  try {
    await persistJudgeClassifierTrace({
      conversationId: activeConversationId,
      match: currentJudgeBranchMatch,
      snapshotCurrentScriptStep: scriptStateSnapshot?.currentScriptStep ?? null,
      inferredStepNumberForGate: currentStepNumberForGate,
      step: scriptStateSnapshot?.currentStep ?? null
    });
  } catch (err) {
    console.error('[branch-classifier] DB trace persist failed:', {
      conversationId: activeConversationId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  const stepCompletionTraceAfterClassifier = asJsonObject(
    (
      scriptStateSnapshot?.capturedDataPoints as
        | Record<string, unknown>
        | undefined
    )?.lastStepCompletionTrace as Prisma.JsonValue
  );
  await writeGenerateReplyTrace({
    stepCompletionAttempted:
      typeof stepCompletionTraceAfterClassifier.stepCompletionAttempted ===
      'boolean'
        ? stepCompletionTraceAfterClassifier.stepCompletionAttempted
        : null,
    stepCompletionReason:
      typeof stepCompletionTraceAfterClassifier.stepCompletionReason ===
      'string'
        ? stepCompletionTraceAfterClassifier.stepCompletionReason
        : null,
    previousSelectedBranch:
      typeof stepCompletionTraceAfterClassifier.previousSelectedBranch ===
      'string'
        ? stepCompletionTraceAfterClassifier.previousSelectedBranch
        : null,
    currentSelectedBranch: selectedCurrentJudgeBranch?.branchLabel ?? null,
    selectedSuggestionId:
      typeof stepCompletionTraceAfterClassifier.selectedSuggestionId ===
      'string'
        ? stepCompletionTraceAfterClassifier.selectedSuggestionId
        : null,
    historyMessagesWithSelectedSuggestionId:
      typeof stepCompletionTraceAfterClassifier.historyMessagesWithSelectedSuggestionId ===
      'number'
        ? stepCompletionTraceAfterClassifier.historyMessagesWithSelectedSuggestionId
        : null
  });
  const activeBranchRequiredMessages = selectedCurrentJudgeBranch
    ? getActiveBranchRequiredMessages(
        selectedCurrentJudgeBranch,
        scriptStateSnapshot?.currentStep?.actions ?? [],
        gateVariableResolutionMap
      )
    : undefined;
  const activeBranchScriptedQuestions = selectedCurrentJudgeBranch
    ? getActiveBranchScriptedQuestions(
        selectedCurrentJudgeBranch,
        scriptStateSnapshot?.currentStep?.actions ?? [],
        gateVariableResolutionMap
      )
    : undefined;
  const currentStepRequiredMessagesForGate = resolveMessageContentsForGate(
    currentStepShape?.requiredMessageContents ?? [],
    gateVariableResolutionMap
  );
  const currentStepScriptedQuestionsForGate = resolveMessageContentsForGate(
    currentStepShape?.scriptedQuestionContents ?? [],
    gateVariableResolutionMap
  );
  const currentStepHasAskBranch =
    selectedCurrentJudgeBranch !== null &&
    selectedCurrentJudgeBranch !== undefined
      ? branchHasAskAction(selectedCurrentJudgeBranch)
      : (currentStepShape?.hasAnyAskAction ?? false);
  const currentStepActiveBranchIsSilent = selectedCurrentJudgeBranch
    ? branchIsSilent(selectedCurrentJudgeBranch)
    : false;
  const currentStepHasSilentBranch = selectedCurrentJudgeBranch
    ? currentStepActiveBranchIsSilent
    : (currentStepShape?.hasSilentBranch ?? false);
  const currentStepSilentBranchLabels = selectedCurrentJudgeBranch
    ? currentStepActiveBranchIsSilent
      ? [selectedCurrentJudgeBranch.branchLabel]
      : []
    : (currentStepShape?.silentBranchLabels ?? []);
  const currentStepActiveBranchIsJudgeOnly = selectedCurrentJudgeBranch
    ? branchHasRuntimeJudgmentOnly(selectedCurrentJudgeBranch)
    : false;
  const currentStepActiveBranchLabel =
    selectedCurrentJudgeBranch?.branchLabel ?? null;
  const currentTurnAllowedUrls = collectCurrentTurnAllowedUrls({
    snapshot: scriptStateSnapshot ?? null,
    currentStepNumber: currentStepNumberForGate
  });
  if (scriptStateSnapshot?.script) {
    const selectedStep = scriptStateSnapshot.script.steps.find(
      (step) => step.stepNumber === currentStepNumberForGate
    );
    console.log('[script-debug] current step selection:', {
      conversationId: activeConversationId,
      snapshotCurrentScriptStep: scriptStateSnapshot.currentScriptStep,
      inferredStepNumberForGate: currentStepNumberForGate,
      conversationTurnCount: countConversationTurns(conversationHistory),
      currentStepTitle: selectedStep?.title ?? null,
      capturedKeys: Object.keys(scriptStateSnapshot.capturedDataPoints ?? {}),
      requiredMessageFirst100:
        currentStepShape?.requiredMessageContents?.[0]?.slice(0, 100) ?? null
    });
  }

  const buildVoiceQualityOptions = (
    candidateMessageCount: number,
    capitalOutcomeOverride?: VoiceGateCapitalOutcome
  ) => ({
    smartMode: smartModeActive,
    relaxLengthLimit: !!unkeptPattern,
    conversationMessageCount: conversationHistory.length,
    leadStage: leadContext.status || undefined,
    capitalOutcome:
      capitalOutcomeOverride ??
      (r24LastResult.reason === 'answer_below_threshold'
        ? ('failed' as const)
        : undefined),
    previousAIMessage: lastAiTurn?.content ?? lastAiMsg?.content ?? null,
    recentAIMessages: priorAITurns.slice(-3).map((turn) => turn.content),
    priorMessageStructures: priorMessageStructures.slice(-4),
    aiMessageCount: priorAIMessagesForPacing.length + candidateMessageCount,
    conversationSource: conversationCallState?.source ?? null,
    capturedDataPoints: scriptStateSnapshot?.capturedDataPoints ?? {},
    currentStepHasSilentBranch,
    currentStepSilentBranchLabels,
    currentStepScriptedQuestions: currentStepScriptedQuestionsForGate,
    activeBranchScriptedQuestions,
    currentStepRequiredMessages: currentStepRequiredMessagesForGate,
    activeBranchRequiredMessages,
    currentStepHasAnyAskAction: currentStepShape?.hasAnyAskAction ?? false,
    activeBranchHasSilentBranch: selectedCurrentJudgeBranch
      ? currentStepActiveBranchIsSilent
      : undefined,
    activeBranchHasAskAction: selectedCurrentJudgeBranch
      ? currentStepHasAskBranch
      : undefined,
    allowedUrls: currentTurnAllowedUrls,
    currentStepHasAskBranch,
    currentStepActiveBranchIsSilent,
    currentStepActiveBranchIsJudgeOnly,
    currentStepActiveBranchLabel,
    currentScriptStepNumber: currentStepNumberForGate ?? undefined,
    aiMessageHistoryFull: priorAIMessages.map((m) => ({ content: m.content })),
    skipLegacyPacingGates,
    currentStage: parsed?.stage || null,
    incomeGoalAsked,
    capitalQuestionAsked,
    capitalVerificationRequired:
      typeof capitalThreshold === 'number' && capitalThreshold > 0,
    capitalVerificationSatisfied,
    previousAIQuestions: priorAIQuestions,
    previousLeadMessage: lastLeadMsg?.content ?? null,
    previousLeadHadImage: lastLeadHadImage,
    leadEmail: leadContext.booking?.leadEmail ?? null,
    scheduledCallAt: conversationCallState?.scheduledCallAt ?? null,
    homeworkUrl,
    priorCapitalQuestionAskCount: countCapitalQuestionAsks(priorAIMessages),
    priorRealQuickPhraseCount: priorAIMessages.filter((m) =>
      /\breal\s+quick\b/i.test(m.content || '')
    ).length,
    priorValidationOnlyCount,
    priorFactsBroCount,
    priorYeahBroCount,
    leadImplicitlySignaledNoCapital: conversationHistory.some((m) => {
      if (m.sender !== 'LEAD') return false;
      const t = m.content || '';
      return (
        /\b(broke|nothing\s+(really|man|bro)?|no\s+money|don'?t\s+have\s+(any\s+)?(money|capital|anything|much))\b/i.test(
          t
        ) ||
        hasExplicitCapitalConstraintSignal(t) ||
        /\b(i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school|in\s+(college|university|highschool|high\s+school))\b/i.test(
          t
        ) ||
        /\b(jobless|unemployed|no\s+job|lost\s+my\s+job|between\s+jobs|laid\s+off|no\s+income|no\s+work|out\s+of\s+work)\b/i.test(
          t
        ) ||
        /\b(can'?t\s+(eat|pay\s+rent|pay\s+bills|afford))\b/i.test(t) ||
        /\b(i\s+(have|got)\s+nothing|got\s+nothing\s+(right\s+now|rn|atm|man|bro))\b/i.test(
          t
        )
      );
    }),
    ...(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const det =
        require('@/lib/conversation-detail-extractor') as typeof import('@/lib/conversation-detail-extractor');
      const recentLead = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .slice(-2)
        .map((m) => ({ content: m.content }));
      const recentLeadDetails = det.extractRecentLeadDetails(recentLead);
      const recentAi = priorAIMessages.slice(-6);
      const priorConsecutivePureQuestionCount =
        det.countConsecutivePureQuestions(recentAi, recentLeadDetails);
      return {
        priorConsecutivePureQuestionCount,
        recentLeadDetails
      };
    })(),
    leadVagueCapitalAnswerInLastReply:
      capitalQuestionAsked &&
      Boolean(lastLeadMsg?.content) &&
      looksLikeVagueCapitalAnswer(lastLeadMsg!.content),
    leadPreObjectedToCapital: leadHasPreObjectedToCapital(
      conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .slice(-4)
        .map((m) => m.content)
    ),
    priorMessageCorpus: conversationHistory
      .slice(-30)
      .map((m) => m.content)
      .join('\n'),
    mediaContextCorpus: buildMediaContextCorpus(conversationHistory),
    callLogisticsAlreadyDelivered:
      callLogisticsAlreadyDeliveredInRecentHistory(conversationHistory),
    lastLeadMessageWasAcknowledgmentOnly: isAcknowledgmentOnlyLeadMessage(
      lastLeadMsg?.content
    ),
    closerNames,
    // R37 burst extension (Jefferson @namejeffe 2026-05-03). Pass the
    // full history; the gate's getUnacknowledgedLeadBurst walks
    // backward from the end and stops at the first AI/HUMAN turn.
    conversationHistory: conversationHistory.map((m) => ({
      sender: m.sender,
      content: m.content
    }))
  });

  // Resolve the persona-specific urgency-stage timeline question once per
  // generation. Used by:
  //   - the stalled-qualification regen directive (mid-loop)
  //   - the validation-loop regen directive (mid-loop)
  //   - the retry-exhausted parsed.message replacements (final attempt)
  // Falls back through Active Script → AIPersona.promptConfig → generic
  // safe phrasing. NEVER returns the retired daetradez "how soon are you
  // trying to make this happen" phrasing.
  const personaUrgencyQuestion = await resolveScriptUrgencyQuestion(
    accountId,
    personaId
  );

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    qualityGateAttempts = attempt + 1;
    const sanitizedPrompt = resolveOrStripTemplateVariables(
      systemPromptForLLM,
      {
        capturedDataPoints: scriptStateSnapshot?.capturedDataPoints ?? null,
        leadContext: leadContextForPrompt,
        lastLeadMessage: lastLeadMsg?.content ?? null
      }
    );
    if (
      sanitizedPrompt.resolvedVariables.length > 0 ||
      sanitizedPrompt.strippedVariables.length > 0
    ) {
      console.warn('[ai-engine] sanitized template variables before LLM call', {
        resolvedVariables: Array.from(
          new Set(sanitizedPrompt.resolvedVariables)
        ),
        strippedVariables: Array.from(
          new Set(sanitizedPrompt.strippedVariables)
        ),
        attempt: attempt + 1
      });
    }
    await writeGenerateReplyTrace({
      checkpoint5_llmCallStarted: true,
      lastCheckpoint: 'checkpoint5_llmCallStarted',
      llmAttempt: attempt + 1,
      provider,
      model,
      sanitizedPromptLength: sanitizedPrompt.text.length
    });
    const callResult = await callLLM(
      provider,
      apiKey,
      model,
      sanitizedPrompt.text,
      messages,
      fallback
    );
    modelUsedFinal = callResult.modelUsed;
    usageTotal = addUsage(usageTotal, callResult.usage);

    try {
      parsed = parseAIResponse(callResult.text);
    } catch (err) {
      if (err instanceof InvalidLLMOutputError) {
        await recordR34MetadataLeakCatch({
          accountId,
          conversationId: activeConversationId,
          attempt: attempt + 1,
          matchedText: err.found ?? err.code,
          matchedPattern: err.code,
          replyPreview: callResult.text.slice(0, 500),
          stage: null,
          leadMessage: lastLeadMsg?.content ?? null
        });

        if (attempt < MAX_RETRIES) {
          systemPromptForLLM =
            baseSystemPrompt +
            buildR34MetadataLeakDirective(err.found ?? err.code);
          console.warn(
            `[ai-engine] R34 parser strict-mode rejection on attempt ${attempt + 1}/${MAX_RETRIES + 1}; forcing regen`
          );
          continue;
        }

        parsed = buildR34BlockedFallbackParsed();
        finalQualityScore = 0;
        console.error(
          `[ai-engine] R34 parser strict-mode exhausted ${MAX_RETRIES + 1} attempts — pausing with safe holding line for convo ${activeConversationId}`
        );
        break;
      }
      throw err;
    }
    const futureStepMismatch = detectFutureStepContentMismatch({
      snapshot: scriptStateSnapshot ?? null,
      currentStepNumber: currentStepNumberForGate,
      messages: parsed.messages,
      currentAllowedUrls: currentTurnAllowedUrls
    });
    await writeGenerateReplyTrace({
      checkpoint6_responseGenerated: true,
      lastCheckpoint: 'checkpoint6_responseGenerated',
      llmAttempt: attempt + 1,
      modelUsed: modelUsedFinal,
      responseFirst100: parsed.message?.slice(0, 100) ?? null,
      responseStage: parsed.stage ?? null,
      responseSubStage: parsed.subStage ?? null,
      responseMessageCount: parsed.messages?.length ?? 0,
      detectedFutureStepContent: futureStepMismatch.detectedFutureStepContent,
      mismatchSeverity: futureStepMismatch.mismatchSeverity,
      mismatchMatchedStepNumber: futureStepMismatch.matchedStepNumber,
      mismatchMatchedReason: futureStepMismatch.matchedReason
    });

    const parsedMetadataLeak = parsed.parserMetadataLeak;
    const generatedTextForLeakCheck = parsed.messages.join('\n');
    const postParseMetadataLeak = detectMetadataLeak(generatedTextForLeakCheck);
    if (parsedMetadataLeak || postParseMetadataLeak.leak) {
      const matchedText =
        parsedMetadataLeak?.matchedText ?? postParseMetadataLeak.matchedText;
      const matchedPattern =
        parsedMetadataLeak?.matchedPattern ??
        postParseMetadataLeak.matchedPattern;

      await recordR34MetadataLeakCatch({
        accountId,
        conversationId: activeConversationId,
        attempt: attempt + 1,
        matchedText,
        matchedPattern,
        replyPreview: generatedTextForLeakCheck.slice(0, 500),
        stage: parsed.stage || null,
        leadMessage: lastLeadMsg?.content ?? null
      });

      const stripped = stripMetadataLeaksFromMessages(parsed.messages);
      if (stripped.success) {
        const strippedCandidate = {
          ...parsed,
          message: stripped.messages[0] ?? '',
          messages: stripped.messages,
          parserMetadataLeak: null
        };
        const strippedQuality = scoreVoiceQualityGroup(
          strippedCandidate.messages,
          buildVoiceQualityOptions(strippedCandidate.messages.length || 1)
        );
        if (
          strippedQuality.passed &&
          strippedQuality.hardFails.length === 0 &&
          !detectMetadataLeak(strippedCandidate.messages.join('\n')).leak
        ) {
          parsed = strippedCandidate;
          console.warn(
            `[ai-engine] R34 surgical strip succeeded on attempt ${attempt + 1}/${MAX_RETRIES + 1}; continuing through remaining gates`
          );
        } else {
          console.warn(
            `[ai-engine] R34 surgical strip failed downstream quality gate on attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${strippedQuality.hardFails.join(', ') || 'score'}`
          );
          if (attempt < MAX_RETRIES) {
            systemPromptForLLM =
              baseSystemPrompt + buildR34MetadataLeakDirective(matchedText);
            continue;
          }
          parsed = buildR34BlockedFallbackParsed();
          finalQualityScore = strippedQuality.score;
          break;
        }
      } else {
        console.warn(
          `[ai-engine] R34 surgical strip could not produce coherent lead-facing copy on attempt ${attempt + 1}/${MAX_RETRIES + 1}`
        );
        if (attempt < MAX_RETRIES) {
          systemPromptForLLM =
            baseSystemPrompt + buildR34MetadataLeakDirective(matchedText);
          continue;
        }
        parsed = buildR34BlockedFallbackParsed();
        finalQualityScore = 0;
        break;
      }
    }

    const judgeBranchViolation = await detectJudgeBranchViolation({
      step: scriptStateSnapshot?.currentStep ?? null,
      latestLeadMessage: lastLeadMsg?.content ?? null,
      generatedMessages:
        parsed.messages && parsed.messages.length > 0
          ? parsed.messages
          : [parsed.message],
      accountId,
      cache: judgeBranchSelectionCache,
      variableResolutionMap: gateVariableResolutionMap
    });
    if (judgeBranchViolation.blocked) {
      const judgeOverride = `\n\n===== [JUDGE] BRANCH MISMATCH — REGENERATE CURRENT BRANCH =====\n${judgeBranchViolation.reason}\n\nThe script engine already classified the latest lead reply into branch "${judgeBranchViolation.matchedBranchLabel}". You must run that branch's scripted actions now.\n\nFORBIDDEN ON THIS REGEN:\n  ✗ Using a different branch's [ASK] or [MSG]\n  ✗ Advancing to the NEXT STEP preview before the matched branch completes\n  ✗ Defaulting to a branch just because it appears later in the script\n\nREQUIRED ON THIS REGEN:\n  ✓ Send the matched branch's [MSG]/[ASK] content verbatim or near-verbatim\n  ✓ Then wait for the lead's reply before advancing\n=====`;
      if (attempt < MAX_RETRIES) {
        systemPromptForLLM = baseSystemPrompt + judgeOverride;
        console.warn(
          `[ai-engine] [JUDGE] branch mismatch — forcing regen (attempt ${attempt + 1}/${MAX_RETRIES + 1}). reason="${judgeBranchViolation.reason}"`
        );
        continue;
      }

      if (judgeBranchViolation.fallbackMessages.length > 0) {
        parsed = {
          ...parsed,
          message: judgeBranchViolation.fallbackMessages[0],
          messages: judgeBranchViolation.fallbackMessages,
          stageConfidence: 1,
          stallType: null,
          escalateToHuman: false
        };
        console.warn(
          `[ai-engine] [JUDGE] branch mismatch persisted through retries — shipping deterministic matched-branch fallback for "${judgeBranchViolation.matchedBranchLabel}"`
        );
      }
    }

    // P0 script-step skip prevention. If the LLM draft jumps ahead of the
    // authoritative script step (for example soft-pitching a call before
    // capital qualification is complete), replace the draft with a
    // deterministic bridging recovery before normal quality gates run.
    if (
      activeConversationId &&
      scriptStateSnapshot &&
      !rescheduleFlow &&
      !lastLeadMsg?.content?.trimStart().startsWith('OPERATOR NOTE:')
    ) {
      const draftMessages =
        parsed.messages && parsed.messages.length > 0
          ? parsed.messages
          : [parsed.message];
      const skipCheck = detectAttemptedStepSkip({
        snapshot: scriptStateSnapshot,
        plannedAction: draftMessages
      });
      const softPitchValidation = validateSoftPitchPrerequisites({
        snapshot: scriptStateSnapshot,
        action: draftMessages
      });
      const shouldRecoverSkip =
        skipCheck.skip || softPitchValidation.allowed === false;

      if (shouldRecoverSkip) {
        try {
          await prisma.bookingRoutingAudit
            .create({
              data: {
                conversationId: activeConversationId,
                accountId,
                personaMinimumCapital: capitalThreshold ?? null,
                routingAllowed: false,
                regenerationForced: true,
                blockReason: skipCheck.skip
                  ? 'script_step_skip_detected'
                  : 'soft_pitch_prerequisites_missing',
                aiStageReported: parsed.stage || null,
                aiSubStageReported: parsed.subStage || null,
                contentPreview: draftMessages.join('\n').slice(0, 200)
              }
            })
            .catch(() => null);

          const recovery = await attemptStepSkipRecovery({
            accountId,
            conversationId: activeConversationId,
            history: conversationHistory,
            triggerReason: skipCheck.skip
              ? 'pre_generation_skip_prevention'
              : 'soft_pitch_prerequisites_missing',
            plannedAction: draftMessages,
            llmEmittedStage: parsed.stage
          });

          if (recovery.recovered) {
            const recoveryQuality = scoreVoiceQualityGroup(
              recovery.messages,
              buildVoiceQualityOptions(
                recovery.messages.length || 1,
                recovery.capitalOutcome === 'failed' ? 'failed' : undefined
              )
            );
            const recoveryPassed =
              recoveryQuality.passed && recoveryQuality.hardFails.length === 0;

            if (recoveryPassed) {
              parsed.message = recovery.reply;
              parsed.messages = recovery.messages;
              parsed.format = 'text';
              parsed.stage = recovery.stage;
              parsed.subStage = recovery.subStage;
              parsed.stageConfidence = 1;
              parsed.stallType = null;
              parsed.softExit = false;
              parsed.escalateToHuman = false;
              parsed.voiceNoteAction = null;
              finalQualityScore = recoveryQuality.score;
              qualityGateTerminalFailure = false;
              qualityGateFailureReason = null;
              qualityGateHardFails = [];
              preGenerationRecovery = recovery;
              if (attempt === 0) qualityGatePassedFirstAttempt = true;
              console.warn(
                `[ai-engine] Script-step skip prevented for convo ${activeConversationId}: ${recovery.reason}`
              );
              break;
            }

            await markSelfRecoveryEventFailed(
              recovery.eventId,
              `quality_gate_failed:${recoveryQuality.hardFails.join(',') || 'score'}`
            );
            parsed.escalateToHuman = true;
            parsed.stallType = 'SCRIPT_SKIP_RECOVERY_FAILED';
            console.warn(
              `[ai-engine] Script-step skip recovery rejected by voice gate for convo ${activeConversationId}: ${recoveryQuality.hardFails.join(', ') || 'score'}`
            );
            break;
          }

          parsed.escalateToHuman = true;
          parsed.stallType = 'SCRIPT_SKIP_RECOVERY_FAILED';
          console.warn(
            `[ai-engine] Script-step skip detected but recovery failed for convo ${activeConversationId}: ${recovery.reason}`
          );
          break;
        } catch (err) {
          console.error(
            '[ai-engine] Script-step skip prevention failed (non-fatal):',
            err
          );
        }
      }
    }

    // 5. Voice quality gate — runs per-bubble via scoreVoiceQualityGroup.
    // For single-message responses (flag-off persona), parsed.messages is
    // [parsed.message] and the group wrapper degenerates to a single call
    // — byte-identical to the pre-multi-bubble behaviour. Multi-bubble
    // responses get per-bubble hardFails tagged [bubble=N] plus the
    // group-level cta_ack_only_truncation check on the joined string.
    //
    // conversationMessageCount + leadStage power the new
    // premature_soft_exit_warm_lead signal (soft -0.4). R24 hasn't run
    // yet for this iteration, so we use the LAST iteration's outcome
    // as capitalOutcome — good enough to gate the signal, since the
    // current-iteration R24 only matters for the PROMOTION step.
    const quality = scoreVoiceQualityGroup(
      parsed.messages,
      buildVoiceQualityOptions(parsed.messages?.length || 1)
    );
    if (rescheduleFlow) {
      const ignoredRescheduleFailures = [
        'income_goal_overdue:',
        'capital_question_overdue:',
        'qualification_stalled:',
        'call_pitch_before_capital_verification:',
        'logistics_before_qualification:'
      ];
      const beforeCount = quality.hardFails.length;
      quality.hardFails = quality.hardFails.filter(
        (failure) =>
          !ignoredRescheduleFailures.some((token) => failure.includes(token))
      );
      delete quality.softSignals.unnecessary_scheduling_question;
      delete quality.softSignals.logistics_before_qualification;
      if (quality.hardFails.length !== beforeCount) {
        quality.passed = quality.hardFails.length === 0;
        console.log(
          `[ai-engine] Reschedule flow bypassed ${beforeCount - quality.hardFails.length} qualification gate failure(s)`
        );
      }
    }
    finalQualityScore = quality.score;
    qualityGateHardFails = [...quality.hardFails];
    if (quality.passed) {
      qualityGateTerminalFailure = false;
      qualityGateFailureReason = null;
      qualityGateHardFails = [];
    }
    await writeGenerateReplyTrace({
      checkpoint7_qualityGateRun: true,
      lastCheckpoint: 'checkpoint7_qualityGateRun',
      llmAttempt: attempt + 1,
      qualityPassed: quality.passed,
      qualityScore: quality.score,
      qualityHardFails: quality.hardFails,
      qualitySoftSignalKeys: Object.keys(quality.softSignals ?? {})
    });

    // R37 acceptance bypass — when the lead's last message is an explicit
    // acceptance ("Yes bro", "lfg", "bet") AND the AI's previous turn
    // promised an artifact (link / call / resource offer), the system has
    // already routed past the capital question for this offer. R37's
    // r37_acceptance_loopback gate hard-fails any reply that loops back
    // to qualification in this state — so R24/Fix B must not force the
    // loop themselves. Without this, the gates and R37 conflict and the
    // retry loop exhausts into a deterministic "ask capital" fallback,
    // dropping the artifact the lead just accepted.
    const r37AcceptanceBypass = Boolean(
      lastLeadMsg &&
        lastAiMsg &&
        isExplicitAcceptance(lastLeadMsg.content) &&
        aiPromisedArtifact(lastAiMsg.content)
    );

    // 5b. R24 CAPITAL VERIFICATION GATE. Runs only when (a) the active
    //     account has a threshold configured, (b) we resolved a
    //     conversationId, and (c) this reply is routing the lead into
    //     booking-handoff messaging ("team is gonna reach out", "let's
    //     gooo bro" wrap-up, BOOKING_CONFIRM sub-stage, etc.). When
    //     those conditions are met, look in the conversation history
    //     for a prior AI verification question + an affirmative lead
    //     reply. If either is missing, BLOCK this response and retry
    //     with a synthetic override directive appended to the system
    //     prompt.
    let r24Blocked = false;
    if (
      activeConversationId &&
      !rescheduleFlow &&
      !r37AcceptanceBypass &&
      typeof capitalThreshold === 'number' &&
      capitalThreshold > 0 &&
      isRoutingToBookingHandoff(parsed)
    ) {
      r24WasEvaluatedThisTurn = true;
      r24LastResult = await checkR24Verification(
        activeConversationId,
        accountId,
        capitalThreshold,
        capitalCustomPrompt,
        // Pass the current-turn LEAD message as a timing-defensive
        // override — if it happens to be saved microseconds after
        // the gate's own DB snapshot, the override guarantees the
        // answer-to-the-Q still gets classified. See checkR24
        // Verification doc for the specifics.
        lastLeadMsg
          ? {
              sender: lastLeadMsg.sender,
              content: lastLeadMsg.content,
              timestamp: lastLeadMsg.timestamp
            }
          : undefined
      );
      r24Blocked = r24LastResult.blocked;
    }

    // 5c. FIX B — broader capital-advancement gate. Independent of R24's
    //     `isRoutingToBookingHandoff` trigger; fires on ANY response
    //     that attempts to advance the lead (by stage OR content) when
    //     the capital question hasn't been verified yet. Catches LLM
    //     outputs that mislabel their stage (e.g., reported OPENING
    //     with "hop on a quick chat with the closer" in the message),
    //     which is the Nez Futurez 2026-04-20 failure mode. Creates a
    //     BookingRoutingAudit row on every block so ops has a 48h
    //     diagnostic log. Skipped if R24 already blocked this turn —
    //     one block directive at a time to avoid conflicting overrides.
    let fixBBlocked = false;
    let fixBResult: CapitalVerificationBlockResult | null = null;
    if (
      !r24Blocked &&
      !rescheduleFlow &&
      !r37AcceptanceBypass &&
      activeConversationId &&
      typeof capitalThreshold === 'number' &&
      capitalThreshold > 0
    ) {
      fixBResult = await shouldBlockForCapitalVerification({
        parsed,
        conversationId: activeConversationId,
        accountId,
        capitalThreshold,
        capitalCustomPrompt,
        closerNames,
        currentTurnLeadMsg: lastLeadMsg
          ? {
              sender: lastLeadMsg.sender,
              content: lastLeadMsg.content,
              timestamp: lastLeadMsg.timestamp
            }
          : undefined
      });
      fixBBlocked = fixBResult.blocked;
    }

    // 5c-ii. FUNDING-PARTNER GEOGRAPHY GATE. R24 blocks booking
    // attempts, but a model can still pitch "funding partner" as a
    // downsell/alternative without using booking-handoff language.
    // For non-US/CA leads, that option is invalid, so block any generated
    // funding-partner pitch before it reaches the lead.
    let restrictedFundingBlocked = false;
    let restrictedFundingCountry: string | null = null;
    if (!r24Blocked && !fixBBlocked && mentionsFundingPartnerRoute(parsed)) {
      const recentLeadMessages = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .slice(-10)
        .map((m) => m.content);
      const geo = detectRestrictedGeography(
        leadContext.geography,
        recentLeadMessages
      );
      if (geo.restricted) {
        restrictedFundingBlocked = true;
        restrictedFundingCountry = geo.country;
      }
    }

    // 5d. BOOKING FABRICATION GATE (Rufaro 2026-04-18 fix).
    //     Independent of R24/Fix B. Fires whenever the AI's reply
    //     claims real-time booking state (anthony-is-ready, zoom-link-
    //     incoming, you're-all-set) AND the conversation has no actual
    //     scheduledCallAt / bookingId. Skips entirely when a real
    //     booking exists — the AI CAN reference a call that's
    //     actually scheduled. This is a pure content detector, so it
    //     runs even when R24/Fix B didn't block.
    let fabricationBlocked = false;
    let fabricationResult: BookingFabricationBlockResult | null = null;
    if (
      activeConversationId &&
      !r24Blocked &&
      !fixBBlocked &&
      !restrictedFundingBlocked
    ) {
      fabricationResult = await shouldBlockForBookingFabrication({
        parsed,
        conversationId: activeConversationId,
        closerNames
      });
      fabricationBlocked = fabricationResult.blocked;
    }

    const unnecessarySchedulingQuestionFailed =
      quality.softSignals.unnecessary_scheduling_question !== undefined;
    const logisticsBeforeQualificationFailed =
      quality.softSignals.logistics_before_qualification !== undefined;
    const repeatedQuestionFailed =
      quality.softSignals.repeated_question !== undefined;
    const homeworkBeforeCallFailed =
      quality.softSignals.homework_sent_before_call_confirmed !== undefined;
    const prematureExitOnSoftHesitationFailed =
      quality.softSignals.premature_exit_on_soft_hesitation !== undefined;
    const validationLoopFailed =
      quality.softSignals.validation_loop !== undefined;
    const overusedValidationPhraseFailed =
      quality.softSignals.overused_validation_phrase !== undefined;
    const qualificationStalledFailed = quality.hardFails.some((f) =>
      f.includes('qualification_stalled:')
    );
    const capitalQuestionOverdueFailed = quality.hardFails.some((f) =>
      f.includes('capital_question_overdue:')
    );
    const longTimelineCallPitchFailed = quality.hardFails.some((f) =>
      f.includes('long_timeline_call_pitch:')
    );
    const manyChatEarlyCapitalFailed = quality.hardFails.some((f) =>
      f.includes('manychat_early_capital_question:')
    );
    const callProposalPrereqsMissingFailed = quality.hardFails.some((f) =>
      f.includes('call_proposal_prereqs_missing:')
    );
    const silentBranchViolationFailed = quality.hardFails.some((f) =>
      f.includes('silent_branch_violated_with_question:')
    );
    const multipleQuestionsFailed = quality.hardFails.some((f) =>
      f.includes('multiple_questions_in_reply:')
    );
    const step10DeepWhySkippedFailed = quality.hardFails.some((f) =>
      f.includes('step_10_deep_why_skipped:')
    );
    const capitalQuestionPrematureFailed = quality.hardFails.some((f) =>
      f.includes('capital_question_premature:')
    );
    const stepDistanceViolationFailed = quality.hardFails.some((f) =>
      f.includes('step_distance_violation:')
    );
    const mandatoryAskSkippedFailed = quality.hardFails.some((f) =>
      f.includes('mandatory_ask_skipped:')
    );
    const msgVerbatimViolationFailed = quality.hardFails.some((f) =>
      f.includes('msg_verbatim_violation:')
    );
    const missingRequiredQuestionFailed = quality.hardFails.some((f) =>
      f.includes('missing_required_question_on_ask_step:')
    );

    if (
      quality.passed &&
      !unnecessarySchedulingQuestionFailed &&
      !logisticsBeforeQualificationFailed &&
      !repeatedQuestionFailed &&
      !homeworkBeforeCallFailed &&
      !prematureExitOnSoftHesitationFailed &&
      !longTimelineCallPitchFailed &&
      !validationLoopFailed &&
      !overusedValidationPhraseFailed &&
      !r24Blocked &&
      !fixBBlocked &&
      !restrictedFundingBlocked &&
      !fabricationBlocked
    ) {
      if (attempt === 0) qualityGatePassedFirstAttempt = true;
      if (attempt > 0) {
        console.log(
          `[ai-engine] Quality + R24 passed on retry ${attempt} (score: ${quality.score.toFixed(2)})`
        );
      }
      break;
    }

    // R24 regeneration path — the override directive is REASON-
    // specific. "Never asked" → ask the question. "Below threshold" →
    // pivot to the downsell branch. "Ambiguous" → ask clarifying Q.
    // Voice-quality failures retry without mutation; R24 needs this
    // extra nudge because the LLM doesn't otherwise know which
    // corrective path to take.
    if (r24Blocked) {
      r24GateEverForcedRegen = true;
      const thresholdStr = `$${capitalThreshold!.toLocaleString('en-US')}`;
      let r24Directive = '';
      // Pre-objection check (Steven Biggam 2026-04-30). When the lead
      // has flagged "anyone asking for a lot is a red flag" / "I'm on
      // a budget" / similar, the capital question must be prefaced
      // with reassurance. Compute once for the whole switch.
      const recentLeadForPreObj = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .slice(-4)
        .map((m) => m.content);
      const leadPreObjected = leadHasPreObjectedToCapital(recentLeadForPreObj);
      const preObjPrefix = leadPreObjected
        ? `IMPORTANT — the lead pre-objected to being asked for capital (e.g. "anyone asking for a lot is a red flag", "I'm on a budget"). Open with reassurance BEFORE the capital question, exactly like: "nah bro i'm not here to pressure you into anything — just need to know what you're working with to point you in the right direction". Then ask the capital question naturally. Do NOT ignore the pre-objection.\n\n`
        : '';
      switch (r24LastResult.reason) {
        case 'never_asked':
          r24Directive = `${preObjPrefix}Your previous reply tried to route the lead into booking-handoff messaging (team reaching out, call confirmation, etc.) BUT this conversation has not yet asked the capital verification question. You MUST regenerate. Your next reply must ask the lead about their capital — either the threshold-confirming form ("you got at least ${thresholdStr} in capital ready to start?") or the open-ended form ("how much do you have set aside?") whichever fits your voice. Do NOT send any booking-handoff language until the lead confirms an amount.`;
          break;
        case 'asked_but_no_answer':
          r24Directive = `You already asked the capital verification question, but the lead hasn't answered yet. Do NOT route to booking-handoff. Wait for their answer, or send a short nudge to re-ask. Do NOT advance until they state an amount.`;
          break;
        case 'answer_below_threshold': {
          const stated = formatCapitalAmountForDirective(r24LastResult);
          let baseDirective = `The lead's stated capital (${stated}) is below the minimum threshold (${thresholdStr}). Your ONLY valid next action is the DOWNSELL PITCH. Do NOT ask more trading questions. Do NOT ask what they're working on. Do NOT give market / strategy advice. Do NOT route to booking. Do NOT send the Typeform / application form. Do NOT say "the team will reach out". Do NOT re-ask the capital question.\n\nFire the script's Step 9 "Not Qualified" branch NOW: acknowledge their situation in one short line (no judgment, no lecture), then present the lower-ticket course / downsell from the script ("my ${downsellPriceWithSign} ${downsellProductName} course breaks it down — same strategy, you learn on your own pace while you build capital" style). Wait for their answer to the downsell before any further routing. If your script has no downsell, send a soft-exit message that keeps the door open. Continuing the qualification dialogue after a confirmed capital miss is the exact failure mode this rule exists to prevent.`;

          // GEOGRAPHY GATE — funding-partner programs only onboard
          // US/CA leads. When the lead is elsewhere, strip the
          // funding-partner option from the downsell menu so the AI
          // doesn't pitch a path the lead can't actually take.
          const recentLeadMessages = conversationHistory
            .filter((m) => m.sender === 'LEAD')
            .slice(-10)
            .map((m) => m.content);
          const geo = detectRestrictedGeography(
            leadContext.geography,
            recentLeadMessages
          );
          if (geo.restricted) {
            baseDirective += `\n\nGEOGRAPHY GATE: The lead is based in ${geo.country}. Funding-partner programs (FTMO-style funded accounts, broker prop programs) are only available to leads in the US and Canada. DO NOT route this lead to the funding-partner branch under any circumstances. The only options you may offer here are: (1) the ${downsellPriceWithSign} course downsell, or (2) a free YouTube / resource redirect. Do not explain how prop firms work. Do not mention funded accounts, challenges, or third-party capital as an option.`;
            console.warn(
              `[ai-engine] R24 geography gate: restricted country "${geo.country}" detected for conv ${activeConversationId} — funding-partner path blocked`
            );
          }

          r24Directive = baseDirective;
          break;
        }
        case 'answer_hedging':
          r24Directive = `The lead hedged on the capital question ("kinda", "working on it", "almost", etc.) without giving a concrete number. Do NOT route to booking. Ask a single follow-up that pins down a concrete dollar figure — for example "no stress, what's the number you're working with rn?". Do NOT send booking-handoff messaging until you have a concrete amount.`;
          break;
        case 'answer_total_savings_needs_clarification':
          r24Directive = `The lead gave a capital number, but framed it as total savings / tight funds / family financial stress. Total savings is NOT the same as available trading capital. Do NOT route to booking yet. Ask one clarifying question that surfaces what they are actually comfortable investing, for example: "got it bro — of that amount, how much would you actually be comfortable putting toward your trading education right now?" Wait for that answer before any call proposal or booking handoff.`;
          break;
        case 'answer_ambiguous':
          r24Directive = `The lead's reply to the capital question didn't give a clear answer ("depends", "varies", "not sure", etc.). Do NOT route to booking. Ask a short clarifying question that gets a concrete dollar figure. Do NOT send booking-handoff messaging yet.`;
          break;
        case 'answer_prop_firm_only':
          r24Directive = `The lead mentioned a prop firm, funded account, or challenge (FTMO / Apex / Topstep / etc.) but did NOT state personal capital they have set aside. Firm capital is NOT personal capital — the lead accessing a $100k challenge account means the FIRM put up that money, not the lead. Do NOT route to booking. Ask specifically about PERSONAL capital: something like "respect bro, prop firms are solid. but what I'm asking is what YOU'VE got set aside for your own education and trading — not the firm's money. you got ${thresholdStr} ready on your end?". Make the distinction clear and wait for a concrete answer.`;
          break;
        case 'answer_currency_unclear':
          r24Directive = `The lead gave a capital number but the currency is unclear — no recognized symbol ($, £, ₦, ₵, R, ₱, €, CAD, etc.) and no prior currency context in this conversation. Do NOT assume USD. Do NOT say the amount is good or bad. Do NOT route to booking, downsell, or anywhere else yet. Ask exactly one short clarifying question — for example: "is that in USD bro, or a different currency?" Wait for the answer before classifying. Once they confirm the currency, the next turn will re-evaluate against the threshold and route correctly.`;
          break;
        case 'answer_vague_capital':
          r24Directive = `The lead's reply to the capital question was a vague non-answer ("manageable amount", "starting small", "saving up", "very little", "I'll figure it out") — no concrete dollar figure was given. Do NOT route to booking. Do NOT pitch the call. Do NOT send the Typeform. Ask ONE short follow-up that pins down a ballpark number with multiple-choice anchors, exactly like: "ballpark is fine bro — like under $500, closer to $1k, or more than that?". The anchors give them concrete ranges to pick from — much harder to dodge than an open-ended "what number". This is your single probe — if the lead dodges again, the next turn will route to the downsell automatically. Do NOT acknowledge the vague answer with "respect the grind" or "love that" — that signals acceptance and the lead will keep dodging.`;
          break;
      }
      const r24Override = `\n\n===== CRITICAL R24 OVERRIDE =====\n${r24Directive}\n=====`;
      lastR24Override = r24Override;
      systemPromptForLLM = baseSystemPrompt + r24Override;
      console.warn(
        `[ai-engine] R24 gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${r24LastResult.reason} parsedAmount=${r24LastResult.parsedAmount ?? 'null'} currency=${r24LastResult.parsedCurrency ?? 'null'} usd=${r24LastResult.parsedAmountUsd !== undefined && r24LastResult.parsedAmountUsd !== null ? Math.round(r24LastResult.parsedAmountUsd) : 'null'}`
      );
    }

    // FIX B regeneration path — fires when R24 didn't trigger but the
    // content-level advancement gate did. Writes a dedicated audit row
    // so operators can distinguish R24 blocks from Fix B blocks in the
    // 48h diagnostic review. Injects an override that's almost
    // identical to R24's `never_asked` directive — the LLM still needs
    // to ask the capital question, just via a different upstream path.
    if (fixBBlocked && fixBResult) {
      const thresholdStr = `$${capitalThreshold!.toLocaleString('en-US')}`;
      try {
        await prisma.bookingRoutingAudit.create({
          data: {
            conversationId: activeConversationId!,
            accountId,
            personaMinimumCapital: capitalThreshold,
            routingAllowed: false,
            regenerationForced: true,
            blockReason: fixBResult.reason,
            aiStageReported: parsed.stage || null,
            aiSubStageReported: parsed.subStage || null,
            contentPreview: parsed.message.slice(0, 200)
          }
        });
      } catch (auditErr) {
        console.error(
          '[ai-engine] Fix B BookingRoutingAudit write failed (non-fatal):',
          auditErr
        );
      }
      const fixBDirective = `Your previous reply attempted to advance this conversation toward a call pitch, booking, or resource handoff — but the lead has NOT yet confirmed they have at least ${thresholdStr} in capital available to start. You MUST regenerate. Your next reply MUST ask the capital verification question before pitching the call, application, or any next step. Use the threshold-confirming form ("you got at least ${thresholdStr} in capital ready to start?") or the open-ended form ("how much do you have set aside?") — whichever fits your voice. Do NOT pitch the call or drop any link until the lead confirms an amount. This was detected at LLM stage=${parsed.stage || 'unknown'}, sub_stage=${parsed.subStage ?? 'null'} — so your internal stage labeling is not enough: you must actually ask the question before any advancement language.`;
      const fixBOverride = `\n\n===== CRITICAL CAPITAL-VERIFICATION OVERRIDE (Fix B) =====\n${fixBDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + fixBOverride;
      console.warn(
        `[ai-engine] Fix B gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fixBResult.reason} stage=${parsed.stage} sub=${parsed.subStage ?? 'null'}`
      );
    }

    if (restrictedFundingBlocked) {
      const geoLabel = restrictedFundingCountry || 'a non-US/Canada country';
      const restrictedFundingDirective = `The lead is based in ${geoLabel}. Funding-partner / funded-account routes are only available to leads in the US and Canada. Your previous reply mentioned a funding partner, funded account, prop firm, challenge, or third-party capital option. You MUST regenerate without that route.\n\nCorrect path: if the lead is below the capital threshold, route directly to the downsell. If they decline the downsell, send the free resource if one is available. Do NOT explain how prop firms work. Do NOT mention funded accounts, challenges, funding partner, or third-party capital as an option.`;
      const restrictedFundingOverride = `\n\n===== FUNDING-PARTNER GEOGRAPHY OVERRIDE =====\n${restrictedFundingDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + restrictedFundingOverride;
      console.warn(
        `[ai-engine] Funding-partner geography gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — country=${geoLabel}`
      );
    }

    // BOOKING FABRICATION regeneration path. Logged to
    // BookingRoutingAudit so the 48h diagnostic review can filter on
    // `blockReason='booking_state_fabrication'`. Directive is direct:
    // don't claim real-time booking state, route the lead to the
    // booking link instead.
    if (fabricationBlocked && fabricationResult) {
      try {
        await prisma.bookingRoutingAudit.create({
          data: {
            conversationId: activeConversationId!,
            accountId,
            personaMinimumCapital: capitalThreshold,
            routingAllowed: false,
            regenerationForced: true,
            blockReason: 'booking_state_fabrication',
            aiStageReported: parsed.stage || null,
            aiSubStageReported: parsed.subStage || null,
            contentPreview: parsed.message.slice(0, 200)
          }
        });
      } catch (auditErr) {
        console.error(
          '[ai-engine] Booking-fabrication BookingRoutingAudit write failed (non-fatal):',
          auditErr
        );
      }
      const fabricationDirective = `CRITICAL: You claimed a call or meeting is happening or about to happen, but NO call has been booked in the system. There is no zoom link being sent. No one is standing by on a call. The system does NOT auto-book calls.\n\nYour reply must ONLY instruct the lead to use the booking link to schedule a time themselves. Do NOT claim:\n- Anyone is about to join a call or is on the call\n- A zoom link is being sent or is on the way\n- A calendar invite is coming through or in their email\n- The lead is "all set" or "locked in"\n\nCorrect framing: "the team handles scheduling on their end, they'll reach out with the call details" OR "go ahead and grab a time that works for you with the link above, you'll get a confirmation when you book".`;
      const fabricationOverride = `\n\n===== CRITICAL BOOKING-FABRICATION OVERRIDE =====\n${fabricationDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + fabricationOverride;
      console.warn(
        `[ai-engine] Booking fabrication BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fabricationResult.reason} content="${parsed.message.slice(0, 120)}"`
      );
    }

    if (unnecessarySchedulingQuestionFailed) {
      const schedulingOverride = `\n\n===== CALL ACCEPTANCE TYPEFORM OVERRIDE =====\nLead agreed to the call. Send the Typeform / booking link now, do not ask about scheduling. The Typeform handles scheduling. Use the real Typeform or booking URL from the script's Available Links & URLs section; do not invent a URL or use a placeholder.\n=====`;
      systemPromptForLLM = baseSystemPrompt + schedulingOverride;
      console.warn(
        `[ai-engine] Unnecessary scheduling question detected after call acceptance — forcing Typeform link drop (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (logisticsBeforeQualificationFailed) {
      const logisticsOverride = `\n\n===== LOGISTICS BEFORE QUALIFICATION OVERRIDE =====\nDo not collect scheduling details before capital is verified. Ask the capital question first: "real quick, what's your capital situation like for the markets right now?" Do NOT ask for timezone, location, day, or time on this turn.\n=====`;
      systemPromptForLLM = baseSystemPrompt + logisticsOverride;
      console.warn(
        `[ai-engine] Logistics question before capital verification detected — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    // Log voice-quality failures (existing behaviour, unchanged).
    if (!quality.passed) {
      console.warn(
        `[ai-engine] Voice quality FAIL attempt ${attempt + 1}/${MAX_RETRIES + 1}:`,
        {
          score: quality.score.toFixed(2),
          hardFails: quality.hardFails,
          message: parsed.message.slice(0, 100)
        }
      );

      try {
        await prisma.voiceQualityFailure.create({
          data: {
            accountId,
            message: parsed.message,
            score: quality.score,
            hardFails: quality.hardFails as unknown as object,
            attempt: attempt + 1,
            leadMessage: lastLeadMsg?.content?.slice(0, 500) || null
          }
        });
      } catch {
        // Table might not exist yet — that's fine
      }

      // CTA-acknowledgment-only truncation directive injection. When the
      // voice gate fires `cta_acknowledgment_only_truncation`, just
      // retrying the same prompt tends to produce the same truncated
      // reply — the model has already decided the acknowledgment-only
      // shape. Append an explicit override so the next attempt knows
      // the specific correction required: put the whole multi-line
      // reply in the single "message" field AND include a qualifying
      // question. This mirrors the R24 directive-injection pattern.
      // Group scorer prefixes failures with "[bubble=N] " or "[group] "
      // depending on scope, so match on the reason token via .includes()
      // instead of .startsWith() now.
      const ackTruncationFailed = quality.hardFails.some((f) =>
        f.includes('cta_acknowledgment_only_truncation:')
      );
      if (ackTruncationFailed) {
        const ackOverride = `\n\n===== ACKNOWLEDGMENT-ONLY TRUNCATION OVERRIDE =====\nYour previous response was just an acknowledgment — it did not include a qualifying question, so the lead has nothing to respond to and the conversation stalls. You MUST regenerate. Your next "message" field MUST contain BOTH the acknowledgment AND a forward-moving qualifying question in the SAME single "message" string. Multi-line is fine — use line breaks between acknowledgment, any URL, and the question. Do NOT write "Message 1 / Message 2 / Message 3" — the schema is one "message" field; if you only put the acknowledgment there, that is literally all the lead sees.\n=====`;
        systemPromptForLLM = baseSystemPrompt + ackOverride;
        console.warn(
          `[ai-engine] CTA acknowledgment-only truncation detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Link-promise-without-URL directive (Shishir 2026-04-20).
      // The LLM announced a link send but didn't include the URL.
      // Same class of failure as ack-truncation: natural regen
      // tends to reproduce the same mistake. Inject an explicit
      // override telling the model to INCLUDE the URL from the
      // script's Available Links section.
      // Course-payment placeholder leak directive (George 2026-04-08
      // incident). When the LLM emits "[COURSE PAYMENT LINK]" /
      // "[WHOP LINK]" / "[CHECKOUT LINK]" / similar, the gate
      // hard-fails. Generic regen tends to either re-emit the
      // placeholder OR generate a fake-looking URL. Override forces
      // the LLM to use only configured URLs from the prompt, never an
      // account-specific fallback baked into application code.
      const courseLinkLeaked = quality.hardFails.some((f) =>
        f.includes('course_link_placeholder_leaked:')
      );
      if (courseLinkLeaked) {
        const courseLinkOverride = `\n\n===== COURSE / PAYMENT LINK PLACEHOLDER LEAK =====\nYour previous reply contained a literal placeholder like "[COURSE PAYMENT LINK]" / "[WHOP LINK]" / "[CHECKOUT LINK]" / "[PAYMENT LINK]" instead of the actual URL. The lead would have seen the raw brackets in their messaging app, not a clickable link.\n\nOn this regen:\n  1. Use the EXACT course / payment URL from the script's "Available Links & URLs" section above only if a verified URL is listed there. Paste it verbatim.\n  2. If no verified course/payment URL is listed in the script, DO NOT send a course/payment URL. Continue the qualification flow or route to the configured free-value fallback instead.\n  3. NEVER ship square-bracketed placeholders like [LINK], [URL], [COURSE LINK], [PAYMENT LINK], [WHOP LINK], [CHECKOUT LINK], [BOOKING LINK]. They render literally to the lead.\n  4. The URL is the delivery only when it is configured. Never invent or use a fallback checkout URL from memory.\n=====`;
        systemPromptForLLM = baseSystemPrompt + courseLinkOverride;
        console.warn(
          `[ai-engine] Course/payment link placeholder leak detected — forcing regen with real URL (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const linkPromiseFailed = quality.hardFails.some((f) =>
        f.includes('link_promise_without_url:')
      );
      if (linkPromiseFailed) {
        const linkOverride = `\n\n===== LINK-PROMISE-WITHOUT-URL OVERRIDE =====\nYour previous reply announced sending a link ("I'll send you the link" / "here's the link" / "sending you the link" / etc.) but did NOT include the actual URL. The lead is now waiting with nothing to click. You MUST regenerate. Your next reply MUST include the EXACT URL from the script's "Available Links & URLs" section inline with your message. Do NOT say you'll send a link and then fail to include it. The URL IS the delivery — the words around it are just framing. Put the URL on its own line or inline: "here's the link: <URL>" / "grab a time that works for you: <URL>" / "<URL> fill it out and lmk when done". The URL must be a real https:// link from the script, not a placeholder like [LINK] or [BOOKING LINK].\n=====`;
        systemPromptForLLM = baseSystemPrompt + linkOverride;
        console.warn(
          `[ai-engine] Link promise without URL detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const fabricatedUrlFailed = quality.hardFails.some((f) =>
        f.includes('fabricated_url_in_reply:')
      );
      if (fabricatedUrlFailed) {
        const fabricatedUrlOverride = `\n\n===== FABRICATED URL IN REPLY =====\nYou included a URL that is not in the current script. Remove the URL. Use only URLs explicitly provided in [LINK] actions or persona configuration.\n=====`;
        systemPromptForLLM = baseSystemPrompt + fabricatedUrlOverride;
        console.warn(
          `[ai-engine] Fabricated URL detected — forcing regen without unauthorized URL (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Repeated-call-pitch directive (Souljah J 2026-04-25). Fires
      // when the previous AI bubble AND this one BOTH contain a call-
      // pitch phrase. Natural regen tends to repeat the same pitch
      // — model momentum from the script. Override forces it to
      // acknowledge the lead's interim response BEFORE pitching.
      const repeatedCallPitchFailed = quality.hardFails.some((f) =>
        f.includes('repeated_call_pitch:')
      );
      if (repeatedCallPitchFailed) {
        const repeatedPitchOverride = `\n\n===== REPEATED CALL PITCH OVERRIDE =====\nYou already pitched the call on the previous turn. The lead responded — but they did not give a clear yes or no. Pitching the call again on this turn reads as desperate and trains the lead to ghost. You MUST regenerate WITHOUT pitching the call again. Instead:\n  1. Acknowledge SPECIFICALLY what the lead just said in their last message — answer their question if they asked one, address their stall if they stalled, react to their content if they shared something.\n  2. THEN move the conversation forward with a relevant follow-up question OR a brief value drop. Do NOT immediately pitch the call again.\n  3. Only re-pitch the call once the lead has given a clear yes/no on the prior pitch — not on this turn.\nForbidden phrases on this regen: "hop on a call", "hop on a chat", "call with [name]", "quick call", "quick chat", "jump on a call", "get on a call", "15-min call". Save the call-pitch language for a turn AFTER the lead has clearly responded.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedPitchOverride;
        console.warn(
          `[ai-engine] Repeated call pitch detected — forcing regen without pitch (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Repeated-capital-question directive (Rodrigo Moran 2026-04-26).
      // The LLM tried to ask the capital threshold question a second
      // time, having already asked once earlier in the conversation.
      // Natural regen tends to reproduce the same shape — model
      // momentum from the script's qualification flow. Override forces
      // it to advance the conversation differently.
      const repeatedCapitalQFailed = quality.hardFails.some((f) =>
        f.includes('repeated_capital_question:')
      );
      if (repeatedCapitalQFailed) {
        const repeatedCapitalOverride = `\n\n===== REPEATED CAPITAL QUESTION OVERRIDE =====\nYou ALREADY asked the lead about capital earlier in this conversation. The lead either answered or sidestepped it. Asking AGAIN makes the bot read as stuck in a loop (a real lead literally said "I think your bot is stuck doing a loop" on this exact failure). You MUST regenerate WITHOUT asking the capital question again.\n\nWhat to do instead:\n  1. If the lead's prior answer was a clear amount (≥ threshold), reference it: "since you got [amount] ready, let's get you locked in with [closer]…"\n  2. If the prior answer was a clear DECLINE / "not yet" / "after my [event]", route to the timing-aware branch: acknowledge the constraint and pivot to either a downsell, the YouTube channel, or scheduling the call after the stated event.\n  3. If the prior answer was AMBIGUOUS, do not re-ask the same threshold question. Instead, shift to a different qualifying question (urgency, timeline, motivation) or move toward booking with the closer.\n\nForbidden patterns on this regen: any "do you have at least \\$X", "you got \\$X ready", "how much do you have / set aside / saved", "what are you working with", "capital ready", "just to confirm…\\$".\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedCapitalOverride;
        console.warn(
          `[ai-engine] Repeated capital question detected — forcing regen with no-re-ask directive (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Capital-after-implicit-no directive (Rodrigo Moran 2026-04-26).
      // Lead has already signaled "no money" without a number. The
      // LLM tried to ask the threshold question anyway. Override
      // tells it to treat that signal as the answer and route to
      // the downsell branch.
      const capitalAfterImplicitNoFailed = quality.hardFails.some((f) =>
        f.includes('capital_q_after_implicit_no:')
      );
      if (capitalAfterImplicitNoFailed) {
        const directive = `\n\n===== CAPITAL Q AFTER IMPLICIT NO =====\nThe lead has ALREADY told you they have no money in this conversation — "I'm a student", "no job", "broke", "I got nothing", or similar. That IS their capital answer. Asking the threshold question on top of it ignores them and reads as the bot not paying attention.\n\nWhat to do instead on this regen:\n  • Acknowledge what they said briefly + with empathy ("damn ok bro, gotchu" / "ah I hear you fr").\n  • Pivot to the script's downsell / lower-tier option (the ${downsellPriceWithSign} ${downsellProductName} course / funding-partner option / YouTube channel as appropriate).\n  • Do NOT ask "do you have at least $X" or "what's your capital situation" or "how much you working with" or any variant. Capital was answered.\nForbidden phrases on this regen: "do you have at least", "you got at least", "at least \\$1k", "capital ready", "what's your capital situation", "how much you working with", "set aside for".\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Capital question after implicit-no detected — forcing regen to downsell branch (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // "or nah?" question tail directive — the LLM keeps using
      // "or nah?" as a yes/no question construction. Override tells
      // it to phrase open-ended.
      const orNahFailed = quality.hardFails.some((f) =>
        f.includes('or_nah_question_tail:')
      );
      if (orNahFailed) {
        const directive = `\n\n===== "OR NAH?" QUESTION TAIL OVERRIDE =====\nDo not end questions with "or nah?". That construction primes a yes/no answer and reads as scripted. Use OPEN-ENDED phrasing on the regen — let the lead disclose freely instead of forcing them to pick yes/no. Examples:\n  WRONG: "do you have at least \\$1k or nah?"\n  RIGHT: "what's your capital situation like right now?"\n  WRONG: "you serious about this or nah?"\n  RIGHT: "how serious are you about getting this dialed in?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] "or nah?" question tail detected — forcing regen with open-ended phrasing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Repeated-question hard block (audit fix 1, 2026-05-05). The
      // gate fired either `repeated_question_exact:` (one of five
      // exact phrases used twice) or `repeated_question:` (jaccard
      // ≥ 0.85 across questions). Force regen to advance on the lead's
      // prior answer rather than re-ask.
      const repeatedQuestionFailed = quality.hardFails.some(
        (f) =>
          f.includes('repeated_question_exact:') ||
          f.includes('repeated_question:')
      );
      if (repeatedQuestionFailed) {
        const directive = `\n\n===== REPEATED QUESTION — DO NOT RE-ASK =====\nYou already asked this exact question earlier in this conversation. The lead either answered it or sidestepped — RE-ASKING reads as the bot ignoring them. You MUST regenerate without asking the same question again.\n\nWhat to do on this regen:\n  • If the prior answer was clear, REFERENCE it and advance to the next script step.\n  • If the prior answer was ambiguous or off-topic, ask a DIFFERENT question that moves the script forward (different stage, different angle).\n  • If you genuinely need clarification on something they said, ask the clarifying question — do NOT just repeat the original question verbatim.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Repeated question detected — forcing regen to advance (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Fabricated uncertainty (audit fix 2, 2026-05-05). The AI
      // produced "give me a sec to double-check the right next step"
      // or similar — the AI always knows the next step (script-driven)
      // and uncertainty is never a valid reply.
      const fabricatedUncertaintyFailed = quality.hardFails.some((f) =>
        f.includes('fabricated_uncertainty:')
      );
      if (fabricatedUncertaintyFailed) {
        const directive = `\n\n===== FABRICATED UNCERTAINTY — PICK THE NEXT STEP =====\nYou produced a stalling phrase like "give me a sec to double-check" / "let me get back to you on that" / "not sure what to send" — the AI always knows the next script step. Uncertainty is NEVER a valid response.\n\nOn this regen, take the actual next action:\n  • If the lead just confirmed capital ≥ threshold, send the booking/Typeform link NOW.\n  • If the lead asked a question, answer it directly from persona / script context.\n  • If the script has a clear next stage, advance to it.\nDo NOT say "let me check" / "give me a sec" / "I need to verify". Decide and act.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Fabricated uncertainty detected — forcing regen to next script step (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Explicit soft-exit ignored (audit fix 4, 2026-05-05). Lead
      // said "for now I'll come back later" / "I appreciate you but…"
      // and the AI kept qualifying instead of closing warmly.
      const softExitIgnoredFailed = quality.hardFails.some((f) =>
        f.includes('explicit_soft_exit_ignored:')
      );
      if (softExitIgnoredFailed) {
        const directive = `\n\n===== EXPLICIT SOFT EXIT — CLOSE WARMLY =====\nThe lead just told you they're not ready right now — directly, in plain language. Continuing to qualify or push the call is harassment and produces a stuck conversation. On this regen, ship a SINGLE warm-close line and stop.\n\nFormat (one bubble, casual lowercase):\n  • acknowledge their decision genuinely\n  • leave the door open without pressure\n  • no question, no link, no pitch\n\nExamples:\n  • "respect bro, offer stands whenever you're ready 💪🏿"\n  • "all good bro, hit me up whenever the time's right"\n  • "got you bro, no rush — door's open whenever"\n\nDo NOT ask another qualifying question. Do NOT pitch the call. Do NOT re-enter discovery.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Explicit soft exit ignored — forcing regen to warm close (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Future commitment ignored (audit fix 5, 2026-05-05). Lead
      // said "in half a year I'll buy your mentorship" — recognize as
      // a WIN and close gracefully instead of trying to compress the
      // timeline.
      const futureCommitmentFailed = quality.hardFails.some((f) =>
        f.includes('future_commitment_ignored:')
      );
      if (futureCommitmentFailed) {
        const directive = `\n\n===== FUTURE COMMITMENT — APPRECIATE + CLOSE =====\nThe lead just made a future commitment ("in half a year I'll join", "when I'm ready I'll come back"). This is a WIN. Do NOT try to compress their timeline, do NOT re-engage qualification.\n\nOn this regen, ship a SINGLE appreciative line:\n  • Recognize the plan genuinely (not high-energy 🔥 — calm respect).\n  • Affirm their timeline.\n  • Leave the door open naturally.\n\nExample:\n  "respect bro, that's a solid plan honestly. when that half year hits and you're ready, just hit me up and we'll make it happen 💪🏿"\n\nDo NOT ask a question. Do NOT pitch a call. Do NOT compress the timeline.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Future commitment ignored — forcing regen to appreciative close (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Wrong register on cancellation (audit fix 7, 2026-05-05). Lead
      // reported a missed call / mixup; AI used 🔥 / "let's go". Force
      // regen to calm, apologetic, reschedule-focused tone.
      const wrongRegisterFailed = quality.hardFails.some((f) =>
        f.includes('wrong_register_on_cancellation:')
      );
      if (wrongRegisterFailed) {
        const directive = `\n\n===== WRONG REGISTER — MISSED CALL / RESCHEDULE =====\nThe lead just told you they missed the call / had a calendar mixup / weren't prepared. 🔥 / "let's go" / "lfg" / celebration energy is COMPLETELY WRONG here — it reads as celebrating their no-show. Switch to calm, understanding, solution-focused tone.\n\nOn this regen:\n  • Acknowledge calmly: "no worries bro, it happens" / "all good".\n  • DO NOT use 🔥, "let's go", "let's gooo", "lfg", "that's the energy", or similar high-energy phrases.\n  • Offer to reschedule with the booking link from your context if available.\n  • Tone: relaxed, understanding, low-pressure.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Wrong register on cancellation — forcing regen to calm tone (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Incomplete response directive (Brian Dycey 2026-04-27). The
      // gate fired the soft signal incomplete_response_no_followup
      // (no question, no URL, < 15 words, on a stage that needs
      // advancement). Score-only — pushes the reply under 0.7 — but
      // we layer a directive on the regen telling the LLM that an
      // acknowledgment alone stalls the conversation.
      const incompleteResponseFlagged =
        typeof quality.softSignals?.incomplete_response_no_followup ===
        'number';
      if (incompleteResponseFlagged) {
        const stageForDirective =
          parsed.stage || (leadContext.status as string | undefined) || 'this';
        const directive = `\n\n===== INCOMPLETE RESPONSE — NO FOLLOW-UP =====\nYour previous reply acknowledged the lead but didn't advance the conversation — no question, no URL drop, no next step. On a ${stageForDirective}-stage turn that stalls the conversation. The lead has nothing to respond to and is now waiting.\n\nOn this regen, your reply MUST include EXACTLY ONE of:\n  1. A specific qualifying question that moves to the next stage of the script (urgency, capital, timeline, motivation — whichever fits the stage).\n  2. A direct call-pitch / link drop (only if the script has reached that step).\nAcknowledgment phrases ("gotchu bro", "that makes sense", "bet bro", "love that") are FINE as the OPENER of the reply, but the reply cannot END on one. Append a forward-moving question on the same turn.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Incomplete response (no follow-up) detected — forcing regen with question requirement (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Ignored personal question directive (Omar Moore 2026-04-27).
      // Lead asked a personal question ("hbu", "what about you",
      // "what's your favorite prop") and the AI's reply has no
      // first-person content — clearest bot tell there is. Override
      // forces the LLM to answer first.
      const ignoredPersonalQ =
        typeof quality.softSignals?.ignored_personal_question === 'number';
      if (ignoredPersonalQ) {
        const leadMsg = lastLeadMsg?.content?.slice(0, 200) ?? '';
        const directive = `\n\n===== IGNORED PERSONAL QUESTION =====\nThe lead just asked YOU a personal question: "${leadMsg}". You ignored it and pivoted to your next script question — that's the clearest bot signal possible. A real human never does this.\n\nOn this regen, your reply MUST:\n  1. Answer the lead's personal question in 1-2 short sentences from your own configured persona's perspective. Use first-person language ("I've", "my", "I"). Be specific and real, not vague.\n  2. THEN ask your next question naturally.\nDo NOT open with the next script question. Do NOT deflect with phrases like "I stay away from the prop-firm weeds tbh" or "I don't really get into that" — those read as dodges. Give a real, brief answer.\n\nExamples:\n  Lead: "Hbu" → AI: "been at it for a few years bro, lost a lot before it actually clicked fr. what do you do for work rn?"\n  Lead: "what's your favorite prop firm?" → AI: "i go for the ones with clean rules and no surprise scaling — consistency over hype. you been happy with alpha so far?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Ignored personal question detected — forcing regen with first-person answer (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // R37 burst extension (Jefferson @namejeffe 2026-05-03).
      // Lead sent ≥ 2 consecutive messages — at least one a question or
      // reflective/emotional disclosure — and this turn's reply
      // addressed none of it. Override quotes the burst and forces the
      // LLM into the acknowledge-then-advance shape (one short ack
      // beat + one short forward question, no more).
      const burstIgnored = quality.hardFails.some((f) =>
        f.includes('r37_burst_ignored:')
      );
      if (burstIgnored) {
        const burst = getUnacknowledgedLeadBurst(conversationHistory);
        const closerNameLabel =
          (typeof promptConfigForGate?.callHandoff?.closerName === 'string' &&
            promptConfigForGate.callHandoff.closerName) ||
          personaForGate?.closerName ||
          'the call partner';
        const burstQuoted = burst.messages
          .map((m) => `  - "${m.content.slice(0, 200)}"`)
          .join('\n');
        const directive = `\n\n===== UNACKNOWLEDGED LEAD BURST =====\nThe lead just sent multiple messages in a row that your previous reply did not address. Their messages:\n\n${burstQuoted}\n\nRegenerate so your reply:\n  1. First acknowledges what they shared — emotionally if it's reflective ("damn bro that takes self awareness", "respect, that's real"), directly if it's a question.\n  2. THEN advances the script (one short follow-up question or pivot, no more).\n\nDo not paraphrase their messages back to them. Do not "answer" reflective questions literally — defer depth to ${closerNameLabel} on the call. Acknowledgment + advance, two beats max.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] R37 burst ignored — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1}). burstSize=${burst.messages.length} hasQ=${burst.hasQuestion} hasReflect=${burst.hasReflectiveContent}`
        );
        if (attempt === MAX_RETRIES) {
          console.error(
            `[ai-engine] R37 burst EXHAUSTED — shipping reply with burst-ignored hardFail still set (convo=${activeConversationId ?? 'unknown'}, burstSize=${burst.messages.length})`
          );
        }
      }

      // R37 acceptance-loopback extension. Strongest signal in the
      // burst family: lead said yes to an offer and the AI looped back
      // to a question instead of delivering. Override quotes the
      // acceptance and the prior promise, then forces a delivery turn.
      const acceptanceLoopback = quality.hardFails.some((f) =>
        f.includes('r37_acceptance_loopback:')
      );
      if (acceptanceLoopback) {
        const acceptanceQuote = (lastLeadMsg?.content ?? '')
          .trim()
          .slice(0, 80);
        const promiseQuote = (lastAiMsg?.content ?? '').trim().slice(0, 200);
        const directive = `\n\n===== ACCEPTANCE — DELIVER, DO NOT RE-ASK =====\nThe lead just explicitly accepted your prior offer:\n  Lead: "${acceptanceQuote}"\n  Your previous turn: "${promiseQuote}"\n\nA "yes / sure / sounds good / let's do it" after an offer is the strongest possible buying signal. Your job on this turn is ONLY to deliver — drop the link, the application URL, the booking flow, the resource — whatever you offered. Do NOT ask another qualifying question. Do NOT loop back to capital, timeline, goals, or any earlier stage. The lead said yes. Closing logic overrides script advancement entirely.\n\nIf the configured URL for what you promised is in the script's "Available Links & URLs" section above, paste it inline now. If no URL is listed, send the deterministic next step (e.g. "bet bro, sending the application now — fill it out and lmk once you're done") so the lead has something concrete to act on.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] R37 acceptance-loopback detected — forcing regen to deliver (attempt ${attempt + 1}/${MAX_RETRIES + 1}). acceptance="${acceptanceQuote}"`
        );
        if (attempt === MAX_RETRIES) {
          console.error(
            `[ai-engine] R37 acceptance-loopback EXHAUSTED — shipping reply that re-asks instead of delivering (convo=${activeConversationId ?? 'unknown'})`
          );
        }
      }

      // Scripted question sequence directive (Omar Moore 2026-04-27).
      // Three+ pure-question turns in a row with no specific
      // acknowledgment. Override tells the LLM to reference a
      // specific detail the lead shared before asking the next thing.
      const scriptedSequence =
        typeof quality.softSignals?.scripted_question_sequence === 'number';
      if (scriptedSequence) {
        const leadMsg = lastLeadMsg?.content?.slice(0, 300) ?? '';
        const directive = `\n\n===== SCRIPTED QUESTION SEQUENCE =====\nYou have asked multiple qualification questions in a row without acknowledging any of the specific details the lead shared. After 3 in a row this pattern becomes detectable as a script.\n\nOn this regen, your reply MUST reference at least ONE specific detail from the lead's last message: "${leadMsg}". That means:\n  • If they named a prop firm (Alpha, TopStep, Lucid, FTMO, Apex, etc.), use the name.\n  • If they named an instrument (ES, NQ, gold, EURUSD, etc.), reference it.\n  • If they named a strategy (AMD, ORB, ICT, SMC, FVG, supply/demand, etc.), reference it.\n  • If they shared a personal experience (blew an account, getting married, day job, faith, family), reference it.\n\nOnly THEN ask your next question. "love that bro" / "big moves" / "that's solid" alone DO NOT count — the gate also flags those as generic acknowledgments. The acknowledgment must include a specific token from what they said.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Scripted question sequence detected — forcing regen with specific-detail acknowledgment (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Generic acknowledgment directive (Omar Moore 2026-04-27).
      // The reply was JUST "love that bro" or similar with no follow-
      // up content. Tell the LLM the acknowledgment-only path is
      // banned and to either acknowledge specifically + ask, or skip
      // the empty filler and go straight to the next question.
      const genericAck =
        typeof quality.softSignals?.generic_acknowledgment === 'number';
      if (genericAck) {
        const directive = `\n\n===== GENERIC ACKNOWLEDGMENT ONLY =====\nYour reply is just an empty acknowledgment ("love that bro", "big moves", "that's solid", "bet bro") with no content after it. The lead has nothing to respond to.\n\nOn this regen, either:\n  • DROP the generic phrase and open with something specific to what they shared, OR\n  • Keep the acknowledgment but append a forward-moving question or a value drop on the same turn.\nGeneric praise alone never ships. A reply that's pure filler is a stall.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Generic acknowledgment-only detected — forcing regen with content (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // "real quick tho" banned-phrase directive. Hard-fail from the
      // BANNED_PHRASES list — the LLM keeps reaching for this as a
      // transition. Override tells it to find another bridge or just
      // ask the question without a transition phrase.
      const realQuickThoFailed = quality.hardFails.some((f) =>
        f.includes('"real quick tho"')
      );
      if (realQuickThoFailed) {
        const directive = `\n\n===== "REAL QUICK THO" BANNED =====\n"real quick tho" has become a bot tell — used before nearly every qualifying question. Banned. Find a different transition, or just ask the question directly.\nWRONG: "real quick tho, what's your capital situation?"\nRIGHT: "what's your capital situation like right now?"\nRIGHT: "yo bro one thing — what's your capital situation right now?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Banned "real quick tho" detected — forcing regen with different transition (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repeatedOpenerFailed = quality.hardFails.some((f) =>
        f.includes('repeated_opener:')
      );
      if (repeatedOpenerFailed) {
        const directive = `\n\n===== REPEATED OPENER =====\nYour last message started with the same opener. Vary your response — skip the acknowledgment entirely or use a completely different opening. Options: react directly to what they said, start with the question, use a different expression.\n\nDo NOT start this retry with gotchu, gotchu bro, facts, facts bro, bet bro, or makes sense bro if that opener appeared recently. Use a different expression like "damn bro", "that's real", "yo", "ahh", "nah fr tho", "that's actually", "bro", or no opener at all.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Repeated opener detected — forcing regen with varied opener (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repeatedStructureFailed = quality.hardFails.some((f) =>
        f.includes('repeated_message_structure:')
      );
      if (repeatedStructureFailed) {
        const directive = `\n\n===== REPEATED MESSAGE STRUCTURE =====\nYou used the same bubble structure three turns in a row. Vary the structure now.\n\nAllowed structures to rotate between:\nA) Single bubble — acknowledgment + question in one message\nB) Two bubbles — short reaction / question\nC) Two bubbles — longer empathy / question\nD) Single bubble — just the question, no acknowledgment\nE) Three bubbles — react / dig deeper / question\n\nIf the recent pattern was short reaction bubble + question bubble, use A, C, or D on this retry. Do not repeat the same shape again.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Repeated message structure detected — forcing regen with varied structure (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const transcribedVoiceNoteIgnoredFailed = quality.hardFails.some((f) =>
        f.includes('r29_transcribed_voice_note_ignored:')
      );
      if (transcribedVoiceNoteIgnoredFailed) {
        const directive = `\n\n===== R29 VOICE NOTE TRANSCRIPTION OVERRIDE =====\nThe lead sent a voice note and the system already transcribed it in the conversation context as [Voice note (transcribed): "..."]. You HAVE the content. Your previous reply acted like you could not hear it or asked the lead to type it out.\n\nRegenerate by responding directly to the transcript. Do NOT say "couldn't catch", "didn't catch", "type it out", "send a text", or "hard to hear". Treat the transcript exactly like a normal lead message.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Transcribed voice note ignored — forcing regen against transcript (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const logisticsRedeliveryFailed = quality.hardFails.some((f) =>
        f.includes('r30_logistics_redelivery:')
      );
      if (logisticsRedeliveryFailed) {
        const directive = `\n\n===== R30 CALL LOGISTICS ALREADY DELIVERED =====\nCall logistics (quiet spot, day, time, prep) have already been delivered in this conversation. Do NOT repeat them. The lead is past that point.\n\nGenerate a brief response, max 2 short bubbles, that moves the conversation forward without re-stating logistics. If there is nothing new to add, acknowledge briefly and close.\n\nExamples:\n  messages: ["bet 💪🏿 see you then"]\n  messages: ["🤝🏿 talk soon"]\n  messages: ["fire bro, you're set"]\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] R30 logistics redelivery detected — forcing regen without repeated logistics (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const logisticsAfterAckFailed = quality.hardFails.some((f) =>
        f.includes('r30_logistics_after_acknowledgment:')
      );
      if (logisticsAfterAckFailed) {
        const directive = `\n\n===== R30 LEAD ACKNOWLEDGED =====\nThe lead just acknowledged ("sounds good", "ok", "got it", etc.). Respond with a brief closer only: max 1 short bubble under 10 words, optional emoji.\n\nDo NOT add reminders, logistics, prep instructions, quiet-spot language, day/time confirmations, or call instructions.\n\nExamples:\n  messages: ["bet bro 💪🏿"]\n  messages: ["🤝🏿 see you then"]\n  messages: ["fire, you're set"]\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] R30 logistics after acknowledgment detected — forcing brief closer (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Image-limitation persona leak directive. If the model says
      // "can't see images" it breaks the human setter illusion. Force
      // the next attempt to answer like a normal person whose image
      // failed to load on their phone.
      const imageLimitationFailed = quality.hardFails.some((f) =>
        f.includes('image_limitation_exposed:')
      );
      if (imageLimitationFailed) {
        const imageLimitationOverride = `\n\n===== IMAGE PERSONA OVERRIDE =====\nDo not mention any inability to see images. Respond as a human whose image didn't load on their phone. Use natural wording like "yo the image isn't loading on my end, can you describe what you're seeing?" or "something's not coming through on my end bro, what was it?" Keep the human persona intact and keep the conversation moving.\n=====`;
        systemPromptForLLM = baseSystemPrompt + imageLimitationOverride;
        console.warn(
          `[ai-engine] Image limitation phrase detected — forcing regen with human image-load framing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Markdown-in-single-bubble directive (daetradez 2026-04-24).
      // The LLM emitted a numbered list with **bold** headers in one
      // big bubble instead of using the messages[] array to split
      // each point into its own short bubble. Natural regen without
      // this override tends to reproduce the same shape — the model
      // defaults to markdown on "how does X work" questions.
      const markdownFailed = quality.hardFails.some((f) =>
        f.includes('markdown_in_single_bubble:')
      );
      if (markdownFailed) {
        const markdownOverride = `\n\n===== NO MARKDOWN — USE MESSAGES ARRAY =====\nYour previous reply used markdown formatting (numbered list with **bold** headers, or multiple **bold** markers, or ## headers). Messaging apps do NOT render markdown — the lead literally sees "1. **Choose a program** — ..." with the asterisks. You MUST regenerate with NO markdown characters at all: no **, no ##, no numbered lists with bold headers, no bullet stars.\n\nInstead, split the content across separate bubbles via the messages[] array. Each bubble is its own short casual message — 1-2 sentences max, no markdown, no list formatting. Example:\n  messages: [\n    "funding convo's a whole other thing bro",\n    "not my lane to walk through prop firm rules — too much changes",\n    "the funded account flow we use gets broken down on the call with the closer"\n  ]\nKeep each bubble punchy, casual, lowercase. Natural texting cadence — not a numbered how-to guide. If the answer genuinely needs structure, use 2-4 short bubbles, never a formatted list in one message.\n=====`;
        systemPromptForLLM = baseSystemPrompt + markdownOverride;
        console.warn(
          `[ai-engine] Markdown-in-single-bubble detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const incomeGoalOverdueFailed = quality.hardFails.some((f) =>
        f.includes('income_goal_overdue:')
      );
      const typeformNoBookingWrongPathFailed = quality.hardFails.some((f) =>
        f.includes('typeform_filled_no_booking_wrong_path:')
      );
      if (typeformNoBookingWrongPathFailed) {
        const directive = `\n\n===== TYPEFORM FILLED BUT NO BOOKING SLOT =====\nThe lead filled the Typeform but did not book a time slot. This means they were not approved by the team screening. Do NOT ask what they need to complete the booking. Send the soft exit message and set stage to UNQUALIFIED:\n\n"${TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE}"\n\nNothing else. One message. Then stop.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Typeform filled without booking slot — forcing screened-out soft exit (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (incomeGoalOverdueFailed) {
        const incomeGoalOverride = `\n\n===== QUALIFICATION PACE OVERRIDE — INCOME GOAL =====\nYou have reached the income-goal deadline. Ask about the lead's income goal NOW. Do not ask another trading setup, chart, strategy, or "what's the main thing" discovery question first. Keep it natural and short, but the next reply must ask what they want to be making.\n=====`;
        systemPromptForLLM = baseSystemPrompt + incomeGoalOverride;
        console.warn(
          `[ai-engine] Income goal overdue — forcing regen with income-goal question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (qualificationStalledFailed) {
        const stalledOverride = `\n\n===== QUALIFICATION STALLED OVERRIDE =====\nYou have been in discovery / goal discussion for too long. Advance NOW to the next stage. Ask the urgency question: "${personaUrgencyQuestion}" Do not send more trading validation first.\n=====`;
        systemPromptForLLM = baseSystemPrompt + stalledOverride;
        console.warn(
          `[ai-engine] Qualification stalled — forcing urgency question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (capitalQuestionOverdueFailed) {
        const capitalOverdueOverride = `\n\n===== CAPITAL QUESTION OVERDUE =====\nYou must ask the capital question NOW regardless of the current topic: "real quick, what's your capital situation like for the markets right now?" Do not send validation, trading commentary, a call pitch, or any other qualification question first.\n=====`;
        systemPromptForLLM = baseSystemPrompt + capitalOverdueOverride;
        console.warn(
          `[ai-engine] Capital question overdue — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const callPitchBeforeCapitalFailed = quality.hardFails.some((f) =>
        f.includes('call_pitch_before_capital_verification:')
      );
      if (callPitchBeforeCapitalFailed) {
        const callBeforeCapitalOverride = `\n\n===== CALL PITCH BEFORE CAPITAL OVERRIDE =====\nYou have not asked the capital question yet. Do NOT propose the call. Ask first: "real quick, what's your capital situation like for the markets right now?" Do NOT pitch the call or mention scheduling on this turn.\n=====`;
        systemPromptForLLM = baseSystemPrompt + callBeforeCapitalOverride;
        console.warn(
          `[ai-engine] Call pitch before capital verification detected — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (silentBranchViolationFailed) {
        const labels = (currentStepShape?.silentBranchLabels || [])
          .map((l) => `"${l}"`)
          .join(', ');
        const silentBranchOverride = `\n\n===== SILENT BRANCH — ACKNOWLEDGMENT ONLY =====\nThe lead just shared something emotional and the script's current step has an acknowledgment-only branch (${labels || 'unnamed silent branch'}) — [MSG] + [WAIT], NO [ASK]. The operator's instruction on this branch is to SIT IN THE MOMENT — no follow-up question.\n\nFORBIDDEN ON THIS REGEN:\n  ✗ Any question mark (?)\n  ✗ Any "what about X" / "how does that feel" / "if that kept happening" follow-up probe\n  ✗ Pivoting to the next scripted question on the same turn\n\nREQUIRED ON THIS REGEN:\n  ✓ Acknowledge specifically what the lead just said using their own words. Make them feel deeply heard.\n  ✓ End on a statement (period). The lead will keep talking on their own.\n  ✓ Keep it short — one or two sentences max.\n=====`;
        systemPromptForLLM = baseSystemPrompt + silentBranchOverride;
        console.warn(
          `[ai-engine] Silent branch violated with question — forcing acknowledgment-only regen (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (missingRequiredQuestionFailed) {
        const missingQuestionOverride = `\n\n===== REQUIRED QUESTION MISSING =====\nYour reply must end with a question to advance the conversation. The current step requires you to ask the lead something. Add the required question from the script before sending.\n=====`;
        systemPromptForLLM = baseSystemPrompt + missingQuestionOverride;
        console.warn(
          `[ai-engine] Required question missing on [ASK] branch — forcing regen (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (multipleQuestionsFailed) {
        const multiQOverride = `\n\n===== MULTIPLE QUESTIONS — ONE ONLY =====\nYour previous draft contained more than one question mark. Send ONE question per turn — pick the most important one for the current script step and drop the rest. The script's [ASK] actions all contain exactly one question; mirror that shape.\n=====`;
        systemPromptForLLM = baseSystemPrompt + multiQOverride;
        console.warn(
          `[ai-engine] Multiple questions in reply — forcing single-question regen (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (step10DeepWhySkippedFailed) {
        const step10Override = buildStep10DeepWhyDirective(
          formatGoalForDeepWhyAsk(
            capturedPointRawValue(scriptStateSnapshot?.capturedDataPoints, [
              'incomeGoal',
              'income_goal'
            ]),
            lastLeadMsg?.content ?? null
          )
        );
        systemPromptForLLM = baseSystemPrompt + step10Override;
        console.warn(
          `[ai-engine] Step 10 (Deep Why) skip detected — forcing regen back to deep-why ask (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (capitalQuestionPrematureFailed) {
        const capPrereqHardFail = quality.hardFails.find((f) =>
          f.includes('capital_question_premature:')
        );
        const capDetail = capPrereqHardFail
          ? capPrereqHardFail
              .replace(/^capital_question_premature:\s*/i, '')
              .trim()
          : 'Required Step 18 prerequisites have not been captured yet.';
        const capQuestionOverride = `\n\n===== CAPITAL QUESTION FIRED PREMATURELY (STEP 18) =====\nCapital question is the script's Step 18 — it is the FINANCIAL DQ CHECK that fires AFTER the lead has already accepted the call proposal. It cannot fire during discovery.\n\n${capDetail}\n\nFORBIDDEN ON THIS REGEN:\n  ✗ "real quick, what's your capital situation"\n  ✗ "what's your capital like for the markets"\n  ✗ "how much do you have set aside"\n  ✗ "what budget can you put toward this"\n  ✗ ANY question about capital, budget, savings, or how much they have\n\nREQUIRED ON THIS REGEN:\n  ✓ Resume the script from the FIRST missing prerequisite (named in the diagnostic above).\n  ✓ Use the script's [ASK] content for that step verbatim.\n  ✓ Do NOT reference budget / capital / amount until the call is booked.\n=====`;
        systemPromptForLLM = baseSystemPrompt + capQuestionOverride;
        console.warn(
          `[ai-engine] Capital question premature — forcing regen back to script (attempt ${attempt + 1}/${MAX_RETRIES + 1}). detail="${capDetail.slice(0, 160)}"`
        );
      }

      if (msgVerbatimViolationFailed) {
        const activeRequiredMsg = activeBranchRequiredMessages?.find(
          (message) => message.content.trim().length > 0
        );
        const fallbackRequiredMsg =
          currentStepRequiredMessagesForGate[0]?.trim() || '';
        const requiredMsg = activeRequiredMsg?.content || fallbackRequiredMsg;
        const embeddedQuotes = activeRequiredMsg?.isPlaceholder
          ? (activeRequiredMsg.embeddedQuotes ?? [])
          : [];
        const requiredInstruction =
          activeRequiredMsg?.isPlaceholder && embeddedQuotes.length > 0
            ? `Acknowledge the lead in your own words. You MUST include ${
                embeddedQuotes.length === 1
                  ? 'this exact phrase'
                  : 'these exact phrases'
              }:\n${embeddedQuotes.map((quote) => `"${quote}"`).join('\n')}`
            : activeRequiredMsg?.isPlaceholder
              ? `Acknowledge the lead in your own words using this script directive:\n"${requiredMsg}"`
              : `You must open with this EXACT text:\n"${requiredMsg}"\n\nDo not paraphrase. Do not reorder. Copy it word for word. If this step contains more required [MSG] actions after pauses, send each required [MSG] as its own separate bubble in script order before the [ASK].`;
        const msgOverride = `\n\n===== REQUIRED SCRIPT MESSAGE NOT FOLLOWED =====\nYour reply does not match the required script message for the active branch.\n\n${requiredInstruction}\n=====`;
        systemPromptForLLM = baseSystemPrompt + msgOverride;
        console.warn(
          `[ai-engine] Required [MSG] verbatim violation — forcing regen (attempt ${attempt + 1}/${MAX_RETRIES + 1}). expected="${requiredMsg.slice(0, 120)}"`
        );
      }

      if (mandatoryAskSkippedFailed) {
        const askHardFail = quality.hardFails.find((f) =>
          f.includes('mandatory_ask_skipped:')
        );
        const askDetail = askHardFail
          ? askHardFail.replace(/^mandatory_ask_skipped:\s*/i, '').trim()
          : 'Required discovery [ASK]s have not fired in AI history.';
        const mandatoryAskOverride = `\n\n===== MANDATORY [ASK] SKIPPED — VOLUNTEERED DATA DOES NOT COMPLETE A STEP =====\nThe lead volunteered information that would normally be collected by a scripted [ASK]. Capturing volunteered data into capturedDataPoints is fine, but the scripted [ASK] question MUST still fire — step completion requires BOTH the question being asked AND the lead's answer to that specific question.\n\n${askDetail}\n\nFORBIDDEN ON THIS REGEN:\n  ✗ Advancing to Step 9+ content (income goal from trading, deep why, obstacle, belief break, capital, call proposal)\n  ✗ Treating "I work as a {job}" or similar volunteered phrases as a complete answer to Steps 6, 7, or 8\n  ✗ Inferring monthly income from job title alone\n  ✗ Skipping replace-vs-supplement just because the goal context "feels obvious"\n\nREQUIRED ON THIS REGEN:\n  ✓ Send the missing scripted [ASK] verbatim or near-verbatim — the lead has shared the data point but the question itself must be asked. The script captures the answer in TWO places: capturedDataPoints AND the conversation history.\n  ✓ Acknowledge what the lead volunteered first (one short line), THEN ask the missing scripted question. Example shape: "respect that bro, nurses do real work. {missing scripted [ASK]}".\n  ✓ One missing step at a time — fire the FIRST missing ask in script order, wait for the lead's reply, then advance.\n=====`;
        systemPromptForLLM = baseSystemPrompt + mandatoryAskOverride;
        console.warn(
          `[ai-engine] Mandatory ask skipped — forcing regen back to script (attempt ${attempt + 1}/${MAX_RETRIES + 1}). detail="${askDetail.slice(0, 200)}"`
        );
      }

      if (stepDistanceViolationFailed) {
        const distHardFail = quality.hardFails.find((f) =>
          f.includes('step_distance_violation:')
        );
        const distDetail = distHardFail
          ? distHardFail.replace(/^step_distance_violation:\s*/i, '').trim()
          : `Reply jumped multiple steps ahead of the AI's actual progress.`;
        const stepDistanceOverride = `\n\n===== SCRIPT STEP DISTANCE VIOLATION =====\nYou are improvising content that belongs to a script step several positions ahead of where the conversation actually is. The script must progress one step per turn — skipping ahead breaks the qualification flow and invalidates downstream gates.\n\n${distDetail}\n\nFORBIDDEN ON THIS REGEN:\n  ✗ Any phrasing that matches a step more than 3 ahead of the current step\n  ✗ Pattern-matching the lead's last reply to a later script stage and jumping there\n  ✗ Using captured early-stage signals (e.g. early_obstacle from Step 2) as license to skip Step 10/12/etc.\n\nREQUIRED ON THIS REGEN:\n  ✓ Send the [JUDGE]/[MSG]/[ASK] for the AI's CURRENT step (named in the directive).\n  ✓ One step per turn — wait for the lead's reply before advancing.\n  ✓ If the lead has volunteered information for a later step, store it via captured_data_points but DO NOT jump to that step in your reply.\n=====`;
        systemPromptForLLM = baseSystemPrompt + stepDistanceOverride;
        console.warn(
          `[ai-engine] Step-distance violation detected — forcing regen back to current step (attempt ${attempt + 1}/${MAX_RETRIES + 1}). detail="${distDetail.slice(0, 160)}"`
        );
      }

      if (callProposalPrereqsMissingFailed) {
        // Pull the gate's own diagnostic message — it lists every missing
        // prereq and names the first missing step. Pass it through to the
        // LLM verbatim so the regen knows exactly which step to resume on.
        const prereqHardFail = quality.hardFails.find((f) =>
          f.includes('call_proposal_prereqs_missing:')
        );
        const prereqDetail = prereqHardFail
          ? prereqHardFail
              .replace(/^call_proposal_prereqs_missing:\s*/i, '')
              .trim()
          : 'Required script prerequisites have not been captured yet.';
        const prereqOverride = `\n\n===== CALL PROPOSAL PREREQUISITES MISSING =====\nYou tried to propose the call before the script's qualification prerequisites were captured. ${prereqDetail}\n\nFORBIDDEN ON THIS REGEN:\n  ✗ Any call/chat/booking proposal language ("set up a call", "hop on a quick chat", "let me get you on with Anthony", "book the call", "Typeform", "booking link")\n  ✗ Pretending the script's earlier steps already happened\n\nREQUIRED:\n  ✓ Resume the script from the first missing step described above\n  ✓ Ask the question for that step (use the exact wording from the script's [ASK] action when one is defined)\n  ✓ Do NOT skip ahead — even if the lead's last reply "feels ready", the missing data points are non-negotiable for a productive call\n=====`;
        systemPromptForLLM = baseSystemPrompt + prereqOverride;
        console.warn(
          `[ai-engine] Call proposal prereqs missing — forcing regen back to script (attempt ${attempt + 1}/${MAX_RETRIES + 1}). detail="${prereqDetail.slice(0, 160)}"`
        );
      }

      if (longTimelineCallPitchFailed) {
        const timelineProbeOverride = `\n\n===== LONG TIMELINE BEFORE CALL PITCH =====\nThe lead just gave a 2+ year timeline. That is a soft disqualifier unless you learn WHY it is that far out. Do NOT pitch the call yet. Do NOT mention the closer. Ask exactly one probe first: "what's holding it to 2-3 years, is it more the capital side or just want to learn first?"\n\nIf their answer confirms capital is the blocker, route to the downsell / free-resource soft exit. If their answer shows urgency can be compressed and capital is available, then continue toward the call later.\n=====`;
        systemPromptForLLM = baseSystemPrompt + timelineProbeOverride;
        console.warn(
          `[ai-engine] Long timeline call pitch detected — forcing blocker probe (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const closerOrCallInDownsellFailed = quality.hardFails.some((f) =>
        f.includes('closer_or_call_in_downsell:')
      );
      if (closerOrCallInDownsellFailed) {
        const downsellCallOverride = `\n\n===== NO CLOSER / NO CALL IN DOWNSELL =====\nThis lead is UNQUALIFIED for the main mentorship. The downsell is a SELF-SERVE COURSE — flat one-time price, no call, no closer. The previous reply mentioned the closer / a call / "pricing covered on the call" — that's wrong here.\n\nIf the lead asked about price, state the downsell course price directly from the script (e.g. "it's a one-time ${downsellPriceWithSign} bro, you get the full course"). If the persona has no downsell configured, route to the YouTube free-resource fallback per the script — no pricing discussion.\n\nDO NOT name-check the closer. DO NOT mention any call. DO NOT defer pricing to "the call". DO NOT pitch booking or scheduling. The qualification flow is over for this lead.\n=====`;
        systemPromptForLLM = baseSystemPrompt + downsellCallOverride;
        console.warn(
          `[ai-engine] Closer/call mention in downsell context — forcing regen with downsell-only override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // R40 (@shepherdgushe.zw 2026-05-05). Lead confirmed downsell
      // acceptance (downsellInterestConfirmed=true) AND is below the
      // capital threshold (capitalThresholdMet=false). The previous
      // draft pitched the call instead of delivering the course URL.
      // Force regen to drop the link.
      const r40DownsellAcceptCallFailed = quality.hardFails.some((f) =>
        f.includes('r40_call_pitch_to_unqualified_after_downsell_accept:')
      );
      if (r40DownsellAcceptCallFailed) {
        const r40CloserLabel = (
          personaForGate?.closerName || 'the closer'
        ).trim();
        const r40Override = `\n\n===== R40 — DELIVER COURSE URL, DO NOT PITCH CALL =====\nThis lead is BELOW the capital threshold AND has affirmed downsell interest. The next reply MUST deliver the ${downsellPriceWithSign} ${downsellProductName} URL from the script's "Available Links & URLs" section. Drop the link.\n\nThe call CTA is reserved for QUALIFIED leads only. Pitching a call here loops an unqualified lead back into the main-mentorship sales path they have already been disqualified from.\n\nFORBIDDEN ON THIS REGEN:\n  ✗ "hop on a quick call"\n  ✗ "jump on a call"\n  ✗ "right hand man ${r40CloserLabel}"\n  ✗ "${r40CloserLabel} so they can break it down"\n  ✗ "wanna get on a chat"\n  ✗ ANY closer name + ANY call/chat/quick mention\n\nREQUIRED ON THIS REGEN:\n  ✓ Brief acknowledgment of their acceptance (one short line, e.g. "bet bro, that's the move").\n  ✓ The downsell URL inline (the actual link from the script — never a placeholder).\n  ✓ Optional warm sign-off ("take your time with it, hit me up when you're done").\n\nIf no downsell URL is configured, soft-exit with the free-resource fallback (per R28). Do NOT substitute a call CTA.\n=====`;
        systemPromptForLLM = baseSystemPrompt + r40Override;
        console.warn(
          `[ai-engine] R40 violation — call pitched to unqualified lead after downsell accept; forcing regen to URL delivery (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const r40MissingUrlFailed = quality.hardFails.some((f) =>
        f.includes('r40_downsell_accepted_missing_url:')
      );
      if (r40MissingUrlFailed) {
        const r40UrlOverride = `\n\n===== R40 — DELIVER COURSE URL NOW =====\nThe lead confirmed downsell interest but your reply contained no URL. The ONLY valid next action is to deliver the ${downsellPriceWithSign} ${downsellProductName} link from the "Available Links & URLs" section in this system prompt.\n\nFormat: brief acknowledgment (one short line) + the URL inline. Nothing else.\n\nIf no URL is configured in the script, use the free-resource fallback (per R28). DO NOT ask what timezone they are in. DO NOT ask scheduling questions. DO NOT defer the link to a later message.\n=====`;
        systemPromptForLLM = baseSystemPrompt + r40UrlOverride;
        console.warn(
          `[ai-engine] R40 violation — downsell accepted but no URL in reply; forcing regen to URL delivery (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repetitiveQuestionFailed =
        quality.softSignals.repetitive_question_pattern !== undefined;
      if (repetitiveQuestionFailed) {
        const repetitiveQuestionOverride = `\n\n===== REPETITIVE QUESTION PATTERN OVERRIDE =====\nYour last 3 questions were too similar. Ask something genuinely different or advance to the next script step instead of asking another variation of the same question.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repetitiveQuestionOverride;
        console.warn(
          `[ai-engine] Repetitive question pattern detected — forcing regen with script advancement (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repeatedEmailFailed =
        quality.softSignals.repeated_email_request !== undefined;
      if (repeatedEmailFailed) {
        const repeatedEmailOverride = `\n\n===== REPEATED EMAIL REQUEST OVERRIDE =====\nLead email is already collected: ${leadContext.booking?.leadEmail}. Do not ask for their email again. Continue the booking/script step using the email already in context.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedEmailOverride;
        console.warn(
          `[ai-engine] Repeated email request detected — forcing regen without asking email again (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const fabricatedImageObservationFailed = quality.hardFails.some((f) =>
        f.includes('fabricated_image_observation:')
      );
      if (fabricatedImageObservationFailed) {
        const imageObservationOverride = `\n\n===== IMAGE OBSERVATION FABRICATION OVERRIDE =====\nDo not claim you saw, noticed, checked, or looked at stats, flow, numbers, or chart details from the image. Respond as a human whose image didn't load clearly on their phone, then ask the lead to describe what they sent or what they want you to look at.\n=====`;
        systemPromptForLLM = baseSystemPrompt + imageObservationOverride;
        console.warn(
          `[ai-engine] Fabricated image observation detected — forcing regen with image-not-loading framing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      if (manyChatEarlyCapitalFailed) {
        const manyChatOverride = `\n\n===== MANYCHAT OUTBOUND CONTINUATION OVERRIDE =====\nThis lead came from a ManyChat outbound sequence. Discovery has not happened yet. Do NOT ask about capital. Ask about their trading background instead.\n\nThe outbound hook/content was about ${downsellProductName}. The lead accepting or asking for that content is NOT soft-pitch acceptance - it is opening engagement.\n\nFollow this stage order: discovery -> goal -> urgency -> soft pitch -> capital.\n\nNatural bridge: since they expressed interest in ${downsellProductName}, open with a question that connects that interest to their current situation. Ask about trading background, experience, or how long they have been trading. Do not pitch the call, send booking/application language, or ask any capital/budget question on this turn.\n=====`;
        systemPromptForLLM = baseSystemPrompt + manyChatOverride;
        console.warn(
          `[ai-engine] ManyChat early capital question detected - forcing discovery continuation (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }
    }

    if (repeatedQuestionFailed) {
      const repeatedQuestionOverride = `\n\n===== REPEATED QUESTION OVERRIDE =====\nYour previous reply repeated a question already asked in this conversation. The lead answered or gave new context, so asking the same thing again reads like a loop. Regenerate without repeating that question. Acknowledge the lead's latest answer specifically, then either ask a different clarifying question or move to the correct next step.\n=====`;
      systemPromptForLLM += repeatedQuestionOverride;
      console.warn(
        `[ai-engine] Repeated question detected — forcing regen with no-repeat directive (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (homeworkBeforeCallFailed) {
      const homeworkOverride = `\n\n===== PRE-CALL HOMEWORK BLOCKED =====\nDo NOT send the homework link yet. The lead has not confirmed a specific day and time for their call in the system. The homework link is only sent as call preparation after scheduledCallAt is set, not during the booking flow. Regenerate without the homework URL and keep the lead moving toward confirming the call time.\n=====`;
      systemPromptForLLM += homeworkOverride;
      console.warn(
        `[ai-engine] Homework link before scheduledCallAt detected — forcing regen without homework URL (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (prematureExitOnSoftHesitationFailed) {
      const softHesitationOverride = `\n\n===== SOFT HESITATION OBJECTION OVERRIDE =====\nThe lead expressed hesitation, not a hard refusal. Do NOT soft exit. Do NOT send the YouTube/free-resource link. Do NOT say "when you're in a better spot." Ask what their specific concern is and keep the conversation open. Example: "i hear you bro, what's the main concern, is it the amount or just not wanting to put it toward this right now?"\n=====`;
      systemPromptForLLM += softHesitationOverride;
      console.warn(
        `[ai-engine] Premature exit on soft hesitation detected — forcing objection probe (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (validationLoopFailed) {
      const validationLoopOverride = `\n\n===== VALIDATION LOOP OVERRIDE =====\nYou have sent 3+ validation messages in a row without advancing. Stop validating and ask a qualification question NOW. Move to the next script stage. If you are still in Goal/Why, ask: "${personaUrgencyQuestion}"\n=====`;
      systemPromptForLLM += validationLoopOverride;
      console.warn(
        `[ai-engine] Validation loop detected — forcing qualification advancement (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (overusedValidationPhraseFailed) {
      const overusedValidationOverride = `\n\n===== OVERUSED VALIDATION PHRASE =====\n"facts bro" and "yeah bro" are allowed at most 2 times per conversation. You used one again. Regenerate without that phrase and ask the next qualification question instead of sending another validation line.\n=====`;
      systemPromptForLLM += overusedValidationOverride;
      console.warn(
        `[ai-engine] Overused validation phrase detected — forcing alternate phrasing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (attempt === MAX_RETRIES) {
      if (r24Blocked) {
        console.error(
          `[ai-engine] R24 gate EXHAUSTED ${MAX_RETRIES + 1} attempts — replacing unsafe final reply with deterministic R24-safe fallback on convo ${activeConversationId}`
        );
        // Final attempt still blocked. Never ship the unsafe booking
        // pitch the LLM produced. Replace it with a deterministic safe
        // capital/downsell/clarifier message so the lead never sees
        // "hop on a call" after failing R24.
        const r24Fallback = buildR24BlockedFallbackMessage(
          r24LastResult.reason,
          capitalThreshold!,
          r24LastResult
        );
        const fallbackQuality = scoreVoiceQualityGroup(
          [r24Fallback.message],
          buildVoiceQualityOptions(
            1,
            r24LastResult.reason === 'answer_below_threshold'
              ? 'failed'
              : undefined
          )
        );
        if (fallbackQuality.passed) {
          parsed.message = r24Fallback.message;
          parsed.messages = [r24Fallback.message];
          parsed.stage = r24Fallback.stage;
          parsed.subStage = r24Fallback.subStage;
          parsed.softExit = false;
          parsed.escalateToHuman = false;
          parsed.voiceNoteAction = null;
          finalQualityScore = fallbackQuality.score;
        } else {
          console.warn(
            `[ai-engine] R24 deterministic fallback failed voice gate for convo ${activeConversationId}: ${fallbackQuality.hardFails.join(', ') || 'score'} — generating fresh natural R24 reply`
          );
          const naturalR24Prompt =
            baseSystemPrompt +
            (lastR24Override ||
              `\n\n===== CRITICAL R24 OVERRIDE =====\nThe lead has not passed capital verification. Do NOT route to booking. Follow the correct R24 branch naturally.\n=====`) +
            `\n\n===== R24 FALLBACK VOICE REGEN =====\nThe canned fallback failed the voice-quality gate. Generate ONE fresh, natural text message that follows the R24 override above. Do not use em dashes, en dashes, semicolons, corporate phrasing, or canned template language. Do not pitch a call or send the Typeform. Keep it short and human.\n=====`;
          const naturalCall = await callLLM(
            provider,
            apiKey,
            model,
            naturalR24Prompt,
            messages,
            fallback
          );
          modelUsedFinal = naturalCall.modelUsed;
          usageTotal = addUsage(usageTotal, naturalCall.usage);
          qualityGateAttempts++;

          let naturalParsed: ParsedAIResponse;
          try {
            naturalParsed = parseAIResponse(naturalCall.text);
          } catch (err) {
            if (err instanceof InvalidLLMOutputError) {
              await recordR34MetadataLeakCatch({
                accountId,
                conversationId: activeConversationId,
                attempt: qualityGateAttempts,
                matchedText: err.found ?? err.code,
                matchedPattern: err.code,
                replyPreview: naturalCall.text.slice(0, 500),
                stage: parsed.stage || null,
                leadMessage: lastLeadMsg?.content ?? null
              });
              naturalParsed = buildR34BlockedFallbackParsed();
            } else {
              throw err;
            }
          }
          const naturalLeak = detectMetadataLeak(
            naturalParsed.messages.join('\n')
          );
          if (naturalParsed.parserMetadataLeak || naturalLeak.leak) {
            await recordR34MetadataLeakCatch({
              accountId,
              conversationId: activeConversationId,
              attempt: qualityGateAttempts,
              matchedText:
                naturalParsed.parserMetadataLeak?.matchedText ??
                naturalLeak.matchedText,
              matchedPattern:
                naturalParsed.parserMetadataLeak?.matchedPattern ??
                naturalLeak.matchedPattern,
              replyPreview: naturalParsed.messages.join('\n').slice(0, 500),
              stage: naturalParsed.stage || null,
              leadMessage: lastLeadMsg?.content ?? null
            });
            const strippedNatural = stripMetadataLeaksFromMessages(
              naturalParsed.messages
            );
            if (strippedNatural.success) {
              naturalParsed = {
                ...naturalParsed,
                message: strippedNatural.messages[0] ?? '',
                messages: strippedNatural.messages,
                parserMetadataLeak: null
              };
            } else {
              naturalParsed = buildR34BlockedFallbackParsed();
            }
          }
          const naturalQuality = scoreVoiceQualityGroup(
            naturalParsed.messages,
            buildVoiceQualityOptions(
              naturalParsed.messages?.length || 1,
              r24LastResult.reason === 'answer_below_threshold'
                ? 'failed'
                : undefined
            )
          );
          const naturalStillRoutesToBooking =
            isRoutingToBookingHandoff(naturalParsed);
          if (naturalQuality.passed && !naturalStillRoutesToBooking) {
            parsed = naturalParsed;
            finalQualityScore = naturalQuality.score;
          } else {
            console.error(
              `[ai-engine] R24 natural fallback failed voice/safety gate for convo ${activeConversationId}: hardFails=${naturalQuality.hardFails.join(', ') || 'none'} bookingRoute=${naturalStillRoutesToBooking}`
            );

            // ── Outbound-aware soft recovery ────────────────────────
            // For ManyChat / OUTBOUND conversations in their first few
            // turns, the R24 fallback is almost always a false positive:
            // the lead's reply to the cold opener is short ("Yea",
            // "yes please send it", "ok"), the AI has limited context,
            // and the booking-route gate flags an over-eager next step.
            // Hard-escalating (escalateToHuman=true → aiActive flips
            // false downstream) ghosts the lead the moment they show
            // intent — exactly the wrong UX for cold outbound where
            // a quick acknowledgment + discovery beat keeps the
            // conversation breathing. Multi-tenant policy: when the
            // conversation is OUTBOUND-sourced AND we're still in the
            // early phase (< 6 messages, including the opener), ship
            // a minimal acknowledgment and KEEP aiActive=true. The
            // operator still sees the audit trail via the diagnostic
            // log above, but the lead doesn't get cold-paused on a
            // hair-trigger gate. Non-outbound flows keep the existing
            // hard-escalate — those cases (deep qualification, R24
            // hitting after several turns) genuinely need operator
            // review.
            // R24 soft-recovery is only appropriate while ManyChat
            // outbound is actively in play. After 2 hours, the
            // outbound classification is stale — defer to the normal
            // escalation path. (Same recency gate as the
            // outbound_context block + cold-start logic.)
            const isOutboundSourced = isManyChatRecentlyActive(
              conversationCallState?.source,
              conversationCallState?.manyChatFiredAt
            );
            const isEarlyTurn = conversationHistory.length < 6;
            if (isOutboundSourced && isEarlyTurn) {
              parsed.message =
                "appreciate that bro 🙏🏿 quick q so i don't waste your time — what made you wanna check this out fr?";
              parsed.messages = [parsed.message];
              parsed.stage = 'DISCOVERY';
              parsed.subStage = null;
              parsed.softExit = false;
              parsed.escalateToHuman = false;
              parsed.voiceNoteAction = null;
              finalQualityScore = Math.max(naturalQuality.score, 60);
              console.log(
                `[ai-engine] R24 soft-recovery applied for OUTBOUND convo ${activeConversationId} (msgCount=${conversationHistory.length}) — aiActive preserved.`
              );
            } else {
              parsed.message =
                "i don't wanna point you wrong here bro. give me a sec to double-check the right next step.";
              parsed.messages = [parsed.message];
              parsed.stage = 'SOFT_EXIT';
              parsed.subStage = null;
              parsed.softExit = false;
              parsed.escalateToHuman = true;
              parsed.voiceNoteAction = null;
              finalQualityScore = naturalQuality.score;
            }
          }
        }
      } else if (restrictedFundingBlocked) {
        console.error(
          `[ai-engine] Funding-partner geography gate EXHAUSTED ${MAX_RETRIES + 1} attempts — replacing unsafe funding pitch with human handoff for convo ${activeConversationId}`
        );
        parsed.message =
          "i don't wanna point you into the wrong route here bro. lemme have the team double-check the right next step for where you're based.";
        parsed.messages = [parsed.message];
        parsed.stage = 'SOFT_EXIT';
        parsed.softExit = false;
        parsed.escalateToHuman = true;
      } else if (fixBBlocked || fabricationBlocked) {
        // Fix B / booking-fabrication exhaustion — soft-fail policy
        // (2026-04-20 policy change). Shipping d2a03e8's hard-escalate
        // created too many cold pauses on conversations where the LLM
        // was being overly cautious or where the gate pattern tripped
        // on legitimate content. New behavior: ship the last
        // best-effort response AS-IS, keep aiActive=true, log an
        // audit row with a dedicated reason. The dashboard Action
        // Required surfaces the row as an amber "unverified_sent"
        // item so the operator reviews during their daily check
        // without the lead getting ghosted mid-conversation.
        //
        // R24 (pre-Fix-A/B behavior) and distress detection retain
        // their hard-escalation behavior — they catch stricter
        // classes of failure (capital-below-threshold booking
        // attempts, suicidal language) where silent best-effort is
        // not acceptable.
        const which = fixBBlocked ? 'Fix B' : 'booking fabrication';
        console.warn(
          `[ai-engine] ${which} gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort (no escalate), logging audit row for dashboard review`
        );
        try {
          await prisma.bookingRoutingAudit.create({
            data: {
              conversationId: activeConversationId!,
              accountId,
              personaMinimumCapital: capitalThreshold,
              routingAllowed: false,
              regenerationForced: true,
              blockReason: 'gate_exhausted_sent_best_effort',
              aiStageReported: parsed.stage || null,
              aiSubStageReported: parsed.subStage || null,
              contentPreview: parsed.message.slice(0, 200)
            }
          });
        } catch (auditErr) {
          console.error(
            '[ai-engine] gate_exhausted_sent_best_effort audit write failed (non-fatal):',
            auditErr
          );
        }
      } else if (
        unnecessarySchedulingQuestionFailed ||
        logisticsBeforeQualificationFailed ||
        repeatedQuestionFailed
      ) {
        // Loosened 2026-04-30 (was hard escalate_to_human). The
        // "AI asked a slightly off follow-up question" class — these
        // gates produce conversational drift, not lead-facing harm,
        // so paying for a human pause + manual unblock is more
        // expensive than letting ops audit later. Same pattern as
        // the existing fixB / booking-fabrication soft-fail policy
        // (~line 1541): write a bookingRoutingAudit row with
        // blockReason='gate_exhausted_sent_best_effort' so the
        // dashboard surfaces an amber Action Required item, ship
        // the LLM's last best-effort reply as-is, AI stays active.
        const gateType = unnecessarySchedulingQuestionFailed
          ? 'scheduling_q'
          : logisticsBeforeQualificationFailed
            ? 'logistics_before_qualification'
            : 'repeated_question';
        console.warn(
          `[ai-engine] ${gateType} gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort (no escalate), logging audit row for dashboard review on convo ${activeConversationId}`
        );
        try {
          await prisma.bookingRoutingAudit.create({
            data: {
              conversationId: activeConversationId!,
              accountId,
              personaMinimumCapital: capitalThreshold,
              routingAllowed: false,
              regenerationForced: true,
              blockReason: 'gate_exhausted_sent_best_effort',
              aiStageReported: parsed.stage || null,
              aiSubStageReported: `gate=${gateType}${parsed.subStage ? '|' + parsed.subStage : ''}`,
              contentPreview: parsed.message.slice(0, 200)
            }
          });
        } catch (auditErr) {
          console.error(
            `[ai-engine] gate_exhausted_sent_best_effort audit write failed (gate=${gateType}, non-fatal):`,
            auditErr
          );
        }
      } else if (homeworkBeforeCallFailed) {
        console.warn(
          `[ai-engine] Homework-before-call gate exhausted ${MAX_RETRIES + 1} attempts — stripping homework URL before send for convo ${activeConversationId}`
        );
        parsed.messages = stripPreCallHomeworkFromMessages(
          parsed.messages,
          homeworkUrl
        );
        parsed.message = parsed.messages[0] || '';
      } else if (prematureExitOnSoftHesitationFailed) {
        console.warn(
          `[ai-engine] Soft-hesitation exit gate exhausted ${MAX_RETRIES + 1} attempts — replacing soft exit with objection probe for convo ${activeConversationId}`
        );
        parsed.message =
          "i hear you bro, what's the main concern, is it the amount or just not wanting to put it toward this right now?";
        parsed.messages = [parsed.message];
        parsed.stage = parsed.stage || 'FINANCIAL_SCREENING';
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (longTimelineCallPitchFailed) {
        console.warn(
          `[ai-engine] Long-timeline call-pitch gate exhausted ${MAX_RETRIES + 1} attempts — replacing with timeline blocker probe for convo ${activeConversationId}`
        );
        parsed.message =
          "what's holding it to 2-3 years, is it more the capital side or just want to learn first?";
        parsed.messages = [parsed.message];
        parsed.stage = 'URGENCY';
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (
        quality.hardFails.some((f) =>
          f.includes('typeform_filled_no_booking_wrong_path:')
        )
      ) {
        console.warn(
          `[ai-engine] Typeform-no-booking gate exhausted ${MAX_RETRIES + 1} attempts — replacing with screened-out soft exit for convo ${activeConversationId}`
        );
        parsed.message = TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE;
        parsed.messages = [TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE];
        parsed.stage = 'UNQUALIFIED';
        parsed.subStage = 'TYPEFORM_NO_BOOKING';
        parsed.softExit = true;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (manyChatEarlyCapitalFailed) {
        console.warn(
          `[ai-engine] ManyChat early-capital gate exhausted ${MAX_RETRIES + 1} attempts - replacing with discovery question for convo ${activeConversationId}`
        );
        parsed.message = `sick, since you wanted the ${downsellProductName}, what's your trading background right now, been at it for a while or pretty new?`;
        parsed.messages = [parsed.message];
        parsed.stage = 'DISCOVERY';
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (capitalQuestionOverdueFailed) {
        console.warn(
          `[ai-engine] Capital-question-overdue gate exhausted ${MAX_RETRIES + 1} attempts — replacing with capital question for convo ${activeConversationId}`
        );
        parsed.message =
          "real quick, what's your capital situation like for the markets right now?";
        parsed.messages = [parsed.message];
        parsed.stage = 'FINANCIAL_SCREENING';
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (qualificationStalledFailed || validationLoopFailed) {
        console.warn(
          `[ai-engine] Qualification-stall/validation-loop gate exhausted ${MAX_RETRIES + 1} attempts — replacing with urgency question for convo ${activeConversationId}`
        );
        // Use the persona-resolved urgency question. NEVER fall back to
        // the retired daetradez phrasing — that wording is gone from
        // production code and only lives in a tenant's own script if
        // they choose to keep it.
        parsed.message = personaUrgencyQuestion;
        parsed.messages = [parsed.message];
        parsed.stage = 'URGENCY';
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (overusedValidationPhraseFailed) {
        console.warn(
          `[ai-engine] Overused-validation-phrase gate exhausted ${MAX_RETRIES + 1} attempts — stripping repeated phrase before send for convo ${activeConversationId}`
        );
        parsed.messages = (parsed.messages || [])
          .map((m) => m.replace(/\b(facts bro|yeah bro),?\s*/gi, '').trim())
          .filter(Boolean);
        if (
          parsed.messages.length === 0 ||
          !parsed.messages.join(' ').includes('?')
        ) {
          // Same persona-resolved fallback — no hardcoded daetradez line.
          parsed.message = personaUrgencyQuestion;
          parsed.messages = [parsed.message];
          parsed.stage = 'URGENCY';
        } else {
          parsed.message = parsed.messages[0];
        }
        parsed.subStage = null;
        parsed.softExit = false;
        parsed.escalateToHuman = false;
        parsed.voiceNoteAction = null;
      } else if (!quality.passed) {
        // Voice quality gate exhausted. Most voice-quality failures are
        // "soft" — low score from missing emoji, one long sentence,
        // minor voice drift. Best-effort ship for those is fine.
        //
        // The "unshippable" classes split (2026-04-30):
        //
        // HARD-ESCALATE (parsed.escalateToHuman=true) — output that
        // objectively breaks the lead-facing message regardless of
        // surrounding text. Better to pause + human-review than ship.
        //   - bracketed_placeholder_leaked: literal "[BOOKING LINK]"
        //     reaches the lead, who can't click it — Steven Petty
        //     2026-04-20 incident.
        //   - link_promise_without_url: "I'll send you the link" with
        //     no URL anywhere — the ship has nothing to deliver.
        //   - call_pitch_before_capital_verification: pitching the
        //     call without verifying capital is a hard R24 violation.
        //
        // SOFT-FAIL BEST-EFFORT (audit row only) — bad form but the
        // lead can still parse the intent. Cheaper to ship + audit
        // than pause.
        //   - markdown_in_single_bubble: literal **bold** in the
        //     message — readable, just ugly.
        //   - repeated_capital_question: redundant ask, lead may
        //     re-explain instead of getting paused.
        //
        // EMPTY OUTPUT also escalates — there's nothing to ship.
        const allBubblesEmpty =
          !Array.isArray(parsed.messages) ||
          parsed.messages.length === 0 ||
          parsed.messages.every(
            (b) => typeof b !== 'string' || b.trim().length === 0
          );
        const hardUnshippable = quality.hardFails.some(
          (f) =>
            f.includes('bracketed_placeholder_leaked:') ||
            f.includes('link_promise_without_url:') ||
            f.includes('fabricated_url_in_reply:') ||
            f.includes('call_pitch_before_capital_verification:') ||
            f.includes('closer_or_call_in_downsell:') ||
            // Step-progression gates (2026-05-08): when the LLM keeps
            // emitting future-step content despite 3 regen attempts,
            // shipping best-effort would deliver a script-violating
            // reply. Escalate to operator instead so they manually
            // continue the conversation from the right step.
            f.includes('capital_question_premature:') ||
            f.includes('msg_verbatim_violation:') ||
            f.includes('mandatory_ask_skipped:') ||
            f.includes('step_distance_violation:') ||
            f.includes('step_10_deep_why_skipped:') ||
            f.includes('call_proposal_prereqs_missing:') ||
            f.includes('silent_branch_violated_with_question:') ||
            f.includes('missing_required_question_on_ask_step:')
        );
        const softUnshippable = quality.hardFails.find(
          (f) =>
            f.includes('markdown_in_single_bubble:') ||
            f.includes('repeated_capital_question:')
        );
        if (allBubblesEmpty) {
          console.error(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts AND final output is empty — forcing escalate_to_human on convo ${activeConversationId}`
          );
          parsed.escalateToHuman = true;
          qualityGateTerminalFailure = true;
          qualityGateFailureReason = 'empty_output_after_quality_retries';
          qualityGateHardFails = [...quality.hardFails];
        } else if (hardUnshippable) {
          console.error(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts with UNSHIPPABLE hard fail — forcing escalate_to_human on convo ${activeConversationId}. hardFails=${JSON.stringify(quality.hardFails)}`
          );
          parsed.escalateToHuman = true;
          qualityGateTerminalFailure = true;
          qualityGateFailureReason = 'hard_unshippable_after_quality_retries';
          qualityGateHardFails = [...quality.hardFails];
        } else if (softUnshippable) {
          // Soft-fail best-effort (markdown / repeated capital Q).
          // Audit row → amber Action Required item; AI stays active.
          const gateType = softUnshippable.includes(
            'markdown_in_single_bubble:'
          )
            ? 'markdown'
            : 'repeated_capital_question';
          console.warn(
            `[ai-engine] ${gateType} gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort (no escalate), logging audit row for dashboard review on convo ${activeConversationId}`
          );
          if (activeConversationId) {
            try {
              await prisma.bookingRoutingAudit.create({
                data: {
                  conversationId: activeConversationId,
                  accountId,
                  personaMinimumCapital: capitalThreshold,
                  routingAllowed: false,
                  regenerationForced: true,
                  blockReason: 'gate_exhausted_sent_best_effort',
                  aiStageReported: parsed.stage || null,
                  aiSubStageReported: `gate=${gateType}${parsed.subStage ? '|' + parsed.subStage : ''}`,
                  contentPreview: parsed.message.slice(0, 200)
                }
              });
            } catch (auditErr) {
              console.error(
                `[ai-engine] gate_exhausted_sent_best_effort audit write failed (gate=${gateType}, non-fatal):`,
                auditErr
              );
            }
          }
        } else {
          console.warn(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort`
          );
        }
      }

      // ── Guaranteed-fallback safety (Steven Biggam 2026-04-30) ───
      // If we reached MAX_RETRIES AND the final output is escalating
      // to human OR completely empty, replace the message with a
      // friendly holding line so the lead doesn't sit in silence
      // while the human picks up. The escalation still fires (the
      // operator gets the SYSTEM notification downstream); we just
      // don't leave the lead staring at no reply. None of the other
      // exhaustion branches above need this — they all set a
      // deterministic fallback message themselves.
      const finalIsEmpty =
        !Array.isArray(parsed.messages) ||
        parsed.messages.length === 0 ||
        parsed.messages.every(
          (b) => typeof b !== 'string' || b.trim().length === 0
        );
      if (parsed.escalateToHuman && finalIsEmpty) {
        const holdingLine = 'gimme a sec bro, looking into this';
        parsed.message = holdingLine;
        parsed.messages = [holdingLine];
        parsed.softExit = false;
        parsed.voiceNoteAction = null;
        console.warn(
          `[ai-engine] Empty + escalating output — shipping holding line so lead doesn't sit silent (conv ${activeConversationId})`
        );
      }
    }
  }

  // R24 audit log — one row per qualifying attempt. Written only when
  // the gate actually ran (i.e. the reply was routing to booking-handoff
  // AND a threshold was configured). Makes R24 compliance queryable via
  // a single WHERE routingAllowed=false query.
  if (
    r24WasEvaluatedThisTurn &&
    activeConversationId &&
    typeof capitalThreshold === 'number'
  ) {
    try {
      await prisma.bookingRoutingAudit.create({
        data: {
          conversationId: activeConversationId,
          accountId,
          personaMinimumCapital: capitalThreshold,
          verificationAskedAtMessageId: r24LastResult.verificationAskedAt,
          verificationConfirmedAtMessageId:
            r24LastResult.verificationConfirmedAt,
          routingAllowed: !r24LastResult.blocked,
          regenerationForced: r24GateEverForcedRegen
        }
      });
    } catch (err) {
      console.error('[ai-engine] R24 audit write failed (non-fatal):', err);
    }
  }

  if (!parsed) {
    throw new Error('Failed to generate AI response');
  }

  let selfRecovered = false;
  let selfRecoveryEventId: string | null = null;
  let selfRecoveryReason: string | null = null;
  let selfRecoveryCapitalOutcome: CapitalOutcome | null = null;
  if (preGenerationRecovery?.recovered) {
    selfRecovered = true;
    selfRecoveryEventId = preGenerationRecovery.eventId;
    selfRecoveryReason = preGenerationRecovery.reason;
    selfRecoveryCapitalOutcome = preGenerationRecovery.capitalOutcome;
    if (
      scriptStateSnapshot &&
      (preGenerationRecovery.systemStage ||
        preGenerationRecovery.currentScriptStep)
    ) {
      scriptStateSnapshot = {
        ...scriptStateSnapshot,
        systemStage: preGenerationRecovery.systemStage,
        currentScriptStep:
          preGenerationRecovery.currentScriptStep ??
          scriptStateSnapshot.currentScriptStep
      };
    }
  }

  // Martin/Chileshe class fix: if the LLM is about to stall or escalate,
  // consult the script state machine first. Deterministic recovery output
  // still has to pass the same voice-quality gate before it can ship.
  const recoveryTrigger = isSelfRecoveryTrigger({
    escalateToHuman: parsed.escalateToHuman,
    stallType: parsed.stallType,
    message: parsed.message,
    messages: parsed.messages
  });
  if (
    activeConversationId &&
    !rescheduleFlow &&
    recoveryTrigger.triggered &&
    !lastLeadMsg?.content?.trimStart().startsWith('OPERATOR NOTE:')
  ) {
    try {
      const recovery = await attemptSelfRecovery({
        accountId,
        conversationId: activeConversationId,
        history: conversationHistory,
        triggerReason: recoveryTrigger.reason || 'unknown_recovery_trigger',
        llmEmittedStage: parsed.stage
      });

      if (recovery.recovered) {
        const recoveryQuality = scoreVoiceQualityGroup(
          recovery.messages,
          buildVoiceQualityOptions(
            recovery.messages.length || 1,
            recovery.capitalOutcome === 'failed' ? 'failed' : undefined
          )
        );
        const recoveryPassed =
          recoveryQuality.passed && recoveryQuality.hardFails.length === 0;

        if (recoveryPassed) {
          parsed.message = recovery.reply;
          parsed.messages = recovery.messages;
          parsed.format = 'text';
          parsed.stage = recovery.stage;
          parsed.subStage = recovery.subStage;
          parsed.stageConfidence = 1;
          parsed.stallType = null;
          parsed.softExit = false;
          parsed.escalateToHuman = false;
          parsed.voiceNoteAction = null;
          finalQualityScore = recoveryQuality.score;
          qualityGateTerminalFailure = false;
          qualityGateFailureReason = null;
          qualityGateHardFails = [];
          selfRecovered = true;
          selfRecoveryEventId = recovery.eventId;
          selfRecoveryReason = recovery.reason;
          selfRecoveryCapitalOutcome = recovery.capitalOutcome;
          if (
            scriptStateSnapshot &&
            (recovery.systemStage || recovery.currentScriptStep)
          ) {
            scriptStateSnapshot = {
              ...scriptStateSnapshot,
              systemStage: recovery.systemStage,
              currentScriptStep:
                recovery.currentScriptStep ??
                scriptStateSnapshot?.currentScriptStep ??
                1
            };
          }
          console.log(
            `[ai-engine] Self-recovery succeeded for convo ${activeConversationId}: ${recovery.reason}`
          );
        } else {
          await markSelfRecoveryEventFailed(
            recovery.eventId,
            `quality_gate_failed:${recoveryQuality.hardFails.join(',') || 'score'}`
          );
          console.warn(
            `[ai-engine] Self-recovery rejected by voice gate for convo ${activeConversationId}: ${recoveryQuality.hardFails.join(', ') || 'score'}`
          );
        }
      } else if (recovery.reason === 'recovery_circuit_breaker') {
        parsed.escalateToHuman = true;
        parsed.stallType = 'RECOVERY_CIRCUIT_BREAKER';
      }
    } catch (err) {
      console.error('[ai-engine] Self-recovery failed (non-fatal):', err);
    }
  }

  // 6. Get response delay from the account (global setting, set on Scripts page).
  // voiceNotesEnabled still lives on the persona for now.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { responseDelayMin: true, responseDelayMax: true }
  });
  // F3.2: persona for delay/voice settings — use the threaded
  // personaId so multi-persona accounts get the right voice
  // configuration deterministically.
  const persona = await prisma.aIPersona.findUnique({
    where: { id: personaId },
    select: { voiceNotesEnabled: true }
  });

  const delayMin = account?.responseDelayMin ?? 300;
  const delayMax = account?.responseDelayMax ?? 600;
  const { humanResponseDelay } = await import('@/lib/delay-utils');
  const suggestedDelay = humanResponseDelay(delayMin, delayMax);

  const shouldVoiceNote =
    parsed.format === 'voice_note' && (persona?.voiceNotesEnabled ?? false);

  // 7. Get prompt version for tracking
  const systemPromptVersion = await getPromptVersion(accountId);

  // 8. Create AISuggestion record for closed-loop training (non-fatal)
  let suggestionId: string | null = null;
  try {
    // Check account's current training phase for snapshot
    const accountRow = await prisma.account.findUnique({
      where: { id: accountId },
      select: { trainingPhase: true }
    });
    const isOnboarding = accountRow?.trainingPhase === 'ONBOARDING';

    // Resolve the conversationId from the last lead message in history
    // (passed via leadContext, but we need the actual convo ID — the caller
    // must provide it; we extract from the conversation history context)
    const lastMsg = [...conversationHistory].reverse().find((m) => m.id);
    let convoId: string | null = null;
    if (lastMsg?.id) {
      const msgRow = await prisma.message.findUnique({
        where: { id: lastMsg.id },
        select: { conversationId: true }
      });
      convoId = msgRow?.conversationId || null;
    }

    if (convoId) {
      // Multi-bubble: persist the full array on messageBubbles so override
      // detection can Jaccard-compare the human's takeover against the
      // joined group. responseText still carries messages[0] for
      // back-compat with any legacy consumer that reads it directly.
      const suggestion = await prisma.aISuggestion.create({
        data: {
          conversationId: convoId,
          accountId,
          responseText: parsed.message,
          messageBubbles:
            parsed.messages.length > 1
              ? (parsed.messages as Prisma.InputJsonValue)
              : undefined,
          bubbleCount: parsed.messages.length,
          retrievalTier: null, // TODO: pipe from retriever in future
          qualityGateAttempts,
          qualityGateScore: finalQualityScore,
          qualityGatePassedFirstAttempt,
          intentClassification: detectedIntent || null,
          intentConfidence: null, // TODO: pipe from classifier in future
          leadStageSnapshot: leadContext.status || null,
          leadTypeSnapshot: leadContext.experience || null,
          aiStageReported: parsed.stage || null,
          aiSubStageReported: parsed.subStage || null,
          generatedDuringTrainingPhase: isOnboarding,
          modelUsed: modelUsedFinal,
          inputTokens: usageTotal.inputTokens,
          outputTokens: usageTotal.outputTokens,
          cacheReadTokens: usageTotal.cacheReadTokens,
          cacheCreationTokens: usageTotal.cacheCreationTokens
        }
      });
      suggestionId = suggestion.id;
      if (scriptStateSnapshot?.currentStep) {
        try {
          const stepCompletionTraceForBranchHistory = asJsonObject(
            (scriptStateSnapshot.capturedDataPoints as Record<string, unknown>)
              .lastStepCompletionTrace as Prisma.JsonValue
          );
          await appendBranchHistoryEvent({
            conversationId: convoId,
            event: {
              eventType: smartModeActive
                ? 'smart_mode_response'
                : 'branch_selected',
              stepNumber: scriptStateSnapshot.currentStep.stepNumber,
              stepTitle: scriptStateSnapshot.currentStep.title ?? null,
              selectedBranchLabel: smartModeActive
                ? null
                : (scriptStateSnapshot.selectedBranchLabel ?? null),
              suggestionId,
              aiMessageId: null,
              aiMessageIds: [],
              leadMessageId: lastLeadMsg?.id ?? null,
              sentAt: null,
              completedAt: null,
              stepCompletionAttempted:
                typeof stepCompletionTraceForBranchHistory.stepCompletionAttempted ===
                'boolean'
                  ? stepCompletionTraceForBranchHistory.stepCompletionAttempted
                  : null,
              stepCompletionReason: smartModeActive
                ? 'smart_mode_low_confidence_branch'
                : typeof stepCompletionTraceForBranchHistory.stepCompletionReason ===
                    'string'
                  ? stepCompletionTraceForBranchHistory.stepCompletionReason
                  : null,
              previousSelectedBranch:
                typeof stepCompletionTraceForBranchHistory.previousSelectedBranch ===
                'string'
                  ? stepCompletionTraceForBranchHistory.previousSelectedBranch
                  : null,
              currentSelectedBranch: smartModeActive
                ? null
                : (scriptStateSnapshot.selectedBranchLabel ?? null),
              selectedSuggestionId:
                typeof stepCompletionTraceForBranchHistory.selectedSuggestionId ===
                'string'
                  ? stepCompletionTraceForBranchHistory.selectedSuggestionId
                  : null,
              historyMessagesWithSelectedSuggestionId:
                typeof stepCompletionTraceForBranchHistory.historyMessagesWithSelectedSuggestionId ===
                'number'
                  ? stepCompletionTraceForBranchHistory.historyMessagesWithSelectedSuggestionId
                  : null
            }
          });
        } catch (err) {
          console.error('[ai-engine] branchHistory selection persist failed:', {
            conversationId: convoId,
            suggestionId,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      await writeGenerateReplyTrace({
        checkpoint8_aiSuggestionWritten: true,
        lastCheckpoint: 'checkpoint8_aiSuggestionWritten',
        suggestionId,
        suggestionResponseFirst100: parsed.message?.slice(0, 100) ?? null,
        suggestionStage: parsed.stage ?? null,
        suggestionSubStage: parsed.subStage ?? null,
        qualityGateAttempts,
        finalQualityScore,
        modelUsed: modelUsedFinal
      });
    }
  } catch (err) {
    await writeGenerateReplyTrace({
      checkpoint8_aiSuggestionWritten: false,
      lastCheckpoint: 'ai_suggestion_write_failed',
      aiSuggestionWriteError: err instanceof Error ? err.message : String(err)
    });
    console.error('[ai-engine] AISuggestion write failed (non-fatal):', err);
  }

  // Derive the R24 capital-verification outcome for this turn. The
  // webhook-processor consumes this to drive Lead.stage — a FAILED
  // outcome must route the lead to UNQUALIFIED rather than QUALIFIED,
  // and a non-passing outcome must not promote past QUALIFYING.
  // If R24 wasn't evaluated (no threshold configured, or this turn
  // wasn't routing to booking handoff) we emit `not_evaluated` — the
  // consumer treats that as "no signal" and falls back to the
  // stage-name mapping.
  let capitalOutcome: CapitalOutcome;
  if (selfRecoveryCapitalOutcome) {
    capitalOutcome = selfRecoveryCapitalOutcome;
  } else if (!r24WasEvaluatedThisTurn) {
    capitalOutcome = 'not_evaluated';
  } else {
    switch (r24LastResult.reason) {
      case 'confirmed_amount':
      case 'confirmed_affirmative':
      case 'durable_qualification_state':
        capitalOutcome = 'passed';
        break;
      case 'answer_below_threshold':
        capitalOutcome = 'failed';
        break;
      case 'answer_hedging':
        capitalOutcome = 'hedging';
        break;
      case 'answer_ambiguous':
      case 'answer_total_savings_needs_clarification':
      case 'answer_prop_firm_only':
      case 'answer_currency_unclear':
      case 'answer_vague_capital':
        // Prop-firm-only / currency-unclear / vague-capital are
        // ambiguous-class outcomes for the downstream
        // `capitalOutcome` consumer (lead.stage mapping). The
        // directive-specific handling lives in the R24 override
        // switch above; the lead.stage side just needs "not
        // passed".
        capitalOutcome = 'ambiguous';
        break;
      case 'never_asked':
      case 'asked_but_no_answer':
        capitalOutcome = 'not_asked';
        break;
      default:
        capitalOutcome = 'not_asked';
    }
  }

  let stageOverrideReason: string | null = null;
  if (activeConversationId) {
    try {
      const override = await applyStageOverride({
        conversationId: activeConversationId,
        llmEmittedStage: parsed.stage,
        currentStage: parsed.stage,
        capitalOutcome,
        snapshot: scriptStateSnapshot
      });
      if (override.reason) {
        stageOverrideReason = override.reason;
        parsed.stage = override.finalStage;
        capitalOutcome = override.capitalOutcome;
        console.log(
          `[ai-engine] Stage override applied for convo ${activeConversationId}: ${override.reason} -> ${override.finalStage}`
        );
      }
    } catch (err) {
      console.error('[ai-engine] Stage override failed (non-fatal):', err);
    }
  }

  if (suggestionId) {
    prisma.aISuggestion
      .update({
        where: { id: suggestionId },
        data: {
          capitalOutcome,
          aiStageReported: parsed.stage || null,
          aiSubStageReported: parsed.subStage || null
        }
      })
      .catch((err) =>
        console.error(
          '[ai-engine] AISuggestion capitalOutcome update failed (non-fatal):',
          err
        )
      );
  }

  // Persist runtime-judgment captures into Conversation.capturedDataPoints
  // so subsequent turns can reference them via the prior-captured-signals
  // block. Fire-and-forget — a persist failure should never block the
  // ship of an otherwise valid reply. Merging preserves any keys the
  // structured extractDataPoints pipeline (script-state-recovery)
  // already wrote on this turn; new captures from the LLM overwrite
  // matching keys with the freshest signal.
  //
  // Also synthesise `beliefBreakDelivered` when the AI's reply matches
  // the Step 13 reframe. This prereq must progress through bubble1 ->
  // bubble2 -> complete; a single "99% of traders" opener is not
  // enough to clear call/capital gates.
  const llmCaptures = parsed.capturedDataPoints || null;
  let synthesisedCaptures: Record<string, string> | null = null;
  const replyForBeliefDetection = parsed.messages.join('\n');
  const beliefBreakStage = detectBeliefBreakDeliveryStage(
    parsed.messages.map((content) => ({ content }))
  );
  if (beliefBreakStage) {
    synthesisedCaptures = { beliefBreakDelivered: beliefBreakStage };
  } else if (
    detectBeliefBreakInMessage(replyForBeliefDetection) &&
    !hasCapturedDataPoint(
      scriptStateSnapshot?.capturedDataPoints ?? null,
      'beliefBreakDelivered'
    )
  ) {
    synthesisedCaptures = { beliefBreakDelivered: 'bubble1' };
  }
  const totalCaptures =
    llmCaptures || synthesisedCaptures
      ? { ...(llmCaptures ?? {}), ...(synthesisedCaptures ?? {}) }
      : null;
  if (
    activeConversationId &&
    totalCaptures &&
    Object.keys(totalCaptures).length > 0
  ) {
    persistCapturedDataPointMerge({
      conversationId: activeConversationId,
      incoming: totalCaptures
    }).catch((err) =>
      console.error(
        '[ai-engine] capturedDataPoints persist failed (non-fatal):',
        err
      )
    );
  }

  return {
    reply: parsed.message,
    messages: parsed.messages,
    format: parsed.format as 'text' | 'voice_note',
    stage: parsed.stage,
    subStage: parsed.subStage,
    stageConfidence: parsed.stageConfidence,
    sentimentScore: parsed.sentimentScore,
    experiencePath: parsed.experiencePath,
    objectionDetected: parsed.objectionDetected,
    stallType: parsed.stallType,
    affirmationDetected: parsed.affirmationDetected,
    followUpNumber: parsed.followUpNumber,
    softExit: parsed.softExit,
    escalateToHuman: parsed.escalateToHuman,
    leadTimezone: parsed.leadTimezone,
    selectedSlotIso: parsed.selectedSlotIso,
    leadEmail: parsed.leadEmail,
    suggestedTag: parsed.suggestedTag,
    suggestedTags: parsed.suggestedTags,
    shouldVoiceNote,
    voiceNoteAction: parsed.voiceNoteAction,
    qualityScore: Math.round(parsed.stageConfidence * 100),
    qualityGateTerminalFailure,
    qualityGateFailureReason,
    qualityGateHardFails,
    qualityGateAttempts,
    suggestedDelay,
    systemPromptVersion,
    suggestionId,
    capitalOutcome,
    typeformFilledNoBooking:
      parsed.subStage === 'TYPEFORM_NO_BOOKING' &&
      parsed.message === TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE,
    selfRecovered,
    selfRecoveryEventId,
    selfRecoveryReason,
    systemStage: scriptStateSnapshot?.systemStage ?? null,
    currentScriptStep: scriptStateSnapshot?.currentScriptStep ?? null,
    stageOverrideReason
  };
}

// ---------------------------------------------------------------------------
// Provider Resolution (per-account BYOK with env fallback)
// ---------------------------------------------------------------------------

// Reverted from 'claude-sonnet-4-6' on 2026-05-05 after observed
// regressions in the production reply path (script-skip recovery
// gate failures, escalation churn). Holding on the dated Sonnet 4
// model that was stable through prior weeks of traffic. Constant
// name kept for diff minimalism.
const SONNET_46_MODEL = 'claude-sonnet-4-20250514';
// Default main-generation model for all OpenAI-routed accounts. GPT-5.4
// mini: accepts temp=0.85 + JSON response_format, requires
// max_completion_tokens (handled in callOpenAI). Swapped from
// gpt-4o-mini 2026-04-24 after the Sonnet 4.6 watch.
const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';

async function resolveAIProvider(accountId: string): Promise<{
  provider: 'openai' | 'anthropic';
  apiKey: string | undefined;
  model: string;
  /** OpenAI creds used by the Anthropic fallback path (and only then). */
  fallback?: { apiKey: string; model: string };
}> {
  // Read the account-level routing flag. `aiProvider='anthropic'` flips
  // main generation onto Claude Sonnet 4.6 without removing the OpenAI
  // key — the key stays available as the fallback when Anthropic errors.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { aiProvider: true }
  });

  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  const openaiKey =
    (openaiCreds?.apiKey as string | undefined) ?? process.env.OPENAI_API_KEY;
  const openaiModel =
    (openaiCreds?.model as string | undefined) || OPENAI_DEFAULT_MODEL;

  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  const anthropicKey =
    (anthropicCreds?.apiKey as string | undefined) ??
    process.env.ANTHROPIC_API_KEY;

  if (account?.aiProvider === 'anthropic') {
    const fallback =
      openaiKey !== undefined
        ? { apiKey: openaiKey, model: openaiModel }
        : undefined;
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: (anthropicCreds?.model as string) || SONNET_46_MODEL,
      fallback
    };
  }

  // Default path: current credential-based resolution.
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      model: openaiModel
    };
  }

  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: (anthropicCreds.model as string) || SONNET_46_MODEL
    };
  }

  // Fallback to env vars
  const envProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = envProvider === 'anthropic' ? 'anthropic' : 'openai';
  const apiKey = provider === 'anthropic' ? anthropicKey : openaiKey;
  const model =
    process.env.AI_MODEL ||
    (provider === 'anthropic' ? SONNET_46_MODEL : OPENAI_DEFAULT_MODEL);

  return { provider: provider as 'openai' | 'anthropic', apiKey, model };
}

// ---------------------------------------------------------------------------
// Format Conversation History for LLM
// ---------------------------------------------------------------------------

function extractQuestionsFromText(text: string): string[] {
  if (!text) return [];
  const questions: string[] = [];
  const matches = text.match(/[^?!.\n]*\?/g) || [];
  for (const match of matches) {
    const question = match.trim().replace(/\?+$/, '').trim();
    if (question.length > 0) questions.push(question);
  }
  return questions;
}

function extractLastAIQuestions(aiMessages: string[], limit: number): string[] {
  const questions: string[] = [];
  for (let i = aiMessages.length - 1; i >= 0 && questions.length < limit; i--) {
    const messageQuestions = extractQuestionsFromText(aiMessages[i]);
    for (
      let j = messageQuestions.length - 1;
      j >= 0 && questions.length < limit;
      j--
    ) {
      questions.unshift(messageQuestions[j]);
    }
  }
  return questions;
}

function isBotDetectionQuestion(text: string): boolean {
  return /\b(are\s+you\s+(a\s+)?(bot|robot|ai|automated|auto[-\s]?reply|programmed)|is\s+this\s+(a\s+)?(bot|robot|ai|automated|auto[-\s]?reply|programmed)|is\s+(this|that)\s+(automated|programmed|a\s+bot|a\s+robot|ai)|auto[-\s]?reply|programmed\s+(response|reply)|am\s+i\s+talking\s+to\s+(a\s+)?(bot|robot|ai)|real\s+person)\b/i.test(
    text
  );
}

type AITurnForQuality = {
  messageGroupId: string | null;
  messages: string[];
  content: string;
  timestamp: Date | string;
};

function groupAIMessagesIntoTurns(
  history: ConversationMessage[]
): AITurnForQuality[] {
  const turns: AITurnForQuality[] = [];

  for (const msg of history) {
    if (msg.sender !== 'AI') continue;

    const groupId = msg.messageGroupId ?? null;
    const previousTurn = turns[turns.length - 1];
    if (groupId && previousTurn?.messageGroupId === groupId) {
      previousTurn.messages.push(msg.content);
      previousTurn.content = previousTurn.messages.join(' ');
      previousTurn.timestamp = msg.timestamp;
      continue;
    }

    turns.push({
      messageGroupId: groupId,
      messages: [msg.content],
      content: msg.content,
      timestamp: msg.timestamp
    });
  }

  return turns;
}

function hasCapitalVerificationQuestionAndAnswer(
  history: ConversationMessage[]
): boolean {
  let capitalQuestionSeen = false;

  for (const msg of history) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      containsCapitalQuestion(msg.content)
    ) {
      capitalQuestionSeen = true;
      continue;
    }

    if (capitalQuestionSeen && isLeadCapitalParseCandidate(msg)) {
      return true;
    }
  }

  return false;
}

function formatConversationForLLM(
  history: ConversationMessage[]
): LLMMessage[] {
  return history.map((msg) => {
    // LEAD messages → user role, AI/HUMAN messages → assistant role
    if (msg.sender === 'LEAD') {
      const isVoiceMessage =
        msg.isVoiceNote === true || msg.mediaType === 'audio';
      if (isVoiceMessage) {
        return {
          role: 'user' as const,
          content: buildVoiceContextText({
            transcription: msg.transcription,
            mediaProcessedAt: msg.mediaProcessedAt,
            mediaProcessingError: msg.mediaProcessingError
          })
        };
      }

      if (msg.imageMetadata || msg.mediaType === 'image') {
        const imageContext = buildImageContextText(msg.imageMetadata);
        const text =
          msg.content && !['[Image]', '[Chart shared]'].includes(msg.content)
            ? `${msg.content}\n${imageContext}`
            : imageContext;
        return { role: 'user' as const, content: text };
      }

      if (msg.imageUrl) {
        const text =
          msg.content && !['[Image]', '[Chart shared]'].includes(msg.content)
            ? msg.content
            : 'The lead sent this image without any text message.';
        return {
          role: 'user' as const,
          content: [
            {
              type: 'image_url' as const,
              image_url: {
                url: msg.imageUrl,
                detail: 'low' as const
              }
            },
            {
              type: 'text' as const,
              text
            }
          ]
        };
      }
      return { role: 'user' as const, content: msg.content };
    }
    // AI/HUMAN messages are "our side" of the conversation. SYSTEM
    // messages are internal operator notes: include them as context for
    // the model, but clearly mark that they were not sent to the lead.
    const prefix =
      msg.sender === 'SYSTEM' || isOperatorNoteContent(msg.content)
        ? '[Internal operator note, not sent to lead] '
        : msg.sender === 'HUMAN'
          ? '[Human team member] '
          : '';
    return { role: 'assistant' as const, content: prefix + msg.content };
  });
}

function buildMediaContextCorpus(history: ConversationMessage[]): string {
  return history
    .filter(
      (msg) =>
        msg.sender === 'LEAD' &&
        (msg.isVoiceNote === true ||
          msg.mediaType === 'audio' ||
          msg.mediaType === 'image' ||
          Boolean(msg.imageMetadata))
    )
    .map((msg) => {
      if (msg.isVoiceNote === true || msg.mediaType === 'audio') {
        return buildVoiceContextText({
          transcription: msg.transcription,
          mediaProcessedAt: msg.mediaProcessedAt,
          mediaProcessingError: msg.mediaProcessingError
        });
      }
      return buildImageContextText(msg.imageMetadata);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// LLM Call (OpenAI or Anthropic)
// ---------------------------------------------------------------------------

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LLMCallResult {
  text: string;
  /** Final model that produced the text. On fallback, the fallback model. */
  modelUsed: string;
  usage: LLMUsage;
}

const EMPTY_USAGE: LLMUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
};

const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini';
const OPENAI_FALLBACK_MARKER = 'gpt-4o-mini-fallback';

async function callLLM(
  provider: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[],
  /** Fallback credentials used when the Anthropic path throws. */
  fallback?: { apiKey: string; model: string }
): Promise<LLMCallResult> {
  if (provider === 'anthropic') {
    try {
      return await callAnthropic(apiKey, model, systemPrompt, messages);
    } catch (err) {
      // Fallback: swap to OpenAI so the conversation keeps moving. We
      // mark modelUsed with a dedicated suffix so dashboard + analytics
      // can flag accounts seeing high fallback rates without guessing.
      console.error(
        `[ai-engine] Anthropic call failed (${model}), falling back to ${OPENAI_FALLBACK_MODEL}:`,
        err instanceof Error ? err.message : err
      );
      if (!fallback?.apiKey) {
        // No OpenAI creds available — re-throw so the upstream retry
        // loop can handle it. Better than silent empty-reply ship.
        throw err;
      }
      const res = await callOpenAI(
        fallback.apiKey,
        fallback.model,
        systemPrompt,
        messages
      );
      return { ...res, modelUsed: OPENAI_FALLBACK_MARKER };
    }
  }
  return callOpenAI(apiKey, model, systemPrompt, messages);
}

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[]
): Promise<LLMCallResult> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  // GPT-5 family rejects `max_tokens` — must use `max_completion_tokens`.
  // gpt-4o-mini (the fallback) also accepts `max_completion_tokens`, so
  // we route via it universally to keep one call shape regardless of
  // which OpenAI model ends up here.
  const response = await client.chat.completions.create({
    model,
    temperature: 0.85,
    max_completion_tokens: 1500,
    // Force OpenAI to emit a valid JSON object. The system prompt already
    // demands JSON, but stacked directive blocks sometimes steered the
    // model into plain text — this guarantees the response parses.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system' as const, content: systemPrompt },
      ...messages
    ] as any
  });

  // OpenAI caches long prompts (>1024 tokens) automatically — no
  // request-side cache_control needed. `prompt_tokens_details.cached_tokens`
  // exposes the hit count when caching is active. We map it onto the
  // Anthropic-shaped LLMUsage so AISuggestion's cost columns stay
  // uniform across providers.
  const details = response.usage as {
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const cached = details?.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    text: response.choices[0]?.message?.content?.trim() || '',
    modelUsed: model,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheCreationTokens: 0
    }
  };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[]
): Promise<LLMCallResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Anthropic requires messages to start with user role
  let anthropicMessages: LLMMessage[] = [...messages];
  if (
    anthropicMessages.length > 0 &&
    anthropicMessages[0].role === 'assistant'
  ) {
    anthropicMessages = [
      {
        role: 'user' as const,
        content: '[Conversation started by our team]'
      },
      ...anthropicMessages
    ];
  }

  // Anthropic also requires alternating roles — merge consecutive same-role messages
  anthropicMessages = mergeConsecutiveRoles(anthropicMessages);
  const anthropicPayloadMessages = anthropicMessages.map((message) => ({
    role: message.role,
    content: toAnthropicContent(message.content)
  }));

  // Prompt caching: the ~60K-token system prompt is stable across turns
  // in a conversation (persona + script + rules only change on script
  // edits). Marking it with ephemeral cache_control halves input cost
  // on every turn after the first — cache TTL is 5min, which covers
  // any normal multi-turn chat window.
  const response = await client.messages.create({
    model,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ],
    temperature: 0.85,
    max_tokens: 1500,
    messages: anthropicPayloadMessages as any
  });

  const textBlock = response.content.find(
    (block: { type: string }) => block.type === 'text'
  );
  const text = (
    textBlock && 'text' in textBlock ? (textBlock.text as string) : ''
  ).trim();

  // Usage shape varies slightly across SDK versions — defensive reads.
  const u = response.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  return {
    text,
    modelUsed: model,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0
    }
  };
}

/**
 * Accumulate per-call usage into a running total across voice-gate
 * retries. The suggestion row stores the totals so cost tracking
 * reflects every generation that went into producing the shipped text.
 */
function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
  };
}

type AnthropicContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      source: {
        type: 'url';
        url: string;
      };
    };

function contentToParts(content: LLMMessageContent): LLMContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function mergeMessageContent(
  first: LLMMessageContent,
  second: LLMMessageContent
): LLMMessageContent {
  if (typeof first === 'string' && typeof second === 'string') {
    return `${first}\n${second}`;
  }
  return [
    ...contentToParts(first),
    { type: 'text', text: '\n' },
    ...contentToParts(second)
  ];
}

function toAnthropicContent(
  content: LLMMessageContent
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'image',
      source: {
        type: 'url',
        url: part.image_url.url
      }
    };
  });
}

/**
 * Merge consecutive messages with the same role (required by Anthropic).
 */
function mergeConsecutiveRoles(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length === 0) return messages;

  const merged: LLMMessage[] = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = mergeMessageContent(last.content, msg.content);
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Parse AI Response (structured JSON)
// ---------------------------------------------------------------------------

interface ParsedAIResponse {
  format: string;
  /**
   * First bubble of the group. Backward-compat field — all existing
   * downstream consumers can keep reading `.message`. When the LLM
   * emits messages[], this equals messages[0].
   */
  message: string;
  /**
   * Always populated array of 1-4 bubble strings. Single-message
   * responses appear as `[message]`. Multi-bubble responses contain
   * the full ordered array. Downstream delivery iterates over this.
   */
  messages: string[];
  stage: string;
  subStage: string | null;
  stageConfidence: number;
  sentimentScore: number;
  experiencePath: string | null;
  objectionDetected: string | null;
  stallType: string | null;
  affirmationDetected: boolean;
  followUpNumber: number | null;
  softExit: boolean;
  escalateToHuman: boolean;
  leadTimezone: string | null;
  selectedSlotIso: string | null;
  leadEmail: string | null;
  suggestedTag: string;
  suggestedTags: string[];
  voiceNoteAction: { slot_id: string } | null;
  parserMetadataLeak?: {
    matchedPattern: string | null;
    matchedText: string | null;
    originalMessages: string[];
  } | null;
  /**
   * Variable captures emitted by the LLM when a runtime_judgment fires.
   * Keys match {{variable_name}} placeholders that operators wrote into
   * ScriptAction.content for runtime_judgment actions; values are the
   * lead's captured phrases. Persisted into Conversation.capturedDataPoints
   * post-generation so subsequent turns can reference the signal.
   * Null when the LLM did not detect any judgment-relevant signals on
   * this turn.
   */
  capturedDataPoints?: Record<string, string> | null;
}

class InvalidLLMOutputError extends Error {
  code: string;
  found?: string | null;

  constructor(code: string, found?: string | null) {
    super(code);
    this.name = 'InvalidLLMOutputError';
    this.code = code;
    this.found = found;
  }
}

function buildR34BlockedFallbackParsed(): ParsedAIResponse {
  const message = 'gimme a sec bro, looking into this';
  return {
    format: 'text',
    message,
    messages: [message],
    stage: 'SOFT_EXIT',
    subStage: null,
    stageConfidence: 0.5,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: 'R34_METADATA_LEAK_BLOCKED',
    affirmationDetected: false,
    followUpNumber: null,
    softExit: false,
    escalateToHuman: true,
    leadTimezone: null,
    selectedSlotIso: null,
    leadEmail: null,
    suggestedTag: '',
    suggestedTags: [],
    voiceNoteAction: null,
    parserMetadataLeak: null,
    capturedDataPoints: null
  };
}

// Multi-bubble constants — enforced at parse time regardless of
// whether the persona's multiBubbleEnabled flag is on. LLM-side
// guardrails in the prompt also mention these, but parse-side
// validation is the source of truth.
const MAX_BUBBLES_PER_GROUP = 4;
const MIN_BUBBLE_CHARS = 2;
const FORBIDDEN_MESSAGE_METADATA_TERMS = [
  'stage_confidence',
  'quality_score',
  'priority_score',
  'stage:',
  'intent:',
  'next_action',
  'script_step',
  'current_stage',
  'confidence:'
];

/**
 * Normalise the bubble array extracted from the LLM JSON. Filters
 * empty / too-short entries, coerces non-strings to strings, caps at
 * MAX_BUBBLES_PER_GROUP with a soft-warn on overflow. Returns null
 * when the input doesn't parse as a usable array — caller falls back
 * to the single-message path.
 */
function normaliseBubbles(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const strings = raw
    .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_BUBBLE_CHARS);
  if (strings.length === 0) return null;
  if (raw.length > MAX_BUBBLES_PER_GROUP) {
    console.warn(
      `[ai-engine] LLM emitted ${raw.length} bubbles; capping at ${MAX_BUBBLES_PER_GROUP} and dropping the remainder`
    );
  }
  return strings.slice(0, MAX_BUBBLES_PER_GROUP);
}

// Casual acknowledgment phrases that, when they OPEN a bubble that ALSO
// ends in a question mark, indicate the model jammed an ack and a
// question into one bubble instead of splitting. Conservative list —
// only short opener tokens we never use mid-thought.
const ACK_OPENER_RE =
  /^(that'?s|gotchu|gotcha|love that|fasho|damn|bet|sick|respect|facts?|fire|yo|yeah|appreciate|ah|aight|word|nice|solid|dope|aw|oh|hey|hell yeah|hella|big bro|bro)\b/i;

/**
 * Last-resort split for the no-newline concatenation pattern, e.g.
 *   "damn bro, that's a real grind. how long you been at it?"
 *
 * Returns a 2-element array if the bubble matches:
 *   - opens with a casual acknowledgment phrase
 *   - ends with `?`
 *   - has at least one sentence boundary `[.!]` between
 *
 * Otherwise returns null and the caller keeps the bubble whole.
 */
function splitConcatenatedAckQuestion(s: string): string[] | null {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed.endsWith('?')) return null;
  if (!ACK_OPENER_RE.test(trimmed)) return null;
  // Find the LAST sentence boundary before the trailing question — we
  // want to keep the question intact in bubble[1] and pile any leading
  // ack/info into bubble[0].
  const match = /^(.+[.!])\s+([^.!?]*\?)$/.exec(trimmed);
  if (!match) return null;
  const ack = match[1].trim();
  const question = match[2].trim();
  if (ack.length < MIN_BUBBLE_CHARS || question.length < MIN_BUBBLE_CHARS)
    return null;
  return [ack, question];
}

function parseAIResponse(raw: string): ParsedAIResponse {
  const defaults: ParsedAIResponse = {
    format: 'text',
    message: raw,
    messages: [raw],
    stage: '',
    subStage: null,
    stageConfidence: 0.5,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: null,
    affirmationDetected: false,
    followUpNumber: null,
    softExit: false,
    escalateToHuman: false,
    leadTimezone: null,
    selectedSlotIso: null,
    leadEmail: null,
    suggestedTag: '',
    suggestedTags: [],
    voiceNoteAction: null,
    parserMetadataLeak: null,
    capturedDataPoints: null
  };

  try {
    let jsonStr = raw;

    // Strip markdown code fences if present
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const obj = JSON.parse(jsonStr);
    if (
      !(
        typeof obj.message === 'string' ||
        (Array.isArray(obj.messages) && obj.messages.length > 0)
      )
    ) {
      throw new InvalidLLMOutputError('missing_message_field');
    }

    // Pick bubbles from either messages[] (multi-bubble persona) or
    // wrap message (single-message). Both paths end with a populated
    // `messages: string[]` — downstream never has to branch on format.
    const fromArray = normaliseBubbles(obj.messages);
    const fromString =
      typeof obj.message === 'string' && obj.message.trim().length > 0
        ? obj.message
        : raw;

    // Auto-split fallback (daetradez 2026-04-24, widened 2026-04-28):
    // gpt-5.x minis frequently ignore the messages[] schema and emit
    // thoughts joined by newlines in a single "message" field. The
    // 2026-04-28 daetradez audit caught the failure mode: most rows
    // had `messageBubbles=null bubbleCount=1` with responseText like:
    //   "yo appreciate you reaching out bro\nare you new in the
    //    markets or you been trading for a while?"
    // — a single newline (not double) between an acknowledgment and
    // a question, jammed into one bubble. Splitting on `\n+` (any
    // number of newlines) catches this AND the legacy \n\n shape.
    // In DM context, ANY newline is almost certainly a thought break
    // — the model doesn't naturally use newlines mid-sentence. Cap
    // at MAX_BUBBLES_PER_GROUP so a runaway output doesn't ship 8
    // bubbles. Only activates when the LLM did NOT provide a
    // messages[] array — when it did, we trust its boundaries.
    let messages: string[];
    if (fromArray !== null) {
      messages = fromArray;
    } else {
      const split: string[] = fromString
        .split(/\n+/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length >= MIN_BUBBLE_CHARS);
      if (split.length >= 2) {
        messages = split.slice(0, MAX_BUBBLES_PER_GROUP);
        if (split.length > MAX_BUBBLES_PER_GROUP) {
          console.warn(
            `[ai-engine] parseAIResponse auto-split produced ${split.length} bubbles; capping at ${MAX_BUBBLES_PER_GROUP}`
          );
        }
      } else {
        // No newline separator — last resort: detect the
        // "[ack phrase]. [question]?" concatenation pattern with a
        // single sentence-boundary split. Only fires when the bubble
        // starts with a casual acknowledgment phrase AND ends with a
        // question mark, so we don't false-split legitimate single
        // multi-clause thoughts.
        const ackQuestionSplit = splitConcatenatedAckQuestion(fromString);
        messages = ackQuestionSplit ?? [fromString];
      }
    }
    const message = messages[0] ?? fromString;
    const joinedMessageBody = messages.join('\n');
    const lowerMessageBody = joinedMessageBody.toLowerCase();
    const forbiddenTerm = FORBIDDEN_MESSAGE_METADATA_TERMS.find((term) =>
      lowerMessageBody.includes(term)
    );
    const metadataLeak = detectMetadataLeak(joinedMessageBody);
    const parserMetadataLeak =
      forbiddenTerm || metadataLeak.leak
        ? {
            matchedPattern: metadataLeak.matchedPattern,
            matchedText: metadataLeak.matchedText ?? forbiddenTerm ?? null,
            originalMessages: [...messages]
          }
        : null;
    if (parserMetadataLeak) {
      console.warn(
        `[ai-engine] parseAIResponse rejected lead-facing metadata in message field. found="${parserMetadataLeak.matchedText ?? forbiddenTerm}" raw first 300 chars:`,
        raw.slice(0, 300)
      );
    }

    // Observability for the 2026-04-19 empty-message incident: if the
    // LLM emitted JSON with no usable text anywhere, loudly log the
    // raw payload (first 500 chars) so we can root-cause whether the
    // model is returning {}/null or formatting the reply outside the
    // expected fields. The retry loop's MAX_RETRIES-empty branch and
    // sendAIReply's hard gate both backstop this — this is purely a
    // diagnostic breadcrumb.
    const allEmpty = messages.every(
      (m) => typeof m !== 'string' || m.trim().length === 0
    );
    if (allEmpty) {
      console.warn(
        `[ai-engine] parseAIResponse produced empty messages[] — downstream will escalate. Raw first 500 chars: ${raw.slice(0, 500)}`
      );
    }

    return {
      format: obj.format || 'text',
      message,
      messages,
      stage: obj.stage || '',
      subStage: obj.sub_stage || null,
      stageConfidence:
        typeof obj.stage_confidence === 'number'
          ? Math.max(0, Math.min(1, obj.stage_confidence))
          : 0.5,
      sentimentScore:
        typeof obj.sentiment_score === 'number'
          ? Math.max(-1, Math.min(1, obj.sentiment_score))
          : 0,
      experiencePath: obj.experience_path || null,
      objectionDetected: obj.objection_detected || null,
      stallType: obj.stall_type || null,
      affirmationDetected: obj.affirmation_detected === true,
      followUpNumber:
        typeof obj.follow_up_number === 'number' ? obj.follow_up_number : null,
      softExit: obj.soft_exit === true,
      escalateToHuman: obj.escalate_to_human === true,
      leadTimezone:
        typeof obj.lead_timezone === 'string' && obj.lead_timezone.trim()
          ? obj.lead_timezone.trim()
          : null,
      selectedSlotIso:
        typeof obj.selected_slot_iso === 'string' &&
        obj.selected_slot_iso.trim()
          ? obj.selected_slot_iso.trim()
          : null,
      leadEmail:
        typeof obj.lead_email === 'string' && obj.lead_email.trim()
          ? obj.lead_email.trim()
          : null,
      suggestedTag: obj.suggested_tag || '',
      suggestedTags: Array.isArray(obj.suggested_tags)
        ? obj.suggested_tags
        : [],
      voiceNoteAction: obj.voice_note_action || null,
      parserMetadataLeak,
      capturedDataPoints: parseCapturedDataPointsFromResponse(
        obj.captured_data_points
      )
    };
  } catch (err) {
    if (err instanceof InvalidLLMOutputError) {
      console.warn(
        `[ai-engine] JSON parse strict-mode rejection: ${err.code}${err.found ? ` (${err.found})` : ''}. First 200 chars:`,
        raw.slice(0, 200)
      );
      throw err;
    }
    console.warn(
      '[ai-engine] JSON parse failed — LLM returned plain text instead of JSON. Falling back to defaults. First 200 chars:',
      raw.slice(0, 200)
    );
    // If JSON parsing fails, treat the whole response as a plain text message
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// R24 — Capital verification gate helpers
// ---------------------------------------------------------------------------
// These back the code-level enforcement layer documented at the top of
// the retry loop. The prompt-only R24 (in ai-prompts.ts master template)
// was not reliably followed in production because the script's concrete
// flow outranks abstract rules at decision points. This gate catches
// bad routings post-generation and forces regeneration. See the policy
// note at the top of ai-prompts.ts for the general principle.

/**
 * Discriminated reason for why the R24 gate made its decision. The
 * caller uses this to pick the right override directive on regen:
 * "ask the question" vs "pivot to downsell — lead is below threshold"
 * vs "ask clarifying question". `confirmed_*` reasons mean the gate
 * passed; everything else means blocked.
 */
export type R24Reason =
  | 'confirmed_amount' // Lead stated a concrete amount >= threshold
  | 'confirmed_affirmative' // Lead said "yeah" to a threshold-confirming Q (legacy path)
  | 'durable_qualification_state' // Conversation was already verified in durable state
  | 'never_asked' // No verification Q found in conversation history
  | 'asked_but_no_answer' // Q found, no subsequent LEAD reply yet
  | 'answer_below_threshold' // Lead stated amount < threshold OR said "not much" / "broke"
  | 'answer_hedging' // Lead hedged ("kinda", "working on it") without a number
  | 'answer_ambiguous' // Lead's reply didn't parse ("depends", "varies")
  | 'answer_total_savings_needs_clarification' // Number given as total savings / stress, not investable capital
  | 'answer_prop_firm_only' // Lead mentioned a prop firm but no personal capital
  | 'answer_currency_unclear' // Lead gave a number with no recognized currency symbol/context
  | 'answer_vague_capital'; // Lead gave a vague non-answer ("manageable amount", "saving up") — probe once

interface R24GateResult {
  /** True = block this response, force regen with override directive. */
  blocked: boolean;
  /** Fine-grained reason — drives which override directive the caller injects. */
  reason: R24Reason;
  /** Concrete amount parsed from the lead's reply, in the lead's native currency if known. */
  parsedAmount: number | null;
  /** Currency detected on the parsed amount, or null when the amount is USD/default. */
  parsedCurrency?: ConversationCurrency | null;
  /** USD-equivalent amount used for threshold comparison. */
  parsedAmountUsd?: number | null;
  /** Message.id of the AI message that asked the verification question. */
  verificationAskedAt: string | null;
  /** Message.id of the LEAD message that confirmed. */
  verificationConfirmedAt: string | null;
}

function formatCapitalAmountForDirective(result: R24GateResult): string {
  if (result.parsedAmount === null) return 'an amount below the threshold';

  const nativeCurrency = result.parsedCurrency ?? 'USD';
  const native =
    nativeCurrency === 'USD'
      ? `$${result.parsedAmount.toLocaleString('en-US')}`
      : `${nativeCurrency} ${result.parsedAmount.toLocaleString('en-US')}`;

  if (
    nativeCurrency === 'USD' ||
    result.parsedAmountUsd === null ||
    result.parsedAmountUsd === undefined
  ) {
    return native;
  }

  return `${native} (~$${Math.round(result.parsedAmountUsd).toLocaleString('en-US')} USD)`;
}

export function buildR24BlockedFallbackMessage(
  reason: R24Reason,
  threshold: number,
  result?: Pick<
    R24GateResult,
    'parsedAmount' | 'parsedCurrency' | 'parsedAmountUsd'
  >
): { message: string; stage: string; subStage: string | null } {
  const thresholdStr = `$${threshold.toLocaleString('en-US')}`;
  const stated = result
    ? formatCapitalAmountForDirective({
        blocked: true,
        reason,
        parsedAmount: result.parsedAmount ?? null,
        parsedCurrency: result.parsedCurrency ?? null,
        parsedAmountUsd: result.parsedAmountUsd ?? null,
        verificationAskedAt: null,
        verificationConfirmedAt: null
      })
    : 'that amount';

  switch (reason) {
    case 'answer_below_threshold':
      return {
        message: `gotchu bro, with ${stated} i wouldn't force the main call yet. better move is the lower-ticket/free route while you build closer to ${thresholdStr}, then we can revisit the full program.`,
        stage: 'FINANCIAL_SCREENING',
        subStage: 'LOW_TICKET'
      };
    case 'answer_total_savings_needs_clarification':
      return {
        message:
          'got it bro, of that amount, how much would you actually be comfortable putting toward your trading education right now?',
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'answer_prop_firm_only':
      return {
        message: `respect bro, prop firms are solid. what i'm asking though is what you personally have set aside on your end, you got ${thresholdStr} ready?`,
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'answer_hedging':
      return {
        message:
          "no stress bro, what's the actual number you're working with right now?",
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'answer_ambiguous':
      return {
        message:
          "gotchu, just so i don't point you wrong, what number are you actually working with for this?",
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'answer_currency_unclear':
      return {
        message: 'is that in USD bro, or a different currency?',
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'answer_vague_capital':
      return {
        message:
          'ballpark is fine bro — like under $500, closer to $1k, or more than that?',
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'asked_but_no_answer':
      return {
        message:
          'just need that capital piece first bro, what are you working with right now?',
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
    case 'never_asked':
    default:
      return {
        message:
          "real quick, what's your capital situation like for the markets right now?",
        stage: 'FINANCIAL_SCREENING',
        subStage: null
      };
  }
}

/**
 * Heuristic: does this LLM response route the lead into booking-handoff
 * messaging? Widened (Fix A, 2026-04-20) after the Nez Futurez incident
 * where `stage='BOOKING'` with `sub_stage=null` bypassed the gate. Fires
 * on ANY of these conditions — one match is enough:
 *
 *   1. `stage === 'BOOKING'` — regardless of sub_stage. If the LLM self-
 *      reports BOOKING, treat it as attempted routing, full stop.
 *   2. `stage === 'SOFT_PITCH_COMMITMENT'` AND the reply contains a URL.
 *      A URL drop at soft-pitch stage IS a booking attempt even when the
 *      LLM didn't promote itself to BOOKING.
 *   3. Reply content matches any handoff / call-pitch phrase — catches
 *      "hop on a quick chat with the closer" at ANY stage including the
 *      early-qualification ones the LLM sometimes mislabels. A
 *      verification question ("you got at least $X ready?") does NOT
 *      match these patterns so it correctly falls through the gate.
 */
export function isRoutingToBookingHandoff(parsed: ParsedAIResponse): boolean {
  // Rule 1: BOOKING stage at any sub_stage.
  if (parsed.stage === 'BOOKING') {
    return true;
  }
  // Rule 2: SOFT_PITCH_COMMITMENT + any URL in the reply body.
  // Look at the JOINED group text so a multi-bubble turn where the URL
  // is in bubble 1 and the pitch is in bubble 0 gets caught as a unit.
  const joinedReply =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  const hasUrl = /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(joinedReply);
  if (parsed.stage === 'SOFT_PITCH_COMMITMENT' && hasUrl) {
    return true;
  }
  // Rule 3: phrase-match handoff / call-pitch language regardless of
  // reported stage. Widened phrase list — catches Nez's "send you the
  // link to apply" at 01:48 plus the soft-pitch "hop on a quick chat
  // with the closer" pattern that doesn't name-check the closer in the
  // existing patterns.
  const handoffPhrases =
    /\b(team\s+(is\s+)?(gonna|going\s+to|will)\s+(reach\s+out|get\s+in\s+touch|contact\s+you|set\s+(you\s+)?up|get\s+you\s+set|be\s+in\s+touch)|check\s+your\s+email\s+for\s+(the|your)\s+(call|confirmation|zoom|invite)|you'?re\s+all\s+set|locked\s+in\s+for|call\s+confirmation|send(ing)?\s+you\s+(the|a)\s+link\s+(to|for)\s+(apply|book|grab|schedule)|here'?s\s+the\s+link|hop\s+on\s+a\s+(quick\s+)?(call|chat)|get\s+you\s+(all\s+)?set\s+up|link\s+to\s+(book|apply|grab|schedule)|gonna\s+send\s+you\s+the\s+link|fill\s+(it\s+|everything\s+)?out\s+and\s+(lmk|let\s+me\s+know)|ready\s+to\s+scale\s+up.*call|break\s+everything\s+down\s+for\s+you)\b/i;
  return handoffPhrases.test(joinedReply);
}

/**
 * Fix B — content-level advancement detection, independent of what the
 * LLM self-reports for `stage`. An implicit "let me get you on a call
 * with the closer" pitched at stage=SITUATION_DISCOVERY is still an
 * advancement attempt and must hit the capital gate. Wider net than
 * `isRoutingToBookingHandoff` so it catches LLM outputs that mislabel
 * their stage.
 *
 * Fires on any of:
 *   - Reported stage in the advancement set (BOOKING,
 *     SOFT_PITCH_COMMITMENT, FINANCIAL_SCREENING)
 *   - Content matches a pitch / handoff / book-the-call phrase
 *
 * Returns false for verification questions ("you got at least $X?")
 * and for normal qualification Q&A.
 */
export function detectBookingAdvancement(
  parsed: ParsedAIResponse,
  closerNames: string[] = []
): boolean {
  const stage = (parsed.stage || '').toUpperCase();
  if (
    stage === 'BOOKING' ||
    stage === 'SOFT_PITCH_COMMITMENT' ||
    stage === 'FINANCIAL_SCREENING'
  ) {
    return true;
  }
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  // Content phrase list — tuned to Daniel's script patterns.
  // Includes "right hand man" / closer-name mentions because the AI
  // frequently pitches the call by name-checking the closer.
  const advancementPhrases: RegExp[] = [
    /\bhop\s+on\s+a\s+(quick\s+)?(call|chat)\b/i,
    /\bget\s+you\s+on\s+a\s+(quick\s+)?(call|chat)\b/i,
    /\bsend(ing)?\s+you\s+the\s+link\b/i,
    /\blink\s+to\s+(apply|book|grab|schedule)\b/i,
    /\bfill\s+(it\s+|everything\s+)?out\b/i,
    /\bset\s+(it\s+|you\s+)?up\s+with\b/i,
    /\bbreak\s+everything\s+down\s+for\s+you\b/i,
    /\bright\s+hand\s+man\b/i,
    /\bready\s+to\s+(scale|level)\s+up\b/i,
    /\bgonna\s+send\s+you\s+the\s+link\b/i,
    /\bhere'?s\s+the\s+link\b/i,
    /\b(you'?re\s+)?all\s+set\b/i
  ];
  if (advancementPhrases.some((p) => p.test(joined))) return true;
  // Closer-name mentions combined with call-arrangement language.
  // Fires when the LLM says "chat with {closerName}" or similar at
  // ANY stage — Daniel's AI has pitched closer-name calls at OPENING before.
  for (const name of closerNames) {
    if (!name || name.trim().length < 2) continue;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(
      `\\b(call|chat|hop\\s+on.*|set\\s+(it|you)\\s+up|link.*apply|link.*book|get\\s+you\\s+set).*${escaped}|${escaped}.*\\b(call|chat|reach\\s+out|gonna\\s+contact|get\\s+in\\s+touch)\\b`,
      'i'
    );
    if (pat.test(joined)) return true;
  }
  return false;
}

interface CapitalVerificationBlockResult {
  blocked: boolean;
  reason:
    | 'no_threshold_configured'
    | 'already_verified'
    | 'verified_in_history'
    | 'not_advancing'
    | 'capital_not_verified_before_advancement';
}

/**
 * Fix B — advancement-gate. Independent of R24's `isRoutingToBooking
 * Handoff` trigger: fires on ANY AI response that attempts to advance
 * the lead toward booking, regardless of how the LLM labeled its
 * stage. Skips when:
 *   - No capital threshold configured on the persona
 *   - A prior BookingRoutingAudit already recorded routingAllowed=true
 *     for this conversation (the lead was verified once, we don't
 *     re-gate every subsequent advancement attempt)
 *   - The capital question has been asked AND the lead's answer maps
 *     to `confirmed_amount` / `confirmed_affirmative` per the existing
 *     R24 classifier
 * Blocks when the response advances toward booking AND none of the
 * skip conditions apply. Caller is expected to inject a directive and
 * regenerate, identical in shape to R24's `never_asked` flow.
 */
async function shouldBlockForCapitalVerification(params: {
  parsed: ParsedAIResponse;
  conversationId: string;
  accountId?: string | null;
  capitalThreshold: number | null;
  capitalCustomPrompt: string | null;
  closerNames?: string[];
  currentTurnLeadMsg?: {
    sender?: string;
    content: string;
    timestamp: Date | string;
  };
}): Promise<CapitalVerificationBlockResult> {
  const {
    parsed,
    conversationId,
    accountId,
    capitalThreshold,
    capitalCustomPrompt,
    currentTurnLeadMsg
  } = params;
  if (typeof capitalThreshold !== 'number' || capitalThreshold <= 0) {
    return { blocked: false, reason: 'no_threshold_configured' };
  }
  // Short-circuit 1: prior routingAllowed=true audit for this convo
  // means the lead has passed R24 at least once. Don't re-gate further
  // advancement attempts (Daniel's script may pitch twice, confirm
  // email, etc. — we don't want to spam-block the follow-up turns).
  const prior = await prisma.bookingRoutingAudit.findFirst({
    where: { conversationId, routingAllowed: true },
    select: { id: true }
  });
  if (prior) {
    return { blocked: false, reason: 'already_verified' };
  }
  // Short-circuit 2: run the existing R24 classifier against history.
  // If the lead has stated an adequate amount or affirmed the
  // threshold-Q, treat as verified even without a prior audit row.
  // Pass the current-turn LEAD message so the classifier sees it
  // regardless of DB-snapshot timing.
  const r24 = await checkR24Verification(
    conversationId,
    accountId,
    capitalThreshold,
    capitalCustomPrompt,
    currentTurnLeadMsg
  );
  if (
    !r24.blocked &&
    (r24.reason === 'confirmed_amount' ||
      r24.reason === 'confirmed_affirmative' ||
      r24.reason === 'durable_qualification_state')
  ) {
    return { blocked: false, reason: 'verified_in_history' };
  }
  // Check the current response for advancement. If yes → block.
  if (detectBookingAdvancement(parsed, params.closerNames ?? [])) {
    return { blocked: true, reason: 'capital_not_verified_before_advancement' };
  }
  return { blocked: false, reason: 'not_advancing' };
}

// ---------------------------------------------------------------------------
// Booking-state fabrication detector
// ---------------------------------------------------------------------------
// Daniel's system does NOT auto-book calls. The booking flow is: AI drops
// the script's booking link → lead clicks it → books themselves → team
// handles the actual call externally. There is no "anthony is on the call
// shortly" mechanism, no real-time zoom link dispatch, no automatic
// calendar-invite send.
//
// Incident driving this gate: Rufaro (daetradez, 2026-04-18) — AI said
// "anthony will be on the call with you shortly. check your email for
// the confirmation and the zoom link." Pure fabrication. R19 (never
// fabricate completed actions) was live at the prompt level but the LLM
// ignored it. This gate is the code-level enforcement.
//
// Fires when: response matches a fabrication pattern AND the conversation
// has no real scheduledCallAt + no real bookingId. Skips entirely when a
// real booking exists — the AI CAN reference a call that's actually
// scheduled.
// ---------------------------------------------------------------------------

const BOOKING_FABRICATION_PATTERNS: RegExp[] = [
  // "anthony will be on the call shortly" / "X is going to be on..."
  // and closer-name variants. Replaced `{{closerName}}` in the original
  // spec with an any-name pattern — we check both "anthony" and the
  // persona's configured closer names via caller.
  /\b(anthony|your\s+closer|the\s+closer|my\s+partner|our\s+closer)\s+(will\s+be|is\s+going\s+to\s+be|is)\s+(on\s+the\s+call|in\s+the\s+call|ready|waiting|standing\s+by|available)\s*(shortly|soon|now|with\s+you|momentarily|for\s+you)?\b/i,
  /\b(check\s+your\s+(email|inbox)|keep\s+an\s+eye\s+on\s+(your\s+)?email)\s+(for|to\s+see)\s+(the|your|a)?\s*(confirmation|zoom|link|invite|call\s+details)/i,
  /\byou'?re\s+all\s+set\s+for\s+(the|your|our)\s+(call|meeting|chat)\b/i,
  /\b(calendar|zoom|meeting|google\s+meet)\s+(invite|link|confirmation)\s+(is|has\s+been|will\s+be)?\s*(on\s+the\s+way|sent|coming|being\s+sent|in\s+your\s+inbox)/i,
  /\b(I'?ll|let\s+me|lemme|gonna|going\s+to)\s+(send|get|grab|share|drop)\s+(you\s+)?(the|that|your|a)\s*(zoom|meeting|call)\s+(link|invite|url)\b/i,
  /\bjump\s+on\s+(the\s+call|a\s+call|it)\s+(now|right\s+now|real\s+quick)\b/i,
  /\b(booked|locked)\s+(you\s+)?in\s+(for|with)\b/i,
  /\bexpect\s+(the\s+)?(zoom|meeting|calendar|confirmation)\s+(link|invite)\s+(shortly|soon|any\s+minute)/i
];

export function matchesBookingFabrication(
  reply: string,
  closerNames: string[] = []
): boolean {
  if (BOOKING_FABRICATION_PATTERNS.some((p) => p.test(reply))) return true;
  // Closer-name-specific patterns: "{closerName} will be on the call",
  // "{closerName} is ready now", etc. Run dynamically for each
  // configured closer name the persona has.
  for (const name of closerNames) {
    if (!name || name.trim().length < 2) continue;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(
      `\\b${escaped}\\s+(will\\s+be|is\\s+going\\s+to\\s+be|is)\\s+(on\\s+the\\s+call|in\\s+the\\s+call|ready|waiting|standing\\s+by|available)`,
      'i'
    );
    if (pat.test(reply)) return true;
  }
  return false;
}

interface BookingFabricationBlockResult {
  blocked: boolean;
  reason: 'no_real_booking' | 'real_booking_exists' | 'no_fabrication';
}

/**
 * Fix (2026-04-20) — fabrication gate. Runs on every AI response.
 * Mirrors the shape of shouldBlockForCapitalVerification.
 *
 * Blocks when:
 *   1. The reply claims real-time booking state (matches a pattern)
 *   2. The conversation has NO actual scheduledCallAt set
 *   3. The conversation has NO bookingId from a calendar integration
 *
 * Skips (returns blocked=false) when:
 *   - No fabrication pattern matched → no risk
 *   - A real booking/scheduled call exists → the AI can legitimately
 *     reference it
 */
async function shouldBlockForBookingFabrication(params: {
  parsed: ParsedAIResponse;
  conversationId: string;
  closerNames?: string[];
}): Promise<BookingFabricationBlockResult> {
  const { parsed, conversationId, closerNames = [] } = params;
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  if (!matchesBookingFabrication(joined, closerNames)) {
    return { blocked: false, reason: 'no_fabrication' };
  }
  // Fabrication pattern matched — check for a real booking.
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { scheduledCallAt: true, bookingId: true }
  });
  if (!conv) {
    // Defensive: treat as no-booking-exists if we can't read the row.
    return { blocked: true, reason: 'no_real_booking' };
  }
  if (conv.scheduledCallAt || conv.bookingId) {
    return { blocked: false, reason: 'real_booking_exists' };
  }
  return { blocked: true, reason: 'no_real_booking' };
}

interface ParsedCapitalAmount {
  amount: number;
  currency: ConversationCurrency | null;
}

const CURRENCY_DETECTORS: Array<{
  currency: ConversationCurrency;
  patterns: RegExp[];
}> = [
  {
    currency: 'ZAR',
    patterns: [/\bR\s*\d/, /\b(rand|zar|south african)\b/i, /\d\s*ZAR\b/i]
  },
  {
    currency: 'NGN',
    patterns: [/₦/, /\b(naira|ngn)\b/i, /\bN\s*\d{4,}/, /\d\s*NGN\b/i]
  },
  {
    currency: 'GHS',
    patterns: [/₵/, /\b(cedi|ghs)\b/i, /\d\s*GHS\b/i]
  },
  {
    currency: 'KES',
    patterns: [/\b(ksh|kes|kenyan shilling)\b/i, /\d\s*KES\b/i]
  },
  {
    currency: 'PHP',
    patterns: [/₱/, /\b(php|peso)\b/i, /\d\s*PHP\b/i]
  },
  {
    currency: 'UGX',
    patterns: [/\b(ugx|ugandan shilling)\b/i, /\d\s*UGX\b/i]
  },
  {
    currency: 'EUR',
    patterns: [/€/, /\b(eur|euro)\b/i, /\d\s*EUR\b/i]
  },
  {
    currency: 'CAD',
    patterns: [
      /\bCAD\b/i,
      /\bC\$\s*\d/i,
      /\d\s*CAD\b/i,
      /\bcanadian\s+(dollars?|dollar)\b/i,
      /\bin\s+canadian\b/i
    ]
  },
  {
    currency: 'GBP',
    patterns: [/£/, /\b(gbp|pounds?|quid)\b/i, /\d\s*GBP\b/i]
  },
  // AUD/NZD listed BEFORE USD so the bare "$5000" check doesn't
  // pre-empt the more specific A$/NZ$ shapes. The USD detector still
  // owns plain "$" and the word "dollars?".
  {
    currency: 'AUD',
    patterns: [
      /\bAUD\b/i,
      /\bA\$\s*\d/i,
      /\d\s*AUD\b/i,
      /\b(aussie\s+dollars?|australian\s+dollars?)\b/i
    ]
  },
  {
    currency: 'NZD',
    patterns: [
      /\bNZD\b/i,
      /\bNZ\$\s*\d/i,
      /\d\s*NZD\b/i,
      /\b(kiwi\s+dollars?|new\s+zealand\s+dollars?)\b/i
    ]
  },
  {
    currency: 'USD',
    patterns: [/\$\s*\d/, /\b(usd|us dollars?|dollars?)\b/i, /\d\s*USD\b/i]
  }
];

export function detectCurrencyFromText(
  text: string | null | undefined
): ConversationCurrency | null {
  if (!text) return null;
  for (const detector of CURRENCY_DETECTORS) {
    if (detector.patterns.some((pattern) => pattern.test(text))) {
      return detector.currency;
    }
  }
  return null;
}

function detectCurrencyFromTexts(
  texts: Array<string | null | undefined>
): ConversationCurrency | null {
  for (const text of texts) {
    const currency = detectCurrencyFromText(text);
    if (currency) return currency;
  }
  return null;
}

/**
 * Extract a capital amount from a free-form lead reply. Handles
 * "$5k", "£1,000", "R2000", "₦200,000", "5,000", "around 500",
 * bare-number strings, and the "5k"/"2.5k" shorthand. Returns null
 * when no number is present.
 *
 * Bug fix (Tahir Khan false-positive, 2026-04-20): the previous regex
 * non-captured the decimal part, so "2.5k" parsed as 2000 instead of
 * 2500 (the `.5` was dropped before the k-multiplier). Now we capture
 * the decimal and use parseFloat, multiplying by 1000 for the k suffix.
 */
// Time-expression patterns stripped from the input before the
// capital-amount regex runs. Wout Lngrs 2026-05-01: "Yeah 12am is
// perfect" got parsed as 12 because the bare-number regex matched
// the leading "12" of "12am". Time tokens have nothing to do with
// capital, so strip them outright. Order matters — the most-specific
// pattern (HH:MM[am|pm]) runs first so its colon doesn't survive
// into the simpler patterns.
const TIME_PATTERNS_TO_EXCLUDE: RegExp[] = [
  /\b\d{1,2}:\d{2}\s*(am|pm)?\b/gi, // "9:30am", "14:00"
  /\b\d{1,2}\s*(am|pm)\b/gi, // "12am", "3 pm"
  /\bin\s+\d{1,2}\s*hours?\b/gi, // "in 12 hours"
  /\b\d{1,2}\s*hour\s*ago\b/gi, // "2 hour ago"
  /\b\d{1,2}\s*hours?\b/gi, // "12 hours", "2 hours"
  /\b\d{1,2}\s*o['’]clock\b/gi // "5 o'clock"
];

function stripTimeExpressions(text: string): string {
  let out = text;
  for (const re of TIME_PATTERNS_TO_EXCLUDE) {
    out = out.replace(re, ' ');
  }
  return out;
}

function parseLeadAmountDetailsFromReply(
  text: string
): ParsedCapitalAmount | null {
  // Detect currency on the ORIGINAL text — currency words like
  // "naira" / "USD" can appear next to a time but the time itself
  // never carries a currency signal, so this stays correct.
  const currency = detectCurrencyFromText(text);
  // Strip time expressions before the amount regex runs. Replaces
  // matched substrings with a space so word boundaries are preserved
  // (e.g. "yeah 12am perfect" → "yeah  perfect", and the bare-number
  // regex finds nothing to latch onto).
  const cleaned = stripTimeExpressions(text);
  // Match optional currency symbol/letter prefix, integer portion
  // (thousands-commas OR plain digits), optional decimal portion,
  // optional k/K suffix. Currency conversion is applied at the
  // threshold-comparison layer, not here.
  const m = cleaned.match(
    /(?:[$£€₦₵₱]|C\$|R|N)?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([kK])?/
  );
  if (!m) return null;
  const intPart = m[1].replace(/,/g, '');
  const decPart = m[2] ?? '';
  let amount = parseFloat(intPart + decPart);
  if (!Number.isFinite(amount)) return null;
  if (m[3]) amount *= 1000; // "5k" → 5000, "2.5k" → 2500
  return {
    amount: Math.round(amount),
    currency
  };
}

function parseLeadAmountFromReply(text: string): number | null {
  return parseLeadAmountDetailsFromReply(text)?.amount ?? null;
}

/**
 * Classify a lead's reply to a capital question into one of five
 * kinds. Order matters: disqualifiers ("broke", "no money", "I'm a
 * student") take precedence over amount parsing, so "I got nothing, bro"
 * classifies as disqualifier even if a stray number could be extracted.
 * Hedging without a number comes next. Amount parsing fires if none
 * of the above matched. Then affirmative (for back-compat with the
 * legacy "you got at least $X?" Q). Anything else → ambiguous.
 */
interface ParsedLeadAnswer {
  kind: 'amount' | 'disqualifier' | 'hedging' | 'affirmative' | 'ambiguous';
  amount: number | null;
  /** Currency explicitly detected in this answer. Undefined/null means USD/default. */
  currency?: ConversationCurrency | null;
  /**
   * Optional fine-grained reason — lets callers pick a more specific
   * override directive when regenerating. Set for the prop-firm
   * edge case so the directive can ask for PERSONAL capital
   * specifically rather than a generic clarifier.
   */
  reason?:
    | 'prop_firm_mentioned_no_personal_capital_stated'
    | 'total_savings_or_financial_stress'
    | 'no_pattern_matched'
    | 'generic'
    | 'vague_no_number';
}

// Explicit capital-constraint signals. These are not hedges and do
// not need a follow-up capital verification question. If the lead says
// capital is the problem, R24 treats that as "no investable capital
// right now" and routes to downsell / free resources.
const EXPLICIT_CAPITAL_CONSTRAINT_PATTERNS: RegExp[] = [
  /\bcapital\b.{0,30}\b(problem|issue|obstacle|holding|stopping|lack|don.?t have)\b/i,
  /\b(lack of|no)\s+capital\b/i,
  /\bdon'?t\s+have\s+(any\s+)?capital\b/i,
  /\bneed\s+(to\s+(get|raise|build)\s+)?capital\s+first\b/i,
  /\bcapital\b.{0,20}\bknowledge\b/i
];

export function hasExplicitCapitalConstraintSignal(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return EXPLICIT_CAPITAL_CONSTRAINT_PATTERNS.some((p) => p.test(text));
}

function getJsonStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const raw = record[key];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function buildExplicitCapitalConstraintSoftExit(
  persona: {
    freeValueLink?: string | null;
    downsellConfig?: Prisma.JsonValue | null;
    promptConfig?: Prisma.JsonValue | null;
  } | null
): string {
  const downsell = persona?.downsellConfig;
  const promptConfig = persona?.promptConfig;
  const downsellPitch = getJsonStringField(downsell, 'pitchMessage');
  const downsellLink = getJsonStringField(downsell, 'link');
  const youtubeUrl =
    persona?.freeValueLink?.trim() ||
    getJsonStringField(promptConfig, 'youtubeFallbackUrl') ||
    getJsonStringField(promptConfig, 'freeValueLink');

  if (downsellPitch) {
    return downsellLink ? `${downsellPitch} ${downsellLink}` : downsellPitch;
  }

  if (youtubeUrl) {
    return `love the honesty bro, where you're at right now the best move is to build the knowledge base first. start here for free: ${youtubeUrl}. when you're in a better spot financially hit me up and we'll get you set up properly`;
  }

  return "love the honesty bro, where you're at right now the best move is to build the knowledge base first. when you're in a better spot financially hit me up and we'll get you set up properly";
}

// Vague non-answers to a capital question — phrases that DON'T name a
// number but pretend to. Lead said "starting with a manageable
// amount" / "saving up" / "working on it" — needs a specific probe.
// Distinct from the disqualifier set ("not much", "broke") because
// the lead may genuinely have capital but is dodging the dollar
// figure. First occurrence → ask the ballpark probe (FIX 1). Second
// occurrence → checkR24Verification routes below_threshold via the
// 2-evasions guard (FIX 3). Amos Edoja 2026-04-30.
const VAGUE_CAPITAL_PATTERNS: RegExp[] = [
  /\b(manageable|enough\s+to\s+start|something\s+small|small\s+amount|modest|decent\s+amount|reasonable\s+amount)\b/i,
  /\bstarting\s+(out\s+)?(with|on)\s+(a\s+)?(manageable|small|modest|little|bit)\b/i,
  /\b(i'?ll\s+figure\s+it\s+out|i'?m\s+(working\s+on|building|saving|figuring))\b/i,
  /\b(plan\s+to|hoping\s+to|tryna|trying\s+to)\s+(get|save|build|raise)\s+(more|up|enough|the\s+capital)?\b/i,
  // Steven Biggam 2026-04-30: "very little tbh" needs to land here so
  // we probe with the multi-anchor question instead of falling
  // through to the generic ambiguous path. Same intent as the older
  // disqualifier set ("not much"), but kept in vague rather than
  // disqualifier so the lead gets ONE chance to name a number before
  // we route them to downsell.
  /\b(very\s+little|barely\s+anything|hardly\s+anything|next\s+to\s+nothing|barely\s+any|tiny\s+bit|not\s+much\s+tbh|not\s+a\s+lot\s+tbh)\b/i
];

function looksLikeVagueCapitalAnswer(text: string): boolean {
  for (const p of VAGUE_CAPITAL_PATTERNS) {
    if (p.test(text)) return true;
  }
  return false;
}

// Pre-objection patterns (Steven Biggam 2026-04-30). Lead pre-emptively
// flags concern about being asked for a lot of money. Asking the
// capital question without acknowledging the concern reads tone-deaf
// and tanks rapport. Caller (R24 directive layer) prepends a one-line
// reassurance before the probe; voice gate fires a soft signal if the
// reassurance is missing.
const CAPITAL_PRE_OBJECTION_PATTERNS: RegExp[] = [
  /\b(red\s+flag|red[-\s]?flag)\b/i,
  // "wanna" already implies "to" — the literal "to" is optional.
  /\bdon'?t\s+(want|wanna)\s+(to\s+)?(spend|invest|put\s+(in|down))\s+(much|a\s+lot|too\s+much)\b/i,
  /\bdon'?t\s+have\s+much\s+to\s+(invest|spend|put\s+(in|down))\b/i,
  /\b(i'?m|im)\s+on\s+a\s+(tight\s+)?budget\b/i,
  /\banyone\s+(asking|wants?|charging)\s+for\s+a\s+lot\b/i,
  /\b(sketchy|scam|sus|too\s+expensive|overpriced)\b/i,
  /\bnot\s+(trying|looking|trynna)\s+to\s+(spend|drop|invest)\s+(a\s+lot|much|big)\b/i
];

export function leadHasPreObjectedToCapital(
  recentLeadMessages: string[]
): boolean {
  const window = recentLeadMessages.slice(-4);
  for (const msg of window) {
    if (typeof msg !== 'string') continue;
    for (const p of CAPITAL_PRE_OBJECTION_PATTERNS) {
      if (p.test(msg)) return true;
    }
  }
  return false;
}

// Reassurance phrases — the AI's response counts as "addressed" the
// pre-objection if any of these (or the exact reassurance line from
// the directive) appear.
const REASSURANCE_PHRASES_RE =
  /\b(no\s+pressure|not\s+(here\s+to\s+)?pressure|not\s+pushing|nah\s+bro\s+(i'?m|im)\s+not\s+here|just\s+need\s+to\s+know\s+(what|where)|point\s+you\s+in\s+the\s+right\s+direction|no\s+stress|chill\s+bro|not\s+forcing|not\s+(trying|trynna)\s+to\s+sell\s+you)\b/i;

export function aiResponseAddressesPreObjection(text: string): boolean {
  return REASSURANCE_PHRASES_RE.test(text);
}

// Prop-firm phrase list. Lead responses that reference a prop firm but
// don't clearly state personal capital need a clarifying follow-up
// because firm capital !== personal capital — the $1k-$100k the lead
// "has" via an FTMO / Apex / Topstep challenge is the FIRM's money.
// See Tahir 2026-04-20 incident.
const PROP_FIRM_PATTERN =
  /\b(prop\s+firm|funded\s+account|funded\s+trader|ftmo|apex|topstep|the5ers|my\s+funded|firm'?s?\s+capital|firm\s+account|prop\s+challenge|challenge\s+account|funded\s+challenge|evaluation\s+account|\$k?\s*challenge|10k\s+challenge|25k\s+challenge|50k\s+challenge|100k\s+challenge|200k\s+challenge)\b/i;

// Personal-capital indicators: when these appear alongside a prop-firm
// mention, the number in the message is more likely tied to personal
// savings than firm capital ("Yeah I got 4k plus my prop firm" → 4k
// is personal). Without these, prop-firm + number classifies as
// ambiguous with the prop-firm reason.
const PERSONAL_CAPITAL_INDICATOR =
  /\b(i\s+(have|got|saved|put|set)|i'?ve\s+(got|saved|put|set)|my\s+(savings|personal|own|capital|money|side))\b/i;
const PLUS_PHRASE =
  /\b(plus|also|on\s+top\s+of|besides|separate\s+from|aside\s+from|in\s+addition\s+to|as\s+well\s+as)\b/i;

// Below-threshold hedge prefix (SMOKE 12, 2026-05-04). Lead says
// "less than $1000" / "under $500" / "below $200" — they are stating
// they have BELOW that figure, not that figure exactly. Without this
// guard the amount-fast-path would extract the number verbatim and
// the threshold gate would treat the lead as having it (e.g. "Less
// than $1000, I'm tryna at least start with $1000 or more" was being
// classified as amount=1000, passing a $1000 threshold). Requires the
// hedge to sit directly before a numeric token (with optional
// approximator / currency symbol) so phrases like "less than two
// hours" or "barely have time" don't trip it.
const BELOW_THRESHOLD_HEDGE_PATTERN =
  /\b(less\s+than|under|below|fewer\s+than|barely|not\s+even)\s+(?:about\s+|around\s+|roughly\s+|maybe\s+|like\s+)?(?:\$|us\$|usd\s*|dollars?\s*|€|£|₦|₱|₹)?\s*\d/i;

function capitalNumberNeedsComfortClarification(text: string): boolean {
  const totalSavingsContext =
    /\b((in|from|out\s+of|my|our|total)\s+savings?|savings?\s+(left|total)|all\s+(we|i)\s+(have|got)|everything\s+(we|i)\s+(have|got)|total\s+(savings?|money|funds?)|only\s+(savings?|money|funds?))\b/i;
  const financialStressContext =
    /\b(tight\s+on\s+funds|really\s+tight|struggling|struggle|hard\s+right\s+now|difficult\s+right\s+now|lost\s+my\s+job|no\s+job|unemployed|laid\s+off|new\s+baby|had\s+a\s+baby|wife|family|rent|bills?)\b/i;
  const explicitlyInvestable =
    /\b(set\s+aside|put\s+aside|ready|available|towards?\s+(trading|the\s+markets?|education|this)|for\s+(trading|the\s+markets?|education|this)|trading\s+capital|capital\s+ready)\b/i;

  if (explicitlyInvestable.test(text)) return false;

  return totalSavingsContext.test(text) || financialStressContext.test(text);
}

// ─── Geography gate ────────────────────────────────────────────
// Funding-partner (FTMO-style funded account) programs only accept
// leads in the US and Canada. When the lead mentions living anywhere
// else, the R24 downsell path must skip the funding-partner option
// and go straight to the $497 course or YouTube redirect. The gate
// has two sources of truth, in priority order:
//   1. `leadContext.geography` — explicit enrichment (if populated)
//   2. Message-text detection against the two regex below

// US/CA positive signal — matches when lead states they're in a
// compatible jurisdiction. Wins over a restricted-country match if
// both appear (e.g., "I'm in the US now, originally from Lebanon").
const US_CA_GEO_INDICATOR =
  /\b(united\s+states|u\.s\.a?\.?|\busa\b|\bus\b(?!\s+(trading|strategy|prop|broker))|america|american|new\s+york|california|texas|florida|canada|canadian|toronto|vancouver|montreal|ontario|quebec|alberta)\b/i;

// Restricted-country list. Not exhaustive — covers the common
// jurisdictions US funding-partner programs won't onboard. When
// matched (and US/CA is NOT), route to downsell/YouTube, NEVER
// funding partner.
const RESTRICTED_COUNTRY_PATTERN =
  /\b(lebanon|lebanese|nigeria|nigerian|zimbabwe|philippines|filipino|pilipinas|manila|cebu|davao|luzon|mindanao|pakistan|pakistani|\bindia\b|indian|bangladesh|bangladeshi|egypt|egyptian|kenya|kenyan|ghana|ghanaian|cameroon|cameroonian|south\s+africa|south\s+african|zambia|uganda|tanzania|morocco|moroccan|iran|iranian|iraq|iraqi|syria|syrian|yemen|yemeni|sudan|sudanese|afghanistan|afghan|belarus|belarusian|russia|russian|venezuela|venezuelan|cuba|cuban|north\s+korea|myanmar|burmese|vietnam|vietnamese|cambodia|laos|mongolia|kazakhstan|uzbekistan|ethiopia|ethiopian|somalia|libya|algeria|algerian|tunisia|brazil|brazilian|argentina|argentine|colombia|colombian|peru|peruvian|chile|chilean|uruguay|ecuador|uk|britain|british|england|english|scotland|scottish|ireland|irish|germany|german|france|french|spain|spanish|italy|italian|portugal|portuguese|netherlands|dutch|belgium|belgian|sweden|swedish|norway|norwegian|finland|finnish|denmark|danish|poland|polish|czech|slovakia|hungary|hungarian|romania|romanian|bulgaria|bulgarian|greece|greek|turkey|turkish|ukraine|ukrainian|australia|australian|new\s+zealand|japan|japanese|south\s+korea|korean|china|chinese|hong\s+kong|taiwan|taiwanese|singapore|singaporean|malaysia|malaysian|indonesia|indonesian|thailand|thai|east\s+african\s+time|nairobi|kampala|dar\s+es\s+salaam|addis\s+ababa)\b/i;

const EAST_AFRICA_TIME_ABBR_PATTERN = /\bEAT\b/;

const FUNDING_PARTNER_ROUTE_PATTERN =
  /\b(funding\s+partner|funded[-\s]+account|funded[-\s]+trader|funding\s+(route|option|program|path)|prop\s+firm|prop[-\s]+firm|prop\s+challenge|challenge\s+account|funded\s+challenge|third[-\s]+party\s+capital|firm\s+capital|ftmo|apex|topstep|the\s*5ers|my\s+forex\s+funds)\b/i;

function mentionsFundingPartnerRoute(parsed: ParsedAIResponse): boolean {
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  return FUNDING_PARTNER_ROUTE_PATTERN.test(joined);
}

/**
 * Return whether the lead should be blocked from the funding-partner
 * branch based on geography. Caller (R24 retry-loop) appends an
 * addendum to the downsell directive when restricted.
 *
 *   restricted=true  → DO NOT offer funding partner, only $497 / YT
 *   restricted=false → current behavior (eligible or unknown)
 */
export function detectRestrictedGeography(
  leadCountry: string | null | undefined,
  recentLeadMessages: string[]
): { country: string | null; restricted: boolean } {
  // Primary: explicit enrichment. US/USA/Canada/CA are the only
  // allowed strings; any other value is treated as restricted.
  const enriched = (leadCountry || '').trim();
  if (enriched.length > 0) {
    const lower = enriched.toLowerCase();
    if (
      /^(us|usa|u\.s\.a?\.?|united\s+states|america|canada|ca|canadian)$/i.test(
        lower
      )
    ) {
      return { country: enriched, restricted: false };
    }
    return { country: enriched, restricted: true };
  }

  // Secondary: message-text detection. US/CA mention wins if both
  // appear. Only the lead's OWN messages are scanned (AI messages
  // may mention countries in examples / follow-ups without being
  // diagnostic of the lead's actual location).
  const joined = recentLeadMessages.join('\n');
  const usCaMatch = joined.match(US_CA_GEO_INDICATOR);
  if (usCaMatch) {
    return { country: usCaMatch[0], restricted: false };
  }
  const restrictedMatch = joined.match(RESTRICTED_COUNTRY_PATTERN);
  if (restrictedMatch) {
    return { country: restrictedMatch[0], restricted: true };
  }
  const eastAfricaTimeMatch = joined.match(EAST_AFRICA_TIME_ABBR_PATTERN);
  if (eastAfricaTimeMatch) {
    return { country: eastAfricaTimeMatch[0], restricted: true };
  }

  // Unknown → don't restrict. Keeps current behavior for leads
  // whose location hasn't been stated in-chat or enriched. Safer
  // than defaulting to "restricted" which would block US/CA leads
  // who just haven't mentioned it yet.
  return { country: null, restricted: false };
}

export function parseLeadCapitalAnswer(raw: string): ParsedLeadAnswer {
  const text = raw.trim();
  const parsedAmountDetails = parseLeadAmountDetailsFromReply(text);
  const parsedAmount = parsedAmountDetails?.amount ?? null;
  const parsedCurrency = parsedAmountDetails?.currency ?? null;

  if (parsedAmount !== null && capitalNumberNeedsComfortClarification(text)) {
    return {
      kind: 'ambiguous',
      amount: parsedAmount,
      currency: parsedCurrency,
      reason: 'total_savings_or_financial_stress'
    };
  }

  // 1. Non-numeric disqualifiers — handle first so "I got nothing" doesn't
  //    get amount-parsed into some weird accidental hit. Split across
  //    themed groups so each signal type is self-documenting:
  //      (a) "low capital" baseline ("broke", "no money", "student")
  //      (b) "no job / no income" employment disqualifiers
  //      (c) "desperation / last hope" language — trader-of-last-resort
  //          framing is a strong R24 stop even without an explicit number
  //      (d) "can't pay basics" financial distress
  //      (e) "capital access" issues — lead has money but can't route
  //          it (business failing, sanctions, bank blocks, geopolitics).
  //          Distinct from (a) because they might technically have the
  //          amount but it's unreachable; treat as disqualifier anyway
  //          because funding-partner + prop-firm paths all require the
  //          capital to actually be usable.
  const noCapital =
    /\b(not\s+much|not\s+a\s+lot|nothing\s+really|^nothing\b|\bbroke\b|don'?t\s+have\s+(any\s+)?(money|capital|anything|much)|can'?t\s+afford|no\s+money|i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school)\b/i;
  const jobless =
    /\b(jobless|job less|unemployed|no job|lost my job|between jobs|laid off|let go|no income|no work|out of work)\b/i;
  const desperation =
    /\b(only hope|last hope|last chance|desperate|nothing left)\b/i;
  const cantAffordBasics =
    /\b(can'?t eat|can'?t pay rent|can'?t pay bills|struggling to survive)\b/i;
  const capitalAccessIssue =
    /\b(can'?t\s+fund\s+(my\s+|the\s+)?account|business\s+(is\s+)?(failing|failed|going\s+under|closing\s+down)|my\s+business\s+(is\s+)?(failing|failed|down|going\s+under|closing)|geopolitical\s+(restrictions?|issues?)|can'?t\s+transfer\s+(money|funds|anything)|under\s+sanctions?|sanctioned\s+(country|region)|economic\s+sanctions?|bank\s+(blocks?|blocked\s+me|won'?t\s+let\s+me)|my\s+country\s+(is\s+)?sanctioned|payment\s+(blocked|restricted|frozen))\b/i;
  // (f) "Need time to raise / working on it" — explicit present-tense
  // "I don't have it now, will need to build it up". Selorm Benjamin
  // Workey 2026-04-24: "Honestly, I've lost so much in this few days
  // and I will need sometime to raise that fund bro" — the old parser
  // hit the default fallback and returned `ambiguous no_pattern_matched`,
  // which kept the lead out of the disqualifier path. These phrases
  // are unambiguously "not right now" — route to downsell, don't ask
  // a clarifying question.
  const needTimeToRaise =
    /\b(need\s+(some\s+)?time\s+to\s+(raise|save|get|build(\s+up)?|come\s+up\s+with)|will\s+(need|have)\s+to\s+(raise|save|build(\s+up)?)|need\s+to\s+(raise|save|build(\s+up)?)\s+(that|the|some|enough|more|up\s+the)?\s*(fund(s)?|capital|money|amount|cash)|working\s+on\s+(raising|saving|getting|building(\s+up)?)\s+(it|the|that|the\s+capital|the\s+money|the\s+funds?)|don'?t\s+have\s+(it|that|the\s+money|the\s+capital)\s+(right\s+)?now\s+but|gotta\s+(save|raise|build)\s+(up\s+)?(first|the\s+(money|capital|funds?)))\b/i;
  // (f2) "I don't have it" and "1000usd is huge money here" forms.
  // Ptr Alvin 2026-04-26: "here 1000usd it's a huge money" after
  // saying he did not have it got amount-parsed as 1000 and incorrectly
  // passed. A threshold number framed as huge/unreachable is a capital
  // miss unless the same message clearly says they have it ready.
  const lacksReferencedAmount =
    /\b(i\s+)?(don'?t|do\s+not|doesn'?t|can'?t|cannot)\s+(have|afford|get|do|manage)\s+(it|that|this|the\s+(money|capital|funds?|amount)|\$?\d)\b/i;
  const amountIsHugeHere =
    /\b\d{3,6}\s*(usd|dollars?|\$)?\s*(is|it'?s|is\s+a|it'?s\s+a)?\s*(huge|big|large|a\s+lot\s+of)\s+money\b/i;
  const clearlyHasCapitalReady =
    /\b(i\s+(have|got|saved|have\s+saved)|i'?ve\s+(got|saved)|ready\s+with|set\s+aside)\b/i;
  // (g) "Lost what I had" — trader just lost their capital in recent
  // trading. Distinct from noCapital which covers "never had any" /
  // current broke state. This catches "I've lost so much in this few
  // days", "blew up my account", etc.
  const lostCapital =
    /\b(lost\s+(so\s+much|a\s+lot|everything|it\s+all|my\s+money|my\s+capital|all\s+my\s+(money|capital|funds|savings?))|blew\s+up\s+(my|the)\s+account|wiped\s+(out\s+)?(my|the)\s+account|account'?s?\s+(been\s+)?blown|drained\s+my\s+account)\b/i;
  if (
    noCapital.test(text) ||
    hasExplicitCapitalConstraintSignal(text) ||
    jobless.test(text) ||
    desperation.test(text) ||
    cantAffordBasics.test(text) ||
    capitalAccessIssue.test(text) ||
    needTimeToRaise.test(text) ||
    lacksReferencedAmount.test(text) ||
    (amountIsHugeHere.test(text) && !clearlyHasCapitalReady.test(text)) ||
    lostCapital.test(text)
  ) {
    return { kind: 'disqualifier', amount: 0 };
  }

  // 1b. PROP-FIRM GUARD (Tahir Khan 2026-04-20).
  //     Lead says "I'm on FTMO 100k challenge" — the number refers to
  //     the FIRM's capital, not personal. Without this check the amount
  //     parser below would happily accept 100000 and R24 would pass.
  //     Only tolerate the number when a personal-capital indicator or
  //     "plus X" phrase is present alongside the prop-firm mention
  //     (e.g. "I got 4k plus my prop firm" → 4k IS personal).
  if (PROP_FIRM_PATTERN.test(text)) {
    const hasPersonalIndicator =
      PERSONAL_CAPITAL_INDICATOR.test(text) || PLUS_PHRASE.test(text);
    if (!hasPersonalIndicator) {
      return {
        kind: 'ambiguous',
        amount: null,
        reason: 'prop_firm_mentioned_no_personal_capital_stated'
      };
    }
    // else: personal-capital language is present → fall through to
    // amount parse; the number is (likely) personal not firm-tied.
  }

  // 2. Amount (numeric parse). Even if the lead also says "kinda" or
  //    includes hedging words, a concrete number beats the hedge —
  //    we'll compare it to threshold later.
  //    EXCEPTION (SMOKE 12, 2026-05-04): "less than $X" / "under $X" /
  //    "below $X" / "barely $X" / "not even $X" — the lead is stating
  //    they have BELOW $X, not $X. Decrement the parsed amount so the
  //    threshold check at compareAmt >= threshold falls into the
  //    below_threshold branch instead of confirming.
  if (parsedAmount !== null) {
    if (BELOW_THRESHOLD_HEDGE_PATTERN.test(text)) {
      return {
        kind: 'amount',
        amount: Math.max(parsedAmount - 1, 0),
        ...(parsedCurrency ? { currency: parsedCurrency } : {})
      };
    }
    return {
      kind: 'amount',
      amount: parsedAmount,
      ...(parsedCurrency ? { currency: parsedCurrency } : {})
    };
  }

  // 3. Hedging without a concrete number.
  if (
    /\b(kinda|almost|about\s+half|working\s+on|save\s+up|not\s+yet|close\s+to|nearly|getting\s+there|not\s+quite|less\s+than|under|below|only|i\s+can\s+get\s+it|soon|in\s+a\s+bit)\b/i.test(
      text
    )
  ) {
    return { kind: 'hedging', amount: null };
  }

  // 3b. Vague non-answer (FIX 1, Amos Edoja 2026-04-30). Lead used a
  //    pseudo-answer phrase that pretends to address the capital
  //    question without naming a number ("manageable amount",
  //    "something small to start"). First occurrence: caller probes
  //    once with a ballpark prompt. Second occurrence (counted in
  //    checkR24Verification): routed to below_threshold.
  if (looksLikeVagueCapitalAnswer(text)) {
    return { kind: 'ambiguous', amount: null, reason: 'vague_no_number' };
  }

  // 4. Ambiguous — can't tell. Don't pass the gate.
  if (
    /\b(depends|varies|some|a\s+bit|not\s+sure|dunno|idk|i'?ll\s+let\s+you\s+know|it'?s\s+complicated|maybe)\b/i.test(
      text
    )
  ) {
    return { kind: 'ambiguous', amount: null, reason: 'generic' };
  }

  // 5. Legacy affirmative ("yeah" / "got it" / "for sure") with no
  //    number — back-compat with the threshold-confirming Q. The caller
  //    accepts this as a confirmation.
  if (
    /^(yes|yeah|yup|yep|confirmed|got\s+it|for\s+sure|i\s+do|sure|absolutely|definitely|100%|yea|ready|hell\s+yeah|let'?s\s+go)\b/i.test(
      text
    )
  ) {
    return { kind: 'affirmative', amount: null };
  }

  // Default fallback — nothing matched any category. Treat as
  // ambiguous so the gate asks a clarifying question rather than
  // silently passing. The reason tag lets the directive layer
  // distinguish "lead said something unparseable" from the other
  // explicit-ambiguous cases above.
  return { kind: 'ambiguous', amount: null, reason: 'no_pattern_matched' };
}

function applySemanticCapitalAmountToParsedAnswer(
  raw: string,
  parsed: ParsedLeadAnswer,
  semanticAmount: number | null
): ParsedLeadAnswer {
  if (semanticAmount === null || semanticAmount === undefined) return parsed;
  if (parsed.kind === 'disqualifier') return parsed;

  const text = raw.trim();
  if (capitalNumberNeedsComfortClarification(text)) {
    return {
      kind: 'ambiguous',
      amount: semanticAmount,
      currency: detectCurrencyFromText(text) ?? 'USD',
      reason: 'total_savings_or_financial_stress'
    };
  }

  if (PROP_FIRM_PATTERN.test(text)) {
    const hasPersonalIndicator =
      PERSONAL_CAPITAL_INDICATOR.test(text) || PLUS_PHRASE.test(text);
    if (!hasPersonalIndicator) return parsed;
  }

  return {
    kind: 'amount',
    amount: semanticAmount,
    currency: detectCurrencyFromText(text) ?? 'USD'
  };
}

async function parseLeadCapitalAnswerWithSemanticFallback(params: {
  message: string;
  accountId?: string | null;
  recentConversation?: string[];
}): Promise<ParsedLeadAnswer> {
  const parsed = parseLeadCapitalAnswer(params.message);
  if (parsed.kind === 'disqualifier') return parsed;

  const semantic = await classifyCapitalAmountWithHaiku({
    accountId: params.accountId,
    leadMessage: params.message,
    recentConversation: params.recentConversation
  });
  if (semantic.amount !== null) {
    console.warn('[capital-classifier] semantic amount selected:', {
      amount: semantic.amount,
      leadMessageFirst80: params.message.slice(0, 80)
    });
  } else if (semantic.error || semantic.timedOut) {
    console.warn('[capital-classifier] semantic parse unavailable:', {
      error: semantic.error,
      timedOut: semantic.timedOut,
      leadMessageFirst80: params.message.slice(0, 80)
    });
  }

  return applySemanticCapitalAmountToParsedAnswer(
    params.message,
    parsed,
    semantic.amount
  );
}

/**
 * Detect the currency a lead is using for capital amounts. Source
 * priority: explicit candidate texts (mergedAnswers) first, then a DB
 * scan of LEAD messages on this conversation. Defaults to USD when no
 * explicit currency is found, matching historical behavior.
 */
export async function detectConversationCurrency(
  conversationId: string,
  candidateTexts: string[] = []
): Promise<ConversationCurrency> {
  const candidateCurrency = detectCurrencyFromTexts(candidateTexts);
  if (candidateCurrency) return candidateCurrency;

  const leadMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'LEAD' },
    select: { sender: true, content: true }
  });
  return (
    detectCurrencyFromTexts(
      leadMsgs
        .filter((m) => isLeadCapitalParseCandidate(m))
        .map((m) => m.content)
    ) ?? 'USD'
  );
}

/**
 * Confidence-graded currency detection (Paul 2026-04-29 incident).
 *
 *   HIGH   — the lead's CURRENT capital answer carries a recognized
 *            currency symbol/word ($, £, ₦, "naira", "USD", etc.).
 *            Convert + route immediately, no clarification.
 *   MEDIUM — the answer itself has no symbol, but earlier LEAD
 *            messages on this conversation do. Treat that as the
 *            conversation's currency. Convert + route, no
 *            clarification.
 *   LOW    — neither the answer nor any prior LEAD message has a
 *            recognized currency signal. Caller MUST ask a
 *            clarification question before routing — the previous
 *            "default to USD" behavior was silently mis-routing
 *            non-USD leads (e.g. "#100000" parsed as $100k USD when
 *            it was meant as ₦100,000 ≈ $62 USD).
 */
export async function detectConversationCurrencyConfidence(
  conversationId: string,
  answerText: string,
  alreadyMergedAnswerTexts: string[] = []
): Promise<{
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  currency: ConversationCurrency | null;
}> {
  const onAnswer = detectCurrencyFromText(answerText);
  if (onAnswer) return { confidence: 'HIGH', currency: onAnswer };
  // mergedAnswerTexts can include the answer itself + any later
  // clarification turns — try those next.
  const onMergedAnswers = detectCurrencyFromTexts(alreadyMergedAnswerTexts);
  if (onMergedAnswers) return { confidence: 'HIGH', currency: onMergedAnswers };
  // Otherwise scan the conversation's prior LEAD messages.
  const leadMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'LEAD' },
    select: { sender: true, content: true }
  });
  const onHistory = detectCurrencyFromTexts(
    leadMsgs.filter((m) => isLeadCapitalParseCandidate(m)).map((m) => m.content)
  );
  if (onHistory) return { confidence: 'MEDIUM', currency: onHistory };
  return { confidence: 'LOW', currency: null };
}

async function persistR24VerificationState(
  conversationId: string,
  result: R24GateResult
): Promise<void> {
  if (result.reason === 'durable_qualification_state') return;

  const qualified =
    !result.blocked &&
    (result.reason === 'confirmed_amount' ||
      result.reason === 'confirmed_affirmative');
  const explicitlyUnqualified =
    result.blocked && result.reason === 'answer_below_threshold';
  if (!qualified && !explicitlyUnqualified) return;

  const status = qualified ? 'VERIFIED_QUALIFIED' : 'VERIFIED_UNQUALIFIED';
  const data: Prisma.ConversationUpdateManyMutationInput = {
    capitalVerificationStatus: status,
    ...(qualified
      ? {
          capitalVerifiedAt: new Date(),
          ...(result.parsedAmount !== null
            ? { capitalVerifiedAmount: result.parsedAmount }
            : {})
        }
      : {
          capitalVerifiedAt: new Date(),
          capitalVerifiedAmount: result.parsedAmount ?? 0
        })
  };

  try {
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        capitalVerificationStatus: {
          notIn: ['VERIFIED_QUALIFIED', 'MANUALLY_OVERRIDDEN']
        }
      },
      data
    });
    if (result.parsedAmount !== null && result.parsedAmount !== undefined) {
      const row = await prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { capturedDataPoints: true }
      });
      const points = {
        ...asJsonObject(row?.capturedDataPoints)
      };
      const extractedAt = new Date().toISOString();
      points.capital = {
        value: result.parsedAmount,
        confidence: 'HIGH',
        extractedFromMessageId: result.verificationConfirmedAt ?? null,
        extractionMethod: 'semantic_capital_classification',
        extractedAt
      };
      points.verifiedCapitalUsd = {
        value: result.parsedAmountUsd ?? result.parsedAmount,
        confidence: 'HIGH',
        extractedFromMessageId: result.verificationConfirmedAt ?? null,
        extractionMethod: 'semantic_capital_classification',
        extractedAt
      };
      points.capitalThresholdMet = {
        value: qualified,
        confidence: 'HIGH',
        extractedFromMessageId: result.verificationConfirmedAt ?? null,
        extractionMethod: 'semantic_capital_classification',
        extractedAt
      };
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { capturedDataPoints: points as Prisma.InputJsonValue }
      });
    }
  } catch (err) {
    console.error(
      '[ai-engine] R24 durable qualification state update failed (non-fatal):',
      err
    );
  }
}

/**
 * Look through the conversation's AI messages for a prior capital
 * verification question (threshold-confirming OR open-ended), then
 * check the next LEAD reply. Return a structured reason so the caller
 * can pick the right regen directive ("pivot to downsell", "ask
 * clarifying Q", "just ask the verification question").
 */
async function checkR24Verification(
  conversationId: string,
  accountId: string | null | undefined,
  threshold: number,
  customPrompt: string | null,
  currentTurnLeadMsg?: {
    sender?: string;
    content: string;
    timestamp: Date | string;
  }
): Promise<R24GateResult> {
  const finalize = async (result: R24GateResult): Promise<R24GateResult> => {
    await persistR24VerificationState(conversationId, result);
    return result;
  };

  // Durable R24 state is the source of truth. Once a conversation has
  // qualified, reschedules and later time/logistics chatter must not make
  // R24 re-scan historical messages.
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { scheduledCallAt: true, capitalVerificationStatus: true }
  });
  if (
    conv?.capitalVerificationStatus === 'VERIFIED_QUALIFIED' ||
    conv?.capitalVerificationStatus === 'MANUALLY_OVERRIDDEN'
  ) {
    return {
      blocked: false,
      reason: 'durable_qualification_state',
      parsedAmount: null,
      verificationAskedAt: null,
      verificationConfirmedAt: null
    };
  }

  // Legacy defense-in-depth: active confirmed calls still count as passed,
  // and now also persist durable qualification for future reschedules.
  if (conv?.scheduledCallAt) {
    return finalize({
      blocked: false,
      reason: 'confirmed_affirmative',
      parsedAmount: null,
      verificationAskedAt: null,
      verificationConfirmedAt: null
    });
  }

  const aiMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'AI' },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true, timestamp: true }
  });

  const thresholdNoFormat = threshold.toString();
  const thresholdFormatted = threshold.toLocaleString('en-US');
  const patterns: RegExp[] = [
    // Threshold-confirming shapes (from legacy default R24 phrasing)
    /\byou got at least \$\d/i,
    /\byou have at least \$\d/i,
    /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i,
    /\bcapital ready\b/i,
    /\bready to start with \$/i,
    /\bjust to confirm.*\$/i,
    // Exact-threshold matches (with or without thousands comma)
    new RegExp(`\\$${thresholdNoFormat}\\b`, 'i'),
    new RegExp(`\\$${thresholdFormatted.replace(/,/g, '\\,')}`, 'i'),
    // Open-ended shapes (Daniel's new flow and similar). These pick up
    // questions like "how much do you have set aside for the markets
    // and your education in USD", "what's your budget for this",
    // "what are you working with on the capital side", etc.
    /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
    /\bwhat(?:'|’)?s your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bwhat is your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bwhat(?:'|’)?s your capital situation\b/i,
    /\bcapital situation\s+like\b/i,
    /\bset aside\b.*\b(for|toward|for (the |this )?markets?|for (your |the )?(education|trading))/i,
    /\bhow much (are you )?(working with|looking to (invest|start with|put (in|aside)))\b/i,
    /\bwhat are you working with\b/i,
    /\bon the (capital|money|budget) side\b/i
  ];
  if (customPrompt && customPrompt.trim().length >= 15) {
    const snippet = customPrompt.trim().slice(0, 30);
    const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(escaped, 'i'));
  }

  // Track BOTH the first capital Q (anchor for "answers after this
  // point") AND the total count of capital Qs the AI has asked. The
  // count drives the FIX 3 evasion guard: if the lead has been asked
  // twice but never named a number, route to downsell rather than
  // letting the AI ask a third time.
  let verificationAskedAt: { id: string; timestamp: Date } | null = null;
  let totalCapitalQuestionsAsked = 0;
  for (const msg of aiMsgs) {
    if (patterns.some((p) => p.test(msg.content))) {
      totalCapitalQuestionsAsked++;
      if (!verificationAskedAt) {
        verificationAskedAt = { id: msg.id, timestamp: msg.timestamp };
      }
    }
  }

  if (!verificationAskedAt) {
    const explicitConstraint = await findExplicitCapitalConstraintLeadMessage(
      conversationId,
      currentTurnLeadMsg
    );
    if (explicitConstraint) {
      return finalize({
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: 0,
        verificationAskedAt: null,
        verificationConfirmedAt: null
      });
    }
    return finalize({
      blocked: true,
      reason: 'never_asked',
      parsedAmount: null,
      verificationAskedAt: null,
      verificationConfirmedAt: null
    });
  }

  // Collect ALL LEAD messages after the verification Q, not just the
  // first. Two reasons:
  //   1. Tahir-class false-positive: lead sends "kinda" then
  //      immediately "actually I have 5k" — the earlier message
  //      classifies as hedging, but the later one is the real
  //      answer. Taking only `findFirst` misclassifies these as
  //      hedging when the actual answer is a number.
  //   2. Current-turn belt-and-suspenders: if the caller passed
  //      `currentTurnLeadMsg` explicitly (from conversationHistory),
  //      use it even if it's newer than the DB-queried set — rules
  //      out any webhook-timing race where the current turn's LEAD
  //      message was saved microseconds after checkR24Verification
  //      snapshot'd its Message query.
  const laterLeadMsgs = await prisma.message.findMany({
    where: {
      conversationId,
      sender: 'LEAD',
      timestamp: { gt: verificationAskedAt.timestamp }
    },
    orderBy: { timestamp: 'asc' },
    select: { id: true, sender: true, content: true, timestamp: true }
  });
  // Merge in the current-turn override if it sits after the Q AND is
  // not already in the DB result (dedupe by content + timestamp).
  const mergedAnswers: Array<{
    id: string | null;
    sender: string;
    content: string;
    timestamp: Date;
  }> = laterLeadMsgs
    .filter((m) => isLeadCapitalParseCandidate(m))
    .map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      timestamp: m.timestamp
    }));
  if (currentTurnLeadMsg) {
    const overrideTs =
      currentTurnLeadMsg.timestamp instanceof Date
        ? currentTurnLeadMsg.timestamp
        : new Date(currentTurnLeadMsg.timestamp);
    const afterQ =
      overrideTs.getTime() > verificationAskedAt.timestamp.getTime();
    const overrideCandidate = {
      sender: currentTurnLeadMsg.sender ?? 'LEAD',
      content: currentTurnLeadMsg.content
    };
    const alreadyInSet = mergedAnswers.some(
      (m) =>
        m.content === currentTurnLeadMsg.content &&
        Math.abs(m.timestamp.getTime() - overrideTs.getTime()) < 2000
    );
    if (
      afterQ &&
      !alreadyInSet &&
      isLeadCapitalParseCandidate(overrideCandidate)
    ) {
      mergedAnswers.push({
        id: null,
        sender: overrideCandidate.sender,
        content: currentTurnLeadMsg.content,
        timestamp: overrideTs
      });
    }
  }
  mergedAnswers.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (mergedAnswers.length === 0) {
    return finalize({
      blocked: true,
      reason: 'asked_but_no_answer',
      parsedAmount: null,
      verificationAskedAt: verificationAskedAt.id,
      verificationConfirmedAt: null
    });
  }
  // Classify each candidate answer; prefer the STRONGEST signal.
  // amount (concrete number) wins everything. When both an affirmative
  // AND a disqualifier appear in the same burst — classic "Yes /
  // actually No / I don't have it right now" pattern (Kelvin Kelvot
  // 2026-04-24 incident) — the DISQUALIFIER wins. Leads reflex-type
  // "yes" then correct themselves; the correction is the truth, and
  // routing a lead with no money to the booking handoff is far costlier
  // than asking a second clarifying question. If only one signal is
  // present, its own priority governs as usual.
  const classifications: Array<{
    msg: (typeof mergedAnswers)[number];
    cls: ParsedLeadAnswer;
  }> = [];
  for (const message of mergedAnswers) {
    // R24 capital parsing must only ever read the lead's own words.
    // Operator/system notes can contain dollar amounts, times, or
    // thresholds as instructions and must never become "capital answers".
    if (message.sender !== 'LEAD') continue;
    if (message.content.trimStart().startsWith('OPERATOR NOTE:')) continue;
    const recentConversation = mergedAnswers
      .filter((m) => m.timestamp.getTime() <= message.timestamp.getTime())
      .slice(-6)
      .map((m) => `${m.sender}: ${m.content}`);
    classifications.push({
      msg: message,
      cls: await parseLeadCapitalAnswerWithSemanticFallback({
        message: message.content,
        accountId,
        recentConversation
      })
    });
  }
  if (classifications.length === 0) {
    return finalize({
      blocked: true,
      reason: 'asked_but_no_answer',
      parsedAmount: null,
      verificationAskedAt: verificationAskedAt.id,
      verificationConfirmedAt: null
    });
  }
  // amount > disqualifier > affirmative > hedging > ambiguous.
  const priority: Record<string, number> = {
    amount: 5,
    disqualifier: 4,
    affirmative: 3,
    hedging: 2,
    ambiguous: 1
  };
  let best = classifications[classifications.length - 1]; // default: latest
  for (const c of classifications) {
    if (priority[c.cls.kind] > priority[best.cls.kind]) {
      best = c;
    } else if (
      priority[c.cls.kind] === priority[best.cls.kind] &&
      c.msg.timestamp.getTime() > best.msg.timestamp.getTime()
    ) {
      // Tie → prefer the later message (most recent intent).
      best = c;
    }
  }
  const classification = best.cls;
  const nextLead = { id: best.msg.id, content: best.msg.content };
  const askedId = verificationAskedAt.id;

  // ── Currency detection (Souljah J 2026-04-25, Eucanmax 2026-04-28) ──
  // Threshold is stored in USD on the persona row. Compare the lead's
  // native-currency amount against the threshold after converting to an
  // approximate USD equivalent. This is intentionally coarse: the gate
  // exists to catch obvious misses like R2000 ≈ $108, not split hairs.
  const conversationCurrency = await detectConversationCurrency(
    conversationId,
    mergedAnswers.map((m) => m.content)
  );

  // ── FIX 3 (Amos Edoja 2026-04-30): Two-evasions guard ──────────
  // If the AI has asked the capital question 2+ times AND no answer
  // ever named a number, the lead is dodging — route to downsell
  // instead of asking a third time. This catches the failure mode
  // where the lead drip-feeds vague non-answers ("manageable
  // amount", "starting small") and the AI keeps accepting them.
  const hasAnyAmountAnswer = classifications.some(
    (c) => c.cls.kind === 'amount'
  );
  if (totalCapitalQuestionsAsked >= 2 && !hasAnyAmountAnswer) {
    return finalize({
      blocked: true,
      reason: 'answer_below_threshold',
      parsedAmount: null,
      parsedCurrency: classification.currency ?? null,
      parsedAmountUsd: null,
      verificationAskedAt: askedId,
      verificationConfirmedAt: null
    });
  }

  // ── FIX 2 (Amos Edoja 2026-04-30): Foreign currency, no amount ──
  // If the lead's reply mentions a non-USD currency word
  // (naira/NGN/₦, peso/PHP/₱, rupee/INR/₹, etc.) but never named a
  // numeric amount, treat as below threshold. The currency word
  // itself is the disqualifying signal — they're not banked in USD,
  // and without a number we can't even hedge a conversion. Better to
  // route to the downsell now than ask another clarifying question.
  if (!hasAnyAmountAnswer) {
    const foreignCurrency = detectCurrencyFromTexts(
      mergedAnswers.map((m) => m.content)
    );
    if (foreignCurrency && foreignCurrency !== 'USD') {
      return finalize({
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: null,
        parsedCurrency: foreignCurrency,
        parsedAmountUsd: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      });
    }
  }

  switch (classification.kind) {
    case 'amount': {
      const amt = classification.amount!;
      // Confidence-graded currency check (Paul 2026-04-29). When the
      // lead gives a bare number with no recognized currency
      // symbol/word AND no prior conversation currency context, we
      // can't safely default to USD — historically that mis-routed
      // non-USD leads (e.g. "#100000" treated as $100k USD when the
      // lead meant ₦100,000 ≈ $62 USD). Block + ask for currency
      // clarification instead.
      if (!classification.currency) {
        const conf = await detectConversationCurrencyConfidence(
          conversationId,
          best.msg.content,
          mergedAnswers.map((m) => m.content)
        );
        if (conf.confidence === 'LOW') {
          return finalize({
            blocked: true,
            reason: 'answer_currency_unclear',
            parsedAmount: amt,
            parsedCurrency: null,
            parsedAmountUsd: null,
            verificationAskedAt: askedId,
            verificationConfirmedAt: null
          });
        }
      }
      const parsedCurrency = classification.currency ?? conversationCurrency;
      const compareAmt = convertCapitalAmountToUsd(amt, parsedCurrency);
      if (compareAmt >= threshold) {
        return finalize({
          blocked: false,
          reason: 'confirmed_amount',
          parsedAmount: amt,
          parsedCurrency,
          parsedAmountUsd: compareAmt,
          verificationAskedAt: askedId,
          verificationConfirmedAt: nextLead.id
        });
      }
      return finalize({
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: amt,
        parsedCurrency,
        parsedAmountUsd: compareAmt,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      });
    }
    case 'affirmative':
      return finalize({
        blocked: false,
        reason: 'confirmed_affirmative',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: nextLead.id
      });
    case 'disqualifier':
      return finalize({
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: 0,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      });
    case 'hedging':
      return finalize({
        blocked: true,
        reason: 'answer_hedging',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      });
    case 'ambiguous':
    default:
      return finalize({
        blocked: true,
        reason:
          classification.reason === 'vague_no_number'
            ? 'answer_vague_capital'
            : classification.reason ===
                'prop_firm_mentioned_no_personal_capital_stated'
              ? 'answer_prop_firm_only'
              : classification.reason === 'total_savings_or_financial_stress'
                ? 'answer_total_savings_needs_clarification'
                : 'answer_ambiguous',
        parsedAmount: classification.amount,
        parsedCurrency: classification.currency ?? null,
        parsedAmountUsd:
          classification.amount !== null
            ? convertCapitalAmountToUsd(
                classification.amount,
                classification.currency ?? conversationCurrency
              )
            : null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      });
  }
}

async function findExplicitCapitalConstraintLeadMessage(
  conversationId: string,
  currentTurnLeadMsg?: {
    sender?: string;
    content: string;
    timestamp: Date | string;
  }
): Promise<{ id: string | null; content: string; timestamp: Date } | null> {
  const leadMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'LEAD' },
    orderBy: { timestamp: 'asc' },
    select: { id: true, sender: true, content: true, timestamp: true }
  });

  const candidates: Array<{
    id: string | null;
    sender: string;
    content: string;
    timestamp: Date;
  }> = leadMsgs
    .filter((m) => isLeadCapitalParseCandidate(m))
    .map((m) => ({
      id: m.id,
      sender: m.sender,
      content: m.content,
      timestamp: m.timestamp
    }));

  if (currentTurnLeadMsg) {
    const overrideTs =
      currentTurnLeadMsg.timestamp instanceof Date
        ? currentTurnLeadMsg.timestamp
        : new Date(currentTurnLeadMsg.timestamp);
    const overrideCandidate = {
      sender: currentTurnLeadMsg.sender ?? 'LEAD',
      content: currentTurnLeadMsg.content
    };
    const alreadyInSet = candidates.some(
      (m) =>
        m.content === currentTurnLeadMsg.content &&
        Math.abs(m.timestamp.getTime() - overrideTs.getTime()) < 2000
    );
    if (!alreadyInSet && isLeadCapitalParseCandidate(overrideCandidate)) {
      candidates.push({
        id: null,
        sender: overrideCandidate.sender,
        content: currentTurnLeadMsg.content,
        timestamp: overrideTs
      });
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i];
    if (hasExplicitCapitalConstraintSignal(msg.content)) {
      return { id: msg.id, content: msg.content, timestamp: msg.timestamp };
    }
  }

  return null;
}
