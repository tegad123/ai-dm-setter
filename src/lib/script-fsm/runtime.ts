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
import { matchScriptedCopy } from '@/lib/state-machine/copy-match';
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

export function initialCursor(fsm: CompiledScriptFsm): FsmCursor {
  const first = fsm.nodes[0]?.stepNumber ?? 1;
  return {
    stepNumber: first,
    selectedBranchLabel: null,
    completedSteps: [],
    compilerVersion: fsm.compilerVersion,
    repliesInStep: 0,
    spokeInStep: false
  };
}

function deliverableTexts(edge: FsmEdge): string[] {
  const out: string[] = [];
  for (const d of edge.deliverables) {
    if (d.kind === 'send_message' || d.kind === 'ask') out.push(d.text);
  }
  return out;
}

/** Which branch did we actually deliver? When the judge's pick is unknown
 *  (history fold, shadow), the branch whose scripted copy went out is the
 *  branch we are on — structural, script-independent, no label guessing. */
export function inferEdgeFromCopy(node: FsmNode, text: string): FsmEdge | null {
  if (node.edges.length < 2) return null;
  // Exactly one branch must own the copy: an ask shared by two branches
  // (Daniel's step 1 asks "where are you based" on both) proves nothing.
  const hits = node.edges.filter((e) =>
    matchScriptedCopy(text, deliverableTexts(e))
  );
  return hits.length === 1 ? hits[0] : null;
}

/** Advance at most one step per event. Monotonic: never moves backwards.
 *
 *  Credit rules (M5 item 4): a lead reply counts toward a branch only if we
 *  spoke in the step first (`spokeInStep`); a branch with N wait boundaries
 *  needs N credited replies. Routing-only and send-only branches complete on
 *  our own outbound turn (the judgment reaction / the deliverables went out). */
export function fsmTransition(
  fsm: CompiledScriptFsm,
  cursor: FsmCursor,
  event: FsmEvent
): TransitionResult {
  const node = nodeForStep(fsm, cursor.stepNumber);
  if (!node) return { cursor, advanced: false, reason: 'unknown_step' };

  const advance = (why: string, carrySpoke: boolean): TransitionResult => {
    const next = nextStepNumber(fsm, cursor.stepNumber);
    if (next === null) return { cursor, advanced: false, reason: 'terminal' };
    return {
      cursor: {
        ...cursor,
        stepNumber: next,
        selectedBranchLabel: null,
        completedSteps: cursor.completedSteps.includes(cursor.stepNumber)
          ? cursor.completedSteps
          : [...cursor.completedSteps, cursor.stepNumber],
        repliesInStep: 0,
        spokeInStep: carrySpoke
      },
      advanced: true,
      reason: why
    };
  };

  if (event.type === 'EDGE_SELECTED') {
    const edge = node.edges.find((e) =>
      sameLabel(e.branchLabel, event.branchLabel)
    );
    if (edge?.completion.kind === 'routing_only') {
      return advance('routing_only_edge_selected', false);
    }
    return {
      cursor: { ...cursor, selectedBranchLabel: event.branchLabel },
      advanced: false,
      reason: 'edge_selected'
    };
  }

  if (event.type === 'OUTBOUND') {
    let c = cursor;
    if (!c.selectedBranchLabel) {
      const inferred = inferEdgeFromCopy(node, event.text);
      if (inferred) c = { ...c, selectedBranchLabel: inferred.branchLabel };
    }
    const completion = completionAt(node, c);
    // Routing-only / send-only complete on this outbound. Nothing is carried
    // into the next node: the next step's opener/ask arrives as its own
    // message and marks `spokeInStep` there. (Carrying it credited a freelance
    // question as the next step's ask — conv cmtws66km0003l504a5toczil.)
    if (completion.kind === 'send_only') {
      return advance('send_only', false);
    }
    if (completion.kind === 'routing_only') {
      return advance('routing_only_outbound', false);
    }
    return {
      cursor: { ...c, spokeInStep: true },
      advanced: false,
      reason:
        c.selectedBranchLabel && !cursor.selectedBranchLabel
          ? 'outbound_branch_inferred'
          : 'outbound'
    };
  }

  // LEAD_REPLIED
  const completion = completionAt(node, cursor);
  if (!cursor.spokeInStep) {
    return { cursor, advanced: false, reason: 'reply_before_outbound' };
  }
  if (
    completion.kind === 'lead_reply_after_ask' ||
    completion.kind === 'judgment_after_wait'
  ) {
    const replies = cursor.repliesInStep + 1;
    if (replies >= completion.waits) return advance(completion.kind, false);
    return {
      cursor: { ...cursor, repliesInStep: replies, spokeInStep: false },
      advanced: false,
      reason: `awaiting_more_replies_${replies}_of_${completion.waits}`
    };
  }
  return {
    cursor,
    advanced: false,
    reason: `lead_reply_does_not_complete_${completion.kind}`
  };
}

// ── History fold ─────────────────────────────────────────────────────────────

export interface FoldMessage {
  sender: string;
  content: string;
}

export interface FoldStep {
  index: number;
  from: number;
  to: number;
  reason: string;
}

export interface FoldResult {
  cursor: FsmCursor;
  /** Every advance, in order (for traces / shadow review). */
  advances: FoldStep[];
  /** Reason of the last event applied (advance or not). */
  lastReason: string;
}

/** The machine's position as a pure function of the conversation so far:
 *  fold every message through `fsmTransition` from the entry node. LEAD
 *  messages are replies; AI and HUMAN messages are our outbound turns;
 *  everything else (ManyChat automations, system rows) is not a script
 *  deliverable and is skipped. `labelForStep` (optional) supplies the branch
 *  the judge actually selected for a step — the legacy ledger during shadow,
 *  the FSM's own selection once authoritative — and is consulted only while
 *  the cursor has no selection for that step. */
export interface FoldOptions {
  labelForStep?: (stepNumber: number) => string | null;
  /** Start the machine at this step instead of the entry node (a history
   *  whose frame begins mid-script, or a cursor seeded from legacy). */
  startStep?: number;
  /** Structural facts that decide edges without a judge: the lead's source
   *  (step-1 ManyChat pick-up vs warm inbound) and captured data points. */
  source?: LeadFacts['source'];
  dataPoints?: LeadFacts['dataPoints'];
}

const STRUCTURAL_REASONS = new Set(['source', 'always', 'data']);

export function foldHistory(
  fsm: CompiledScriptFsm,
  messages: FoldMessage[],
  opts: FoldOptions = {}
): FoldResult {
  const { labelForStep, startStep } = opts;
  let cursor = initialCursor(fsm);
  if (startStep != null && nodeForStep(fsm, startStep)) {
    cursor = { ...cursor, stepNumber: startStep };
  }
  const advances: FoldStep[] = [];
  let lastReason = 'empty_history';
  messages.forEach((m, index) => {
    const sender = (m.sender ?? '').toUpperCase();
    let event: FsmEvent | null = null;
    if (sender === 'LEAD') event = { type: 'LEAD_REPLIED', text: m.content };
    else if (sender === 'AI' || sender === 'HUMAN')
      event = { type: 'OUTBOUND', text: m.content, sender };
    if (!event) return;
    if (!cursor.selectedBranchLabel) {
      const node = nodeForStep(fsm, cursor.stepNumber);
      // 1. The branch the judge actually selected (ledger), if it exists.
      const label = labelForStep?.(cursor.stepNumber) ?? null;
      if (label && node?.edges.some((e) => sameLabel(e.branchLabel, label))) {
        cursor = { ...cursor, selectedBranchLabel: label };
      } else if (node && node.edges.length > 1) {
        // 2. A structurally decidable edge (source / always / data) — never
        //    the judge or the default, which would fix a guess as a fact.
        const sel = selectEdge(node, {
          source: opts.source ?? null,
          latestLeadText: null,
          dataPoints: opts.dataPoints ?? {},
          judgeLabel: null
        });
        if (sel.kind === 'edge' && STRUCTURAL_REASONS.has(sel.reason)) {
          cursor = { ...cursor, selectedBranchLabel: sel.edge.branchLabel };
        }
      }
    }
    const from = cursor.stepNumber;
    const t = fsmTransition(fsm, cursor, event);
    cursor = t.cursor;
    lastReason = t.reason;
    if (t.advanced)
      advances.push({ index, from, to: cursor.stepNumber, reason: t.reason });
  });
  return { cursor, advances, lastReason };
}
