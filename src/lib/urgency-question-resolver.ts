// ---------------------------------------------------------------------------
// urgency-question-resolver.ts
// ---------------------------------------------------------------------------
// Resolves the urgency-stage timeline question for a given account/persona
// without falling back to the legacy daetradez phrasing.
//
// Background: the master prompt (ai-prompts.ts) and several runtime regen
// directives in ai-engine.ts previously hardcoded the legacy daetradez
// urgency timeline phrasing verbatim. Every account inherited that
// phrasing regardless of what their uploaded script said — same
// architectural class of bug as the cross-tenant voice leak. Operators
// on accounts that uploaded a brand-new script with different urgency
// wording still saw the daetradez line because the wording was never
// read from the script.
//
// Fallback priority (configured by spec — DO NOT add the legacy phrase):
//   1. Active Script → step containing "URGENCY" (case-insensitive in
//      title/stateKey) → first ASK action's content (or canonicalQuestion
//      if no ASK action exists yet).
//   2. AIPersona.promptConfig.urgencyQuestion when present and non-empty.
//   3. Generic safe fallback: "what's your timeline for making this happen?"
//
// The legacy daetradez timeline phrasing is retired permanently from
// production code. It only ever lives in a tenant's own script content
// if the operator chooses to keep it there.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

/** Permanent generic fallback when neither script nor persona provides one. */
export const GENERIC_URGENCY_FALLBACK =
  "what's your timeline for making this happen?";

// ---------------------------------------------------------------------------
// Pure-data shapes (test-friendly subset of Prisma return types)
// ---------------------------------------------------------------------------

export interface UrgencyResolverActionData {
  actionType: string;
  content: string | null;
  sortOrder: number;
}

export interface UrgencyResolverBranchData {
  sortOrder: number;
  actions: UrgencyResolverActionData[];
}

export interface UrgencyResolverStepData {
  stateKey: string | null;
  title: string;
  canonicalQuestion: string | null;
  stepNumber: number;
  actions: UrgencyResolverActionData[]; // direct (branchId === null)
  branches: UrgencyResolverBranchData[];
}

export interface UrgencyResolverScriptData {
  steps: UrgencyResolverStepData[];
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

/**
 * Heuristic that matches a ScriptStep as the URGENCY/timeline step. We can't
 * rely on `stepNumber` because the parser orders steps by the operator's
 * script, not by our internal stage taxonomy. The parser does, however,
 * surface the stage label in `stateKey` (e.g. "URGENCY") and frequently in
 * `title` (e.g. "Stage 4: Urgency", "Timeline / urgency", etc.). Also accept
 * "timeline" because some operator scripts label the stage that way.
 */
export function isUrgencyStep(step: {
  stateKey: string | null;
  title: string;
}): boolean {
  const haystack = `${step.stateKey ?? ''} ${step.title}`.toLowerCase();
  return /\burgenc/.test(haystack) || /\btimeline\b/.test(haystack);
}

/**
 * Pure-logic Tier 1: pull the urgency question from a Script's steps. Returns
 * null when no urgency step exists or no usable question text is present.
 *
 * Search order within the matched URGENCY step:
 *   - direct (non-branched) ASK action's content
 *   - branched ASK action's content (first match across branches)
 *   - canonicalQuestion field on the step itself
 */
export function pickUrgencyQuestionFromScript(
  script: UrgencyResolverScriptData | null
): string | null {
  if (!script) return null;
  const urgencyStep = script.steps.find(isUrgencyStep);
  if (!urgencyStep) return null;

  const directAsk = urgencyStep.actions.find(
    (a) =>
      a.actionType === 'ask_question' &&
      typeof a.content === 'string' &&
      a.content.trim().length > 0
  )?.content;
  if (directAsk && directAsk.trim().length > 0) return directAsk.trim();

  const branchedAsk = urgencyStep.branches
    .flatMap((b) => b.actions)
    .find(
      (a) =>
        a.actionType === 'ask_question' &&
        typeof a.content === 'string' &&
        a.content.trim().length > 0
    )?.content;
  if (branchedAsk && branchedAsk.trim().length > 0) return branchedAsk.trim();

  if (
    urgencyStep.canonicalQuestion &&
    urgencyStep.canonicalQuestion.trim().length > 0
  ) {
    return urgencyStep.canonicalQuestion.trim();
  }
  return null;
}

/**
 * Pure-logic Tier 2: pull the urgency question from a persona's promptConfig
 * JSON. Returns null when missing/empty.
 */
export function pickUrgencyQuestionFromPersonaConfig(
  promptConfig: Record<string, unknown> | null | undefined
): string | null {
  if (!promptConfig) return null;
  const value = promptConfig.urgencyQuestion;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Production resolver (calls prisma)
// ---------------------------------------------------------------------------

/**
 * Pulls the operator's configured urgency question, walking the priority
 * chain in order. Returns the generic fallback when nothing else is set —
 * NEVER returns the retired daetradez phrasing.
 *
 * Pure read; no writes. Safe to call from any prompt-assembly path.
 */
export async function resolveScriptUrgencyQuestion(
  accountId: string,
  personaId: string | null
): Promise<string> {
  // ── Tier 1 — active relational Script's URGENCY step ────────────
  try {
    const script = await prisma.script.findFirst({
      where: { accountId, isActive: true },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            actions: {
              where: { branchId: null },
              orderBy: { sortOrder: 'asc' }
            },
            branches: {
              orderBy: { sortOrder: 'asc' },
              include: {
                actions: { orderBy: { sortOrder: 'asc' } }
              }
            }
          }
        }
      }
    });

    const fromScript = pickUrgencyQuestionFromScript(
      script as UrgencyResolverScriptData | null
    );
    if (fromScript) return fromScript;
  } catch (err) {
    // Read errors are non-fatal — fall through to next tier.
    console.error(
      '[urgency-resolver] Tier 1 (Script) lookup failed (non-fatal):',
      err
    );
  }

  // ── Tier 2 — AIPersona.promptConfig.urgencyQuestion ─────────────
  if (personaId) {
    try {
      const persona = await prisma.aIPersona.findUnique({
        where: { id: personaId },
        select: { promptConfig: true }
      });
      const cfg =
        (persona?.promptConfig as Record<string, unknown> | null) || null;
      const fromConfig = pickUrgencyQuestionFromPersonaConfig(cfg);
      if (fromConfig) return fromConfig;
    } catch (err) {
      console.error(
        '[urgency-resolver] Tier 2 (persona.promptConfig) lookup failed (non-fatal):',
        err
      );
    }
  }

  // ── Tier 3 — generic safe fallback ──────────────────────────────
  return GENERIC_URGENCY_FALLBACK;
}
