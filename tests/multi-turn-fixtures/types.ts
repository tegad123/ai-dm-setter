// Multi-turn stateful fixtures — the verification layer the single-turn
// fixtures cannot provide.
//
// WHY THIS EXISTS: the 21 single-turn fixtures (tests/conversation-fixtures/)
// all pass while production still got stuck, because the real bug is STATEFUL
// and accumulates over many turns: prepareScriptState() persists
// `currentScriptStep`, the maxAdvanceSteps:1 cap compounds lag turn-over-turn,
// the position drifts behind the conversation, and gates fire on the stale
// step. A single-turn snapshot can never observe that drift.
//
// A multi-turn fixture replays a full conversation TURN BY TURN through the
// REAL computeSystemStage() with state carried forward (previousCurrentScriptStep
// + accumulated branchHistory), exactly like the live prepareScriptState loop,
// and asserts the smoking guns: no permanent step-parking, bounded lag, and the
// lead reaches the terminal step.

import type { ScriptHistoryMessage } from '../../src/lib/script-state-recovery';

/** One conversation turn: an AI message (what the AI actually sent — may be a
 *  PARAPHRASE of the scripted [ASK], which is the crux of the bug) followed by
 *  the lead's reply. `expectedTrueStep` is where the conversation genuinely is
 *  after this turn (authoring intent), used to measure tracker lag. */
export interface MultiTurnStep {
  turn: number;
  /** The AI's sent message text for this turn (paraphrased ok). */
  aiMessage: string;
  /** Optional suggestionId tying the AI message to the step that generated it
   *  (the reliable completion signal the fix relies on). */
  aiSuggestionId?: string;
  /** Which script step this AI message corresponds to (authoring truth). */
  aiStepNumber: number;
  /** The lead's reply that follows. */
  leadReply: string;
}

/** A minimal script-step definition for the harness (mirrors askStep in the
 *  existing unit tests). Kept structural so we don't need a full Prisma payload. */
export interface MultiTurnScriptStep {
  stepNumber: number;
  title: string;
  question: string;
  stateKey?: string | null;
  suggestionId?: string | null;
  /** When true, the step's action path is [ask + wait + runtime_judgment] —
   *  the "judgment" step shape (e.g. the DAE deep-why step). These were
   *  excluded from history-completion (script-state-recovery.ts:1286) and
   *  parked the position, causing the deep-why re-ask loop. Phase 6A fixes that. */
  runtimeJudgment?: boolean;
}

export interface MultiTurnStatefulChecks {
  /** Position must never be frozen on the same step for >= this many
   *  consecutive turns while the conversation advanced. */
  maxConsecutiveSameStep?: number;
  /** Tracked currentScriptStep must stay within this many steps of the
   *  authoring-truth `aiStepNumber` for the turn. */
  maxLagFromTrue?: number;
  /** By the final turn, tracked step must be >= this (e.g. reached booking). */
  finalStepAtLeast?: number;
}

export interface MultiTurnFixture {
  id: string;
  description: string;
  /** The script the account authored (any ordering — not assumed DAE). */
  script: MultiTurnScriptStep[];
  /** The turn-by-turn transcript. */
  turns: MultiTurnStep[];
  checks: MultiTurnStatefulChecks;
  /** Re-export for convenience: a turn's history rows are built from prior turns. */
  __historyType?: ScriptHistoryMessage;
}
