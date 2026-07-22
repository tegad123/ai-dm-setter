// ---------------------------------------------------------------------------
// generation-trace.ts
// ---------------------------------------------------------------------------
// Per-turn instrumentation for AI generation. Added 2026-07-22 at Tega's
// request: every finding in his adversarial run had to be reconstructed from
// delivered message text because none of this was recorded. Ships as its own
// commit, independent of any fix — instrumentation that ships inside a fix
// commit cannot independently verify that fix.
//
// Records per turn: branch selected, step/stage computed by CODE, stage
// EMITTED by the model, resolved variable state, and the assembled prompt.
//
// HARD RULE: this module must never break generation. Every write is
// best-effort and swallowed. A tracing failure is a lost row, never a lost
// reply.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

/** Assembled prompts run large; cap what we persist per row. */
const PROMPT_CHAR_CAP = 60_000;
const REPLY_PREVIEW_CAP = 500;

export interface ResolvedVariableTrace {
  name: string;
  value: string | null;
  /** capturedDataPoints | leadContext | branchHistory | llm | fallback */
  source: string;
  confidence?: string;
}

export interface GenerationTraceInput {
  conversationId: string;
  accountId: string;
  leadMessageId?: string | null;
  branchSelected?: string | null;
  stepNumber?: number | null;
  /** Stage the ENGINE computed from script position. */
  systemStage?: string | null;
  /** Stage the MODEL emitted, pre-suppression. Kept separate on purpose. */
  stageEmitted?: string | null;
  subStageEmitted?: string | null;
  variablesState?: ResolvedVariableTrace[] | null;
  promptSent?: string | null;
  replyPreview?: string | null;
  qualityHardFails?: string[] | null;
}

/**
 * Persist one generation turn. Never throws.
 *
 * The prompt is stored truncated (head + tail) rather than dropped when
 * oversized — F2-class questions ("which surface injected this string") are
 * usually answerable from the persona/context blocks at the head, but the
 * script framework sits at the tail, so keeping both ends beats keeping one.
 */
export async function recordGenerationTurn(
  input: GenerationTraceInput
): Promise<void> {
  try {
    const rawPrompt = input.promptSent ?? null;
    const promptChars = rawPrompt ? rawPrompt.length : null;
    let promptSent = rawPrompt;
    if (rawPrompt && rawPrompt.length > PROMPT_CHAR_CAP) {
      const half = Math.floor(PROMPT_CHAR_CAP / 2);
      promptSent =
        rawPrompt.slice(0, half) +
        `\n\n…[TRUNCATED ${rawPrompt.length - PROMPT_CHAR_CAP} chars]…\n\n` +
        rawPrompt.slice(rawPrompt.length - half);
    }

    await prisma.generationTurnTrace.create({
      data: {
        conversationId: input.conversationId,
        accountId: input.accountId,
        leadMessageId: input.leadMessageId ?? null,
        branchSelected: input.branchSelected ?? null,
        stepNumber: input.stepNumber ?? null,
        systemStage: input.systemStage ?? null,
        stageEmitted: input.stageEmitted ?? null,
        subStageEmitted: input.subStageEmitted ?? null,
        variablesState: (input.variablesState ?? undefined) as never,
        promptSent,
        promptChars,
        replyPreview: input.replyPreview
          ? input.replyPreview.slice(0, REPLY_PREVIEW_CAP)
          : null,
        qualityHardFails: (input.qualityHardFails ?? undefined) as never
      }
    });
  } catch (err) {
    // Non-fatal by contract.
    console.error('[generation-trace] write failed (non-fatal):', err);
  }
}
