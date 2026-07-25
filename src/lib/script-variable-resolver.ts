import { Prisma } from '@prisma/client';

import { callHaikuText } from '@/lib/haiku-text';
import prisma from '@/lib/prisma';
import {
  latestLeadMessageIsNonAnswer as latestLeadIsNonAnswerShared,
  replyAnswersAsk as replyAnswersAskShared
} from '@/lib/answer-satisfaction';

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
  /**
   * F3 (2026-07-25, Tega run-2). Question anchors for explicit-only prose
   * variables, built from the SCRIPT by callers that have step access
   * (buildVariableAskAnchors). When present, an explicit-only variable may
   * only PERSIST from the LLM / branchHistory tiers when its value comes from
   * the lead's reply to THAT variable's own scripted ask — not from whichever
   * nearby answer the upcoming template happened to need. This is what stops
   * the slot-offset class (deep-why answer bound to urgency, urgency answer
   * bound to life_impact) that run-2 proved on prod.
   */
  askAnchors?: VariableAskAnchor[];
}

export interface VariableAskAnchor {
  variableName: string;
  stepNumber: number | null;
  askContents: string[];
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
  /** F3: when set, extraction is scoped to the anchored ask→reply pair. */
  anchorQuestion?: string;
}) => Promise<string | null>;

// F6/F3 (2026-07-23, surfaced by the live Seemal repro). These variables carry
// a value the LEAD must have STATED — a goal, a motivation, an income target.
// The LLM extractor was inferring them from surrounding context (e.g. deriving
// goal="consistent profitability" from "never really consistent" when the lead
// had only DEFERRED), then persisting the invention at MEDIUM confidence so it
// stuck and drove copy ("that's a real goal" when no goal was given). For these
// names, an LLM extraction is NOT allowed to become a persisted binding unless
// the lead actually answered — otherwise it resolves non-authoritatively (copy
// can still render, nothing fabricated gets stored).
// Explicit-only variables carry a value the LEAD must have STATED. Extended
// 2026-07-23 (full-pipeline research) beyond the original goal/why/outcome set
// to obstacle / urgency / lifeImpact — the research found these were fabricated
// through the volunteered + branchHistory paths with no answer check.
const EXPLICIT_ONLY_VARIABLE_NORMS = new Set(
  [
    'goal',
    'incomegoal',
    'income_goal',
    'desiredoutcome',
    'desired_outcome',
    'deepwhy',
    'deep_why',
    'goalreason',
    'why',
    'obstacle',
    'mainobstacle',
    'earlyobstacle',
    'urgency',
    'lifeimpact',
    'life_impact',
    'painpoint'
  ].map((n) => n.replace(/[^a-z0-9]/g, ''))
);

function isExplicitOnlyVariable(variableName: string): boolean {
  const norm = normalizeTemplateKey(variableName).replace(/[^a-z0-9]/g, '');
  return EXPLICIT_ONLY_VARIABLE_NORMS.has(norm);
}

// Answer-satisfaction comes from the shared leaf module so this layer and the
// step-completion layer never drift (they did — this module's copy lagged the
// hardening applied to replyAnswersAsk). Imported at top of file.
function latestLeadMessageIsNonAnswer(
  history: ScriptVariableHistoryMessage[]
): boolean {
  return latestLeadIsNonAnswerShared(history);
}

// ── F3: question anchors (2026-07-25) ──────────────────────────────────────

interface AnchorSourceAction {
  actionType?: string | null;
  content?: string | null;
}

interface AnchorSourceStep {
  stepNumber?: number | null;
  title?: string | null;
  canonicalQuestion?: string | null;
  actions?: AnchorSourceAction[] | null;
  // CRITICAL (2026-07-25, found live): in production scripts the actions live
  // on BRANCHES — the daetradez script has ZERO step-level actions (the
  // runtime loader even filters `branchId: null`). An anchor builder that only
  // reads step.actions receives empty pools and silently disables the entire
  // F3/F5 anchoring. Branch actions MUST be pooled in.
  branches?: Array<{ actions?: AnchorSourceAction[] | null }> | null;
}

// Title → variable fallbacks for steps whose runtime_judgment doesn't name the
// {{token}} explicitly. Kept to the explicit-only prose set.
const STEP_TITLE_VARIABLE_HINTS: Array<{ pattern: RegExp; variable: string }> =
  [
    { pattern: /life\s*impact/i, variable: 'life_impact' },
    { pattern: /why\s+the\s+goal\s+matters|deep\s*why/i, variable: 'deepWhy' },
    { pattern: /matters\s+now|urgency/i, variable: 'urgency' },
    { pattern: /goal\s+discovery|main\s+goal/i, variable: 'goal' },
    { pattern: /obstacle|keeping\s+you\s+stuck/i, variable: 'obstacle' }
  ];

/**
 * Build the ask→variable anchor map from script steps. A variable is anchored
 * to a step when the step's runtime_judgment text names its {{token}} (e.g.
 * "Store as {{urgency}}") or the step title implies it; the anchor's
 * askContents are the step's scripted ask_question texts (+ canonicalQuestion).
 * Callers with script access (ai-engine, script-serializer) thread the result
 * into ScriptVariableResolutionContext.askAnchors.
 */
export function buildVariableAskAnchors(
  steps: AnchorSourceStep[] | null | undefined
): VariableAskAnchor[] {
  const anchors: VariableAskAnchor[] = [];
  for (const step of steps ?? []) {
    // Pool step-level AND branch-level actions — production scripts keep
    // everything on branches (see AnchorSourceStep note).
    const actions: AnchorSourceAction[] = [
      ...(step.actions ?? []),
      ...(step.branches ?? []).flatMap((b) => b?.actions ?? [])
    ];
    const asks = actions
      .filter(
        (a) =>
          a?.actionType === 'ask_question' &&
          typeof a.content === 'string' &&
          a.content.trim().length > 0
      )
      .map((a) => (a.content as string).trim());
    if (
      typeof step.canonicalQuestion === 'string' &&
      step.canonicalQuestion.trim().length > 0
    ) {
      asks.push(step.canonicalQuestion.trim());
    }
    if (asks.length === 0) continue;

    const varNames = new Set<string>();
    // {{tokens}} named inside runtime_judgment directives ("Store as {{urgency}}")
    for (const action of actions) {
      if (action?.actionType !== 'runtime_judgment') continue;
      const content = typeof action.content === 'string' ? action.content : '';
      for (const m of Array.from(
        content.matchAll(/\{\{\s*([^{}]{1,80}?)\s*\}\}/g)
      )) {
        const name = m[1].trim();
        if (isExplicitOnlyVariable(name)) varNames.add(name);
      }
    }
    // title fallback
    const title = step.title ?? '';
    for (const hint of STEP_TITLE_VARIABLE_HINTS) {
      if (hint.pattern.test(title)) varNames.add(hint.variable);
    }

    for (const variableName of Array.from(varNames)) {
      anchors.push({
        variableName,
        stepNumber:
          typeof step.stepNumber === 'number' ? step.stepNumber : null,
        askContents: asks
      });
    }
  }
  return anchors;
}

function anchorEntriesForVariable(
  variableName: string,
  anchors: VariableAskAnchor[] | undefined
): VariableAskAnchor[] {
  if (!anchors || anchors.length === 0) return [];
  const targets = new Set(
    variableAliases(variableName).map((a) =>
      normalizeTemplateKey(a).replace(/[^a-z0-9]/g, '')
    )
  );
  targets.add(normalizeTemplateKey(variableName).replace(/[^a-z0-9]/g, ''));
  return anchors.filter((anchor) => {
    const anchorNorms = new Set(
      variableAliases(anchor.variableName).map((a) =>
        normalizeTemplateKey(a).replace(/[^a-z0-9]/g, '')
      )
    );
    anchorNorms.add(
      normalizeTemplateKey(anchor.variableName).replace(/[^a-z0-9]/g, '')
    );
    for (const t of Array.from(targets)) if (anchorNorms.has(t)) return true;
    return false;
  });
}

const ASK_MATCH_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'or',
  'is',
  'are',
  'you',
  'your',
  'that',
  'this',
  'it',
  'for',
  'in',
  'on',
  'so',
  'do',
  'does',
  'be',
  'like',
  'bro',
  'man',
  'though',
  'right',
  'now',
  'what',
  'whats',
  'why',
  'how'
]);

function askMatchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\{\{[^}]*\}\}/g, ' ') // scripted asks embed {{tokens}}
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !ASK_MATCH_STOPWORDS.has(t));
}

// Exported for the F5 backward-content guard in voice-quality-gate — the gate
// and the resolver must agree on what "this delivered text IS that scripted
// ask" means, so there is exactly one matcher.
export function scriptAskMatchesText(
  askContent: string,
  text: string
): boolean {
  return askMatchesMessage(askContent, text);
}

// Does a delivered AI message match a scripted ask? Token-overlap on the
// scripted ask's significant tokens — asks get lightly paraphrased in
// delivery ("but why is 10k a month so important to you though?" vs the
// scripted "But why is {{their stated goal}} so important to you though?"),
// so exact matching would anchor nothing.
function askMatchesMessage(askContent: string, message: string): boolean {
  const askTokens = askMatchTokens(askContent);
  if (askTokens.length < 2) return false;
  const messageTokens = new Set(askMatchTokens(message));
  let hits = 0;
  for (const t of askTokens) if (messageTokens.has(t)) hits += 1;
  return hits / askTokens.length >= 0.6;
}

// Model-emitted judgment captures ("Store as {{x}}" executed by the LLM) are a
// FOURTH writer of captured state, previously ungated — Run A live: it stored
// the pre-ask consequence answer as urgency. For anchored explicit-only
// variables, such a capture is only trustworthy when the variable's scripted
// ask was DELIVERED, its direct reply ANSWERS it, and the captured value is
// grounded in that reply. Unanchored variables keep legacy behavior.
export function anchoredCaptureIsConsistent(
  variableName: string,
  value: string,
  anchors: VariableAskAnchor[] | undefined,
  history: ScriptVariableHistoryMessage[]
): boolean {
  if (!isExplicitOnlyVariable(variableName)) return true;
  const entries = anchorEntriesForVariable(variableName, anchors);
  if (entries.length === 0) return true; // no anchors known — legacy
  const anchored = findAnchoredReply(
    history,
    entries.flatMap((a) => a.askContents)
  );
  if (!anchored?.reply) return false; // ask never delivered/answered
  if (!replyAnswersAskShared(anchored.reply)) return false;
  const valTokens = askMatchTokens(value);
  if (valTokens.length === 0) {
    return anchored.reply.toLowerCase().includes(value.toLowerCase().trim());
  }
  const replyTokens = new Set(askMatchTokens(anchored.reply));
  let hits = 0;
  for (const t of valTokens) if (replyTokens.has(t)) hits += 1;
  return hits / valTokens.length >= 0.5;
}

// Newest-first: find the last AI/HUMAN message that delivered one of the
// variable's scripted asks, and the lead's direct reply to it.
function findAnchoredReply(
  history: ScriptVariableHistoryMessage[],
  askContents: string[]
): { ask: string; reply: string | null } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const sender = (msg.sender ?? '').toUpperCase();
    if (sender !== 'AI' && sender !== 'HUMAN') continue;
    const content = msg.content ?? '';
    if (!askContents.some((ask) => askMatchesMessage(ask, content))) continue;
    // direct reply = next LEAD message after the ask
    let reply: string | null = null;
    for (let j = i + 1; j < history.length; j++) {
      if ((history[j].sender ?? '').toUpperCase() === 'LEAD') {
        reply = history[j].content ?? null;
        break;
      }
    }
    return { ask: content, reply };
  }
  return null;
}

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
  // Thousands separator, no cents (Ali QA 2026-07-21: "$3500" / bare "3500"
  // rendered in the pitch — should read "$3,500").
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
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

  const isPhraseKind = [
    'obstacle',
    'deepWhy',
    'desiredOutcome',
    'generic'
  ].includes(spec.kind);

  // Phrase kinds are interpolated verbatim into the pre-link pitch
  // ("…and wanting {{deepWhy}}…"). A lead message often TRAILS a question or
  // filler after the real answer ("okayman, how did you become so much
  // successful" — Ali QA 2026-07-21). Cut everything from the first sentence
  // terminator or interrogative onward so only the clean lead-in survives,
  // BEFORE the terminal-punctuation strip below.
  if (isPhraseKind) {
    // Drop a trailing question clause: split on the first '?' or an
    // interrogative opener mid-string.
    const qCut = value.search(
      /[?]|,?\s+(?:how|why|what|when|where|who|which|are|do|does|did|can|could|would|is)\b\s+(?:did|do|does|you|i|we|is|are|the)\b/i
    );
    if (qCut > 0) value = value.slice(0, qCut).trim();
    // Strip leading greeting/filler tokens even when attached (no word
    // boundary): "okayman ..." -> "...", "yo bro ..." -> "..."
    value = value
      .replace(
        /^(?:ok(?:ay)?|yo+|hey+|hi+|sup|bro|man|dude|lol|haha|honestly|literally|tbh|ngl|umm?|uh+|so|well|like)[\s,]*/i,
        ''
      )
      .replace(
        /^(?:ok(?:ay)?|yo+|hey+|hi+|sup|bro|man|dude|lol|haha|honestly|literally|tbh|ngl|umm?|uh+|so|well|like)[\s,]*/i,
        ''
      )
      .trim();
  }

  value = value.replace(/[.。!?]+$/g, '').trim();
  if (!value || wordCount(value) < 2) {
    // Nothing meaningful left after cleaning a phrase kind — safer to fall
    // through to the neutral fallback than inject a fragment.
    if (isPhraseKind) return null;
  }

  const quoteLike =
    /["“”]/.test(value) ||
    hasEmoji(value) ||
    /\b(?:bro|lol|lmao|haha|man)\b/i.test(value) ||
    /^(?:honestly|literally|tbh|ngl|honestly bro|i mean)\b/i.test(value);
  if (quoteLike && isPhraseKind) {
    return null;
  }

  if (isPhraseKind) {
    if (/^(?:the lead|they|he|she|i|we)\b/i.test(value)) return null;
    // A residual interrogative anywhere means we captured a question, not a
    // stated goal/why — reject rather than inject it into the pitch.
    if (
      /\b(?:how did you|how do you|why do you|what do you|can you|could you)\b/i.test(
        value
      )
    ) {
      return null;
    }
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
  // F6/F3 (2026-07-22): these three were one collapsed bucket — `goal` pulled
  // in `desiredOutcome`, which pulled in `deepWhy`/`why`. So the lead's income
  // target ("5k a month") and their motivation ("be around for my daughter")
  // resolved to the SAME variable and overwrote each other. They are distinct
  // captured concepts and must resolve independently:
  //   • desiredOutcome — the tangible result they want (life change)
  //   • deepWhy         — the underlying motivation / reason
  //   • goal            — the income/number target
  // Narrowed so an income goal no longer aliases into desiredOutcome or why.
  if (normalized.includes('desired') || normalized.includes('outcome')) {
    add(['desiredOutcome', 'desired_outcome']);
  }
  if (
    normalized.includes('deepwhy') ||
    normalized === 'why' ||
    normalized.includes('goalreason')
  ) {
    add(['deepWhy', 'deep_why', 'goalReason', 'why']);
  }
  if (normalized.includes('goal') && !normalized.includes('goalreason')) {
    add(['incomeGoal', 'income_goal', 'goal']);
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
  context: ScriptVariableResolutionContext,
  // F3 (2026-07-25): when question anchors exist for this variable, only a
  // step_completed event from the variable's OWN anchored step may supply the
  // value — a completion of a NEIGHBORING step must not (that is exactly how
  // life_impact absorbed the urgency answer on Tega's run-2).
  allowedStepNumbers?: Set<number>
): string | null {
  const events = branchHistoryEvents(context.capturedDataPoints);
  const history = context.conversationHistory ?? [];
  if (events.length === 0 || history.length === 0) return null;
  const aliases = variableAliases(variableName).map((alias) =>
    normalizeTemplateKey(alias)
  );

  for (const event of [...events].reverse()) {
    if (event.eventType !== 'step_completed') continue;
    if (
      allowedStepNumbers &&
      !(
        typeof event.stepNumber === 'number' &&
        allowedStepNumbers.has(event.stepNumber)
      )
    ) {
      continue;
    }
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
  anchorQuestion?: string;
}): string {
  const spec = getVariableValueSpec(params.variableName);
  const correct = spec.correctExamples
    .map((example) => `- '${example}'`)
    .join('\n');
  const wrong = spec.wrongExamples
    .map((example) => `- '${example}'`)
    .join('\n');

  // F6 (2026-07-23): for explicit-only variables, forbid INFERENCE. The model
  // was deriving a goal from adjacent context ("never consistent" → "consistent
  // profitability") when the lead had not stated one. Only extract what the lead
  // literally said; if they deferred, asked a question, or only implied it,
  // return NONE.
  const explicitOnlyRule = isExplicitOnlyVariable(params.variableName)
    ? `\nIMPORTANT: Only return a value the lead EXPLICITLY STATED in their own words. Do NOT infer, guess, or derive it from context. If the lead deferred, asked a question back, or only implied it, return NONE.\n`
    : '';

  // F3 (2026-07-25): anchored extraction — the value must come from the lead's
  // DIRECT reply to the question that asks for this variable, nothing else.
  const anchorRule = params.anchorQuestion
    ? `\nThe lead was asked: "${params.anchorQuestion}"\nExtract ONLY from the lead's direct reply to that question. If their reply does not answer it, return NONE. If their reply answers a DIFFERENT question instead (for example it describes an obstacle, a goal amount, or their background when the question asked about timing or motivation), return NONE — do not repurpose it.\n`
    : '';

  return (
    `Extract the lead's {{${params.variableName}}} from this sales DM conversation.\n` +
    `Return ONLY a short ${spec.typeLabel} in this format: ${spec.formatSpec}.\n` +
    `No explanation. No full sentences. No quote from the lead. If unclear, return NONE.` +
    explicitOnlyRule +
    anchorRule +
    `\n\nExamples of CORRECT output:\n${correct}\n\n` +
    `Examples of WRONG output:\n${wrong}\n\n` +
    `Conversation history:\n${params.history || '(none)'}\n\n` +
    `Return the value:`
  );
}

async function extractVariableWithHaiku(params: {
  variableName: string;
  conversationHistory: ScriptVariableHistoryMessage[];
  accountId: string;
  anchorQuestion?: string;
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
      history,
      anchorQuestion: params.anchorQuestion
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

    const explicitOnly = isExplicitOnlyVariable(variableName);
    const anchorEntries = explicitOnly
      ? anchorEntriesForVariable(variableName, context.askAnchors)
      : [];
    const hasAnchors = anchorEntries.length > 0;

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
      // F3 (2026-07-25): when the variable has question anchors, only a
      // step_completed event from its OWN anchored step(s) may supply the
      // value — a neighboring step's completion must not (that is exactly how
      // life_impact absorbed the urgency answer on run-2).
      const allowedStepNumbers = hasAnchors
        ? new Set(
            anchorEntries
              .map((a) => a.stepNumber)
              .filter((n): n is number => typeof n === 'number')
          )
        : undefined;
      const inferred = inferFromBranchHistory(
        variableName,
        context,
        allowedStepNumbers && allowedStepNumbers.size > 0
          ? allowedStepNumbers
          : undefined
      );
      if (inferred) {
        // F6/F3 (2026-07-23): branchHistory inference is the SIBLING of the LLM
        // path below — it assembles a value from a step_completed event's
        // leadMessage, which itself may be a non-answer (the ungated judgment/
        // message-wait completion paths). For explicit-only variables, don't
        // persist it when the latest lead message was a non-answer; resolve it
        // non-authoritatively (usable this turn, never stored).
        // F3-hotfix3 (2026-07-25, live Run-A residual): the step-number
        // shortcut was NOT sufficient — a step can COMPLETE via a reply that
        // arrived while its ask was never DELIVERED (Run A: step 5 completed
        // on "it'd break me…" although the life-impact ask never shipped, and
        // branchHistory then OVERWROTE the correct life_impact="free"). For
        // anchored explicit-only variables, branchHistory is therefore NEVER
        // authoritative: the anchored (delivered ask → direct reply) pair in
        // the LLM tier is the ONLY persist path. branchHistory stays available
        // turn-locally for copy.
        const branchHistoryBlocked =
          explicitOnly &&
          (hasAnchors ||
            latestLeadMessageIsNonAnswer(context.conversationHistory ?? []));
        if (branchHistoryBlocked) {
          console.warn(
            `[script-variable-resolver] blocked persisted branchHistory binding ` +
              `for explicit-only variable "${variableName}" (${hasAnchors ? 'anchored — pair-extraction is the only persist path' : 'latest lead message is a non-answer'}); ` +
              `resolving non-authoritatively (shouldPersist=false)`
          );
        }
        resolution = {
          variableName,
          value: inferred,
          source: 'branchHistory',
          confidence: 'MEDIUM',
          shouldPersist: !branchHistoryBlocked
        };
      }
    }

    // F3-hotfix3: an anchored explicit-only variable must reach the pair
    // extraction even when branchHistory produced a turn-local value above —
    // the pair is the ONLY authoritative binder for these.
    const anchoredCanSupersede =
      explicitOnly &&
      hasAnchors &&
      resolution !== null &&
      !resolution.shouldPersist;
    if (
      (!resolution || anchoredCanSupersede) &&
      (context.conversationHistory ?? []).length > 0
    ) {
      // F3 (2026-07-25): question-anchored extraction for explicit-only
      // variables. When the script's anchors are available, the LLM extractor
      // is scoped to the (anchored ask → direct reply) PAIR — it can no longer
      // roam the whole history and hand back whichever nearby answer the
      // upcoming template needed (the slot-offset class: urgency ← deep-why
      // answer, life_impact ← urgency answer, proven on run-2). If the
      // variable's own ask was never delivered — or the lead's direct reply
      // didn't answer it — there is NOTHING to bind: fall through to the
      // fallback tier (template renders without the value; the script's own
      // "no urgency" variants exist for exactly this).
      let scopedHistory: ScriptVariableHistoryMessage[] | null = null;
      let anchorQuestion: string | null = null;
      let skipLlmTier = false;
      if (explicitOnly && hasAnchors) {
        const anchored = findAnchoredReply(
          context.conversationHistory ?? [],
          anchorEntries.flatMap((a) => a.askContents)
        );
        if (anchored?.reply && replyAnswersAskShared(anchored.reply)) {
          anchorQuestion = anchored.ask;
          scopedHistory = [
            { sender: 'AI', content: anchored.ask },
            { sender: 'LEAD', content: anchored.reply }
          ];
        } else {
          // Anchored variable whose ask never got a real answer → no LLM
          // guessing. Deterministic omission beats a fabricated/mis-slotted
          // value ("code owns state, models own language").
          skipLlmTier = true;
          console.warn(
            `[script-variable-resolver] F3 anchored variable "${variableName}" has ` +
              `no answered ask in history — skipping LLM tier (no guess), template ` +
              `renders without it`
          );
        }
      }
      if (!skipLlmTier) {
        const extracted = await extractor({
          variableName,
          conversationHistory:
            scopedHistory ?? context.conversationHistory ?? [],
          accountId: params.accountId,
          anchorQuestion: anchorQuestion ?? undefined
        });
        const cleanExtracted = cleanExtractorValue(extracted, variableName);
        if (cleanExtracted) {
          // F6/F3 (2026-07-23): for explicit-only variables (goal/why/outcome),
          // do NOT let an LLM inference become a PERSISTED binding when the lead's
          // latest message was itself a non-answer. Anchored-pair extractions are
          // exempt — their evidence is the pair itself, not the latest message.
          const explicitOnlyBlocked =
            explicitOnly &&
            !anchorQuestion &&
            latestLeadMessageIsNonAnswer(context.conversationHistory ?? []);
          if (explicitOnlyBlocked) {
            console.warn(
              `[script-variable-resolver] F6 blocked persisted LLM binding for ` +
                `explicit-only variable "${variableName}" — latest lead message is a ` +
                `non-answer; resolving non-authoritatively (shouldPersist=false)`
            );
          }
          resolution = {
            variableName,
            value: cleanExtracted,
            source: 'llm',
            confidence: 'MEDIUM',
            shouldPersist: !explicitOnlyBlocked
          };
        }
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
  resolutionMap?: ScriptVariableResolutionMap | null,
  options: { includeFallback?: boolean } = {}
): string | null | undefined {
  if (!text || !resolutionMap) return text;
  return text.replace(/\{\{\s*([^{}]{1,160})\s*\}\}/g, (match, rawName) => {
    const variableName = String(rawName).trim();
    const resolution =
      resolutionMap.byNormalizedName.get(normalizeTemplateKey(variableName)) ??
      resolutionMap.byNormalizedName.get(
        normalizeTemplateKey(canonicalTemplateVariableName(variableName))
      );
    if (
      resolution?.source === 'fallback' &&
      options.includeFallback === false
    ) {
      return match;
    }
    return resolution?.value ?? match;
  });
}

/**
 * Resolve `{{placeholder}}` tokens the LLM emitted directly into its generated
 * message bubbles, using an already-built resolution map.
 *
 * Used at the metadata-leak guard in ai-engine: a generated "{{name}}" we can
 * resolve to the lead's real value should ship as a personalized message
 * rather than being surgically stripped (which yields incoherent copy) or
 * escalated to a human. Placeholders with no resolution are left untouched so
 * they still fall through to the strip → re-prompt → escalate chain.
 */
export function resolveEmittedPlaceholders(
  messages: string[],
  resolutionMap?: ScriptVariableResolutionMap | null
): { messages: string[]; changed: boolean } {
  if (!resolutionMap || !Array.isArray(messages)) {
    return { messages, changed: false };
  }
  let changed = false;
  const resolved = messages.map((message) => {
    const out = applyResolvedScriptVariables(message, resolutionMap) ?? message;
    if (out !== message) changed = true;
    return out;
  });
  return { messages: resolved, changed };
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
