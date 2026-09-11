// ---------------------------------------------------------------------------
// script-fsm/types.ts — the compiled, code-owned script state machine.
// ---------------------------------------------------------------------------
// M5 items 2–4 (Fix D compiler). A script (steps → branches → actions) is
// compiled ONCE at upload into a pure JSON graph the runtime evaluates with
// no LLM in the loop for routing or advancement:
//   • nodes  = steps, each with its deliverables + a CompletionSpec derived
//              from the step's own actions (what credits the step as done);
//   • edges  = branches, each with a CompiledPredicate derived from the
//              branch's structure, label and prose condition.
// The LLM judge becomes ADVISORY (a fact the predicate may consume), never
// the decider. The NULL branch that broke M4 (empty required set, blind
// gate) is unrepresentable: selectEdge returns an edge or a typed HOLD.
// Mirrors the egress state machine's style: pure data, pure functions,
// shadow-then-authoritative rollout, daetradez flipped last (it's the oracle).
// ---------------------------------------------------------------------------

export const COMPILER_VERSION = 1;

export type LeadSource = 'INBOUND' | 'MANYCHAT' | 'OUTBOUND' | 'MANUAL_UPLOAD';

export type Deliverable =
  | { kind: 'send_message'; text: string }
  | { kind: 'ask'; text: string }
  | { kind: 'send_link'; url: string | null; label: string | null }
  | {
      kind: 'send_video' | 'send_voice_note' | 'form_reference';
      ref: string | null;
    }
  | {
      kind: 'wait';
      waitKind: 'response' | 'duration';
      durationMs: number | null;
    }
  // Advisory only: the runtime judgment text the LLM reads. Never decides
  // routing or completion by itself.
  | { kind: 'runtime_judgment'; text: string };

export type CompletionSpec =
  // The step asked something and waits; the lead's next message completes it.
  | { kind: 'lead_reply_after_ask' }
  // A runtime_judgment sits after a wait (or the branch is judgment + wait):
  // completes when the lead replies (Tega items 4/5 — the "fresh lead" stall).
  | { kind: 'judgment_after_wait' }
  // Judgment with no ask and no wait: pure routing, completes once an edge is
  // selected (no lead turn needed).
  | { kind: 'routing_only' }
  // Deliverables only, nothing to wait for: completes when they are sent.
  | { kind: 'send_only' };

export type CompiledPredicate =
  | { op: 'always' }
  // The lead's message equals the branch label (Tega: "verbatim label match
  // takes that branch"). Evaluated first, case/punctuation-insensitive.
  | { op: 'verbatim_label'; label: string }
  // Step-1 source routing: how the lead arrived.
  | { op: 'source_is'; source: LeadSource }
  // A captured fact exists / equals (from the fact store / capturedDataPoints).
  | { op: 'data_point_set'; key: string }
  | { op: 'data_point_equals'; key: string; value: string }
  // Advisory judge: the LLM classified the lead's reply as this branch label.
  | { op: 'judge_label_is'; label: string }
  | { op: 'and'; clauses: CompiledPredicate[] }
  | { op: 'or'; clauses: CompiledPredicate[] }
  | { op: 'not'; clause: CompiledPredicate };

export interface FsmEdge {
  branchLabel: string;
  branchIndex: number;
  toNodeId: string;
  predicate: CompiledPredicate;
  isDefault: boolean;
  /** How the predicate was derived — for diagnostics + shadow review. */
  derivedFrom: 'always' | 'source' | 'judge' | 'default_fallback';
  deliverables: Deliverable[];
  completion: CompletionSpec;
}

export interface FsmNode {
  id: string;
  stepNumber: number;
  title: string;
  /** Direct (branch-less) actions of the step. */
  deliverables: Deliverable[];
  /** Completion when the step has no branches (else per edge). */
  completion: CompletionSpec;
  edges: FsmEdge[];
  isTerminal: boolean;
}

export interface CompileDiagnostic {
  severity: 'error' | 'warning';
  code:
    | 'duplicate_branch_label'
    | 'ask_without_wait'
    | 'empty_step'
    | 'unreachable_step'
    | 'no_default_branch'
    | 'implicit_default'
    | 'step_gap';
  stepNumber: number | null;
  branchLabel?: string;
  message: string;
}

export interface CompiledScriptFsm {
  compilerVersion: number;
  compiledAt: string;
  entryNodeId: string;
  nodes: FsmNode[];
  diagnostics: CompileDiagnostic[];
}

// ── Runtime types ───────────────────────────────────────────────────────────

export interface LeadFacts {
  source: LeadSource | null;
  /** The lead's latest message, for verbatim label matching. */
  latestLeadText: string | null;
  /** Captured data points (fact store / capturedDataPoints), key → value. */
  dataPoints: Record<string, unknown>;
  /** Advisory judge output for the current step, if any. */
  judgeLabel: string | null;
}

export type EdgeSelection =
  | {
      kind: 'edge';
      edge: FsmEdge;
      reason: 'verbatim' | 'always' | 'source' | 'data' | 'judge' | 'default';
    }
  | { kind: 'hold'; reason: 'ambiguous_no_default' | 'no_edges' };

export interface FsmCursor {
  stepNumber: number;
  selectedBranchLabel: string | null;
  completedSteps: number[];
  compilerVersion: number;
}

export type FsmEvent =
  | { type: 'LEAD_REPLIED'; text: string }
  | { type: 'EDGE_SELECTED'; branchLabel: string }
  | { type: 'DELIVERABLES_SENT' };
