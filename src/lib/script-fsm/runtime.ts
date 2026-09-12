// ---------------------------------------------------------------------------
// script-fsm/runtime.ts — pure evaluator: pick the edge, advance the cursor.
// ---------------------------------------------------------------------------
// selectEdge precedence (M5 item 3, Tega): verbatim label match wins outright;
// then the compiled predicates in branch order (source / always / data /
// advisory judge); exactly one true → that edge; several → lowest branch
// index; none → the node's default edge; no default → a TYPED HOLD. It never
// returns null — the "branch NULL → empty required set → blind gate" failure
// of M4 cannot be expressed.
// fsmTransition (item 4): the cursor advances only when the selected branch's
// CompletionSpec is satisfied by the event, at most one step per event.
// ---------------------------------------------------------------------------

import { normalizeForVerbatim } from '@/lib/verbatim-normalize';
import type {
  CompiledPredicate,
  CompiledScriptFsm,
  CompletionSpec,
  EdgeSelection,
  FsmCursor,
  FsmEdge,
  FsmEvent,
  FsmNode,
  LeadFacts
} from './types';

function sameLabel(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) return false;
  return normalizeForVerbatim(a) === normalizeForVerbatim(b);
}

export function evaluatePredicate(
  p: CompiledPredicate,
  facts: LeadFacts
): boolean {
  switch (p.op) {
    case 'always':
      return true;
    case 'verbatim_label':
      return sameLabel(facts.latestLeadText, p.label);
    case 'source_is':
      return facts.source === p.source;
    case 'data_point_set': {
      const v = facts.dataPoints?.[p.key];
      return v !== undefined && v !== null && String(v).trim() !== '';
    }
    case 'data_point_equals':
      return (
        String(facts.dataPoints?.[p.key] ?? '')
          .trim()
          .toLowerCase() === p.value.trim().toLowerCase()
      );
    case 'judge_label_is':
      return sameLabel(facts.judgeLabel, p.label);
    case 'and':
      return p.clauses.every((c) => evaluatePredicate(c, facts));
    case 'or':
      return p.clauses.some((c) => evaluatePredicate(c, facts));
    case 'not':
      return !evaluatePredicate(p.clause, facts);
    default:
      return false;
  }
}

function containsOp(
  p: CompiledPredicate,
  op: CompiledPredicate['op']
): boolean {
  if (p.op === op) return true;
  if (p.op === 'and' || p.op === 'or')
    return p.clauses.some((c) => containsOp(c, op));
  if (p.op === 'not') return containsOp(p.clause, op);
  return false;
}

export function selectEdge(node: FsmNode, facts: LeadFacts): EdgeSelection {
  const edges = [...node.edges].sort((a, b) => a.branchIndex - b.branchIndex);
  if (edges.length === 0) return { kind: 'hold', reason: 'no_edges' };

  // 1. Verbatim label match (Tega: "verbatim label match takes that branch").
  const verbatim = edges.find((e) =>
    sameLabel(facts.latestLeadText, e.branchLabel)
  );
  if (verbatim) return { kind: 'edge', edge: verbatim, reason: 'verbatim' };

  // 2. Compiled predicates, in branch order. Judge-only matches rank below
  //    structural ones so a deterministic source/data edge beats advice.
  const matched = edges.filter((e) => evaluatePredicate(e.predicate, facts));
  const structural = matched.filter(
    (e) =>
      !containsOp(e.predicate, 'judge_label_is') ||
      containsOp(e.predicate, 'source_is') ||
      e.predicate.op === 'always'
  );
  const pick = (structural.length > 0 ? structural : matched)[0];
  if (pick) {
    const reason: Extract<EdgeSelection, { kind: 'edge' }>['reason'] =
      pick.predicate.op === 'always'
        ? 'always'
        : containsOp(pick.predicate, 'source_is')
          ? 'source'
          : containsOp(pick.predicate, 'data_point_set') ||
              containsOp(pick.predicate, 'data_point_equals')
            ? 'data'
            : 'judge';
    return { kind: 'edge', edge: pick, reason };
  }

  // 3. Default edge.
  const def = edges.find((e) => e.isDefault);
  if (def) return { kind: 'edge', edge: def, reason: 'default' };

  return { kind: 'hold', reason: 'ambiguous_no_default' };
}

export function nodeForStep(
  fsm: CompiledScriptFsm,
  stepNumber: number
): FsmNode | null {
  return fsm.nodes.find((n) => n.stepNumber === stepNumber) ?? null;
}

export function nextStepNumber(
  fsm: CompiledScriptFsm,
  stepNumber: number
): number | null {
  const idx = fsm.nodes.findIndex((n) => n.stepNumber === stepNumber);
  if (idx < 0) return null;
  return fsm.nodes[idx + 1]?.stepNumber ?? null;
}

/** The completion that applies at this cursor: the selected edge's, else
 *  the default edge's, else the node's direct completion. */
export function completionAt(node: FsmNode, cursor: FsmCursor): CompletionSpec {
  const sel = cursor.selectedBranchLabel
    ? node.edges.find((e) =>
        sameLabel(e.branchLabel, cursor.selectedBranchLabel)
      )
    : null;
  return (
    (sel ?? node.edges.find((e) => e.isDefault))?.completion ?? node.completion
  );
}

export interface TransitionResult {
  cursor: FsmCursor;
  advanced: boolean;
  reason: string;
}

/** Advance at most one step per event. Monotonic: never moves backwards. */
export function fsmTransition(
  fsm: CompiledScriptFsm,
  cursor: FsmCursor,
  event: FsmEvent
): TransitionResult {
  const node = nodeForStep(fsm, cursor.stepNumber);
  if (!node) return { cursor, advanced: false, reason: 'unknown_step' };

  const advance = (why: string): TransitionResult => {
    const next = nextStepNumber(fsm, cursor.stepNumber);
    if (next === null) return { cursor, advanced: false, reason: 'terminal' };
    return {
      cursor: {
        ...cursor,
        stepNumber: next,
        selectedBranchLabel: null,
        completedSteps: cursor.completedSteps.includes(cursor.stepNumber)
          ? cursor.completedSteps
          : [...cursor.completedSteps, cursor.stepNumber]
      },
      advanced: true,
      reason: why
    };
  };

  if (event.type === 'EDGE_SELECTED') {
    const next: FsmCursor = {
      ...cursor,
      selectedBranchLabel: event.branchLabel
    };
    const edge = node.edges.find((e) =>
      sameLabel(e.branchLabel, event.branchLabel)
    );
    if (edge?.completion.kind === 'routing_only') {
      return {
        ...advance('routing_only_edge_selected'),
        cursor: { ...advance('x').cursor, selectedBranchLabel: null }
      };
    }
    return { cursor: next, advanced: false, reason: 'edge_selected' };
  }

  const completion = completionAt(node, cursor);
  if (event.type === 'LEAD_REPLIED') {
    if (
      completion.kind === 'lead_reply_after_ask' ||
      completion.kind === 'judgment_after_wait'
    ) {
      return advance(completion.kind);
    }
    return {
      cursor,
      advanced: false,
      reason: `lead_reply_does_not_complete_${completion.kind}`
    };
  }
  if (event.type === 'DELIVERABLES_SENT') {
    if (completion.kind === 'send_only') return advance('send_only');
    return {
      cursor,
      advanced: false,
      reason: `sent_does_not_complete_${completion.kind}`
    };
  }
  return { cursor, advanced: false, reason: 'no_op' };
}
