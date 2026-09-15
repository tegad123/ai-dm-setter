// ---------------------------------------------------------------------------
// script-fsm/compiler.ts — compile a script (parser output OR persisted rows)
// into a CompiledScriptFsm. Pure; no DB, no LLM.
// ---------------------------------------------------------------------------
// Ground truth from prod (2026-09-11): real scripts carry NO machine rules —
// routingRules / completionRule / stateKey / requiredDataPoints are null on
// every step. The only signals are the ordered actions, the branch labels
// and the prose conditionDescription ("Always taken on entry…", "Lead's
// reply says they already trade…"). So predicates are derived from:
//   1. structure — a step-1 branch that opens with a send_message before
//      its first wait is the warm/inbound branch; one that opens with a
//      runtime_judgment is the ManyChat pick-up branch (same rule as
//      script-serializer.selectStep1BranchesForPrompt, 2026-09-11);
//   2. prose — "always taken" / "taken on entry" / a lone "Default" label
//      → the unconditional edge;
//   3. otherwise the branch is an advisory-judge classification among its
//      siblings (judge_label_is) with verbatim-label match ahead of it.
// Exactly one default per multi-edge node: an explicit always/default
// branch, else the LAST branch as an implicit default (warning), so the
// runtime can never end up with no edge and an empty required set.
// ---------------------------------------------------------------------------

import { collectPostWaitContents } from '@/lib/state-machine/egress-guards';
import {
  COMPILER_VERSION,
  type CompileDiagnostic,
  type CompiledPredicate,
  type CompiledScriptFsm,
  type CompletionSpec,
  type Deliverable,
  type FsmEdge,
  type FsmNode
} from './types';

// A shape both the parser output (ParsedStep) and the persisted rows satisfy
// after a thin adapter.
export interface CompilableAction {
  actionType: string;
  content?: string | null;
  linkUrl?: string | null;
  linkLabel?: string | null;
  waitDuration?: number | null;
  sortOrder?: number | null;
}
export interface CompilableBranch {
  branchLabel: string;
  conditionDescription?: string | null;
  sortOrder?: number | null;
  actions: CompilableAction[];
}
export interface CompilableStep {
  stepNumber: number;
  title: string;
  actions?: CompilableAction[];
  branches: CompilableBranch[];
}

const WAIT_TYPES = new Set(['wait_for_response', 'wait_duration']);
const SUBSTANTIVE = new Set([
  'send_message',
  'ask_question',
  'runtime_judgment',
  'send_link',
  'send_video',
  'send_voice_note',
  'form_reference'
]);

function sorted<T extends { sortOrder?: number | null }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

export function toDeliverables(actions: CompilableAction[]): Deliverable[] {
  const out: Deliverable[] = [];
  for (const a of sorted(actions)) {
    const text = (a.content ?? '').trim();
    switch (a.actionType) {
      case 'send_message':
        if (text) out.push({ kind: 'send_message', text });
        break;
      case 'ask_question':
        if (text) out.push({ kind: 'ask', text });
        break;
      case 'send_link':
        out.push({
          kind: 'send_link',
          url: a.linkUrl ?? null,
          label: a.linkLabel ?? null
        });
        break;
      case 'send_video':
      case 'send_voice_note':
      case 'form_reference':
        out.push({ kind: a.actionType, ref: text || null });
        break;
      case 'wait_for_response':
        out.push({ kind: 'wait', waitKind: 'response', durationMs: null });
        break;
      case 'wait_duration':
        out.push({
          kind: 'wait',
          waitKind: 'duration',
          durationMs: a.waitDuration != null ? a.waitDuration * 1000 : null
        });
        break;
      case 'runtime_judgment':
        out.push({ kind: 'runtime_judgment', text });
        break;
      default:
        break;
    }
  }
  return out;
}

/** What credits a sequence of actions as complete. Generalises the six
 *  history-rescan detectors in script-state-recovery (hasRuntimeJudgmentAfterWait,
 *  pathIsAutoCompletableRoutingOnly, …) into one declarative spec. */
export function deriveCompletion(actions: CompilableAction[]): CompletionSpec {
  const seq = sorted(actions);
  const hasAsk = seq.some((a) => a.actionType === 'ask_question');
  const waitCount = seq.filter((a) => WAIT_TYPES.has(a.actionType)).length;
  const hasWait = waitCount > 0;
  const waits = Math.max(1, waitCount);
  const hasJudgment = seq.some((a) => a.actionType === 'runtime_judgment');
  if (hasWait && hasJudgment && !hasAsk)
    return { kind: 'judgment_after_wait', waits };
  if (hasWait && hasAsk) return { kind: 'lead_reply_after_ask', waits };
  if (hasWait) return { kind: 'judgment_after_wait', waits };
  if (hasJudgment && !hasAsk) return { kind: 'routing_only' };
  if (hasAsk) return { kind: 'lead_reply_after_ask', waits }; // ask without wait → validator flags it
  return { kind: 'send_only' };
}

const SOURCE_ROUTED_RE =
  /\b(manychat|many chat|flow origin|came in through|from the flow|comment automation|dm'?d directly|direct dm)\b/i;

/** Does step 1 route on where the lead came FROM (ManyChat pick-up vs direct
 *  DM)? True only when a branch label or condition says so in words. */
export function stepIsSourceRouted(
  branches: Array<{
    branchLabel: string;
    conditionDescription?: string | null;
  }>
): boolean {
  return branches.some((b) =>
    SOURCE_ROUTED_RE.test(`${b.branchLabel} ${b.conditionDescription ?? ''}`)
  );
}

const ALWAYS_RE =
  /\b(always taken|taken on entry|always on entry|unconditional)\b/i;
const DEFAULT_LABEL_RE = /^\s*default\b/i;

function opensWith(
  actions: CompilableAction[]
): 'opener' | 'judgment' | 'other' {
  for (const a of sorted(actions)) {
    if (WAIT_TYPES.has(a.actionType)) return 'other';
    if (a.actionType === 'send_message') return 'opener';
    if (a.actionType === 'runtime_judgment') return 'judgment';
    if (SUBSTANTIVE.has(a.actionType)) return 'other';
  }
  return 'other';
}

function nodeId(stepNumber: number): string {
  return `step-${stepNumber}`;
}

export function compileScript(steps: CompilableStep[]): CompiledScriptFsm {
  const diagnostics: CompileDiagnostic[] = [];
  const ordered = [...steps].sort((a, b) => a.stepNumber - b.stepNumber);
  const nodes: FsmNode[] = [];

  ordered.forEach((step, idx) => {
    const next = ordered[idx + 1];
    const toNodeId = next ? nodeId(next.stepNumber) : nodeId(step.stepNumber);
    const branches = sorted(step.branches ?? []);
    const direct = step.actions ?? [];

    // Step gaps: nothing links to a skipped number; keep linear order but flag.
    if (next && next.stepNumber !== step.stepNumber + 1) {
      diagnostics.push({
        severity: 'warning',
        code: 'step_gap',
        stepNumber: step.stepNumber,
        message: `Step ${step.stepNumber} is followed by step ${next.stepNumber}; numbering has a gap.`
      });
    }

    // Duplicate labels break verbatim-label routing.
    const seen = new Map<string, number>();
    for (const b of branches) {
      const k = b.branchLabel.trim().toLowerCase();
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, n] of Array.from(seen.entries())) {
      if (n > 1) {
        diagnostics.push({
          severity: 'error',
          code: 'duplicate_branch_label',
          stepNumber: step.stepNumber,
          branchLabel: k,
          message: `Step ${step.stepNumber} has ${n} branches labelled "${k}"; labels must be unique for routing.`
        });
      }
    }

    // Empty step: nothing to deliver, nothing to judge.
    const allActions = [...direct, ...branches.flatMap((b) => b.actions)];
    if (!allActions.some((a) => SUBSTANTIVE.has(a.actionType))) {
      diagnostics.push({
        severity: 'error',
        code: 'empty_step',
        stepNumber: step.stepNumber,
        message: `Step ${step.stepNumber} ("${step.title}") has no message, question, link or judgment — the machine could never act on it.`
      });
    }

    // Ask without any wait in the same sequence: the completion machinery
    // can never credit the answer (Tega: "asks the completion machinery
    // cannot credit").
    const sequences = [direct, ...branches.map((b) => b.actions)];
    for (const seq of sequences) {
      const s = sorted(seq);
      const hasAsk = s.some((a) => a.actionType === 'ask_question');
      const hasWait = s.some((a) => WAIT_TYPES.has(a.actionType));
      if (hasAsk && !hasWait) {
        diagnostics.push({
          severity: 'error',
          code: 'ask_without_wait',
          stepNumber: step.stepNumber,
          message: `Step ${step.stepNumber} asks a question but never waits for the reply; add a [WAIT] after the question so the answer can be credited.`
        });
      }
    }

    // Edges. Source routing (ManyChat pick-up vs direct DM) is a STRUCTURAL
    // rule only when the script's first step is actually written that way —
    // a branch that names ManyChat / flow origin. A first step whose branches
    // key on message CONTENT (Daniel v2: "Already answered", "Cold inbound",
    // "Solicitation", "Distress", "No signal") is routed by content: verbatim
    // label, then the advisory judge. Forcing source routing there hid every
    // content branch behind "Cold inbound" (Tega's 28 misroutes, Sept 14).
    const isStep1 = idx === 0 && stepIsSourceRouted(branches);
    const edges: FsmEdge[] = branches.map((b, bi) => {
      const cond = b.conditionDescription ?? '';
      const structural = opensWith(b.actions);
      let predicate: CompiledPredicate;
      let derivedFrom: FsmEdge['derivedFrom'];
      if (branches.length === 1) {
        predicate = { op: 'always' };
        derivedFrom = 'always';
      } else if (isStep1 && structural === 'opener') {
        predicate = {
          op: 'or',
          clauses: [
            { op: 'source_is', source: 'INBOUND' },
            { op: 'source_is', source: 'OUTBOUND' }
          ]
        };
        derivedFrom = 'source';
      } else if (isStep1 && structural === 'judgment') {
        predicate = { op: 'source_is', source: 'MANYCHAT' };
        derivedFrom = 'source';
      } else if (
        ALWAYS_RE.test(cond) &&
        !/\b(when|if)\b/i.test(cond.slice(0, 40))
      ) {
        predicate = { op: 'always' };
        derivedFrom = 'always';
      } else {
        predicate = {
          op: 'or',
          clauses: [
            { op: 'verbatim_label', label: b.branchLabel },
            { op: 'judge_label_is', label: b.branchLabel }
          ]
        };
        derivedFrom = 'judge';
      }
      return {
        branchLabel: b.branchLabel,
        branchIndex: bi,
        toNodeId,
        predicate,
        isDefault: false,
        derivedFrom,
        deliverables: toDeliverables(b.actions),
        completion: deriveCompletion(b.actions)
      };
    });

    // Exactly one default on multi-edge nodes.
    if (edges.length > 1) {
      // Order matters: an unconditional edge, then — on a source-routed step
      // 1 — the warm/inbound opener edge (a lead whose source we cannot tell
      // is a direct DM, not a ManyChat pick-up, whatever the branch is
      // LABELLED), then explicit "Default"-style labels/prose, then last.
      let def =
        edges.find((e) => e.predicate.op === 'always') ??
        edges.find(
          (e) => e.derivedFrom === 'source' && e.predicate.op === 'or'
        ) ??
        edges.find((e) => DEFAULT_LABEL_RE.test(e.branchLabel)) ??
        edges.find((e) =>
          /\b(default|vague|unsure|no clear|otherwise|else)\b/i.test(
            e.branchLabel +
              ' ' +
              (branches[e.branchIndex].conditionDescription ?? '')
          )
        );
      if (!def) {
        def = edges[edges.length - 1];
        diagnostics.push({
          severity: 'warning',
          code: 'implicit_default',
          stepNumber: step.stepNumber,
          branchLabel: def.branchLabel,
          message: `Step ${step.stepNumber} has ${edges.length} branches and no explicit default; "${def.branchLabel}" (last) is the fallback when the reply matches nothing. Add a "Default" branch to make this explicit.`
        });
      }
      def.isDefault = true;
    } else if (edges.length === 1) {
      edges[0].isDefault = true;
    }

    nodes.push({
      id: nodeId(step.stepNumber),
      stepNumber: step.stepNumber,
      title: step.title,
      deliverables: toDeliverables(direct),
      completion: deriveCompletion(edges.length ? branches[0].actions : direct),
      edges,
      isTerminal: !next
    });
  });

  // Reachability: linear chain + edges all point to the next node, so every
  // node is reachable iff the chain is contiguous from the first step.
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const e of n.edges) {
      if (!ids.has(e.toNodeId)) {
        diagnostics.push({
          severity: 'error',
          code: 'unreachable_step',
          stepNumber: n.stepNumber,
          branchLabel: e.branchLabel,
          message: `Step ${n.stepNumber} branch "${e.branchLabel}" points to a step that does not exist.`
        });
      }
    }
  }
  if (nodes.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'empty_step',
      stepNumber: null,
      message: 'Script has no steps.'
    });
  }

  return {
    compilerVersion: COMPILER_VERSION,
    compiledAt: new Date().toISOString(),
    entryNodeId: nodes[0]?.id ?? nodeId(1),
    nodes,
    diagnostics
  };
}

/** Adapter: parser output (ParsedScript.steps) → compilable steps, so the
 *  upload routes can validate BEFORE persisting. Parser actions have no
 *  sortOrder; array order is the order. */
export function parsedScriptToCompilable(
  steps: Array<{
    stepNumber: number;
    title: string;
    branches: Array<{
      label: string;
      conditionDescription: string | null;
      actions: Array<{
        actionType: string;
        content: string | null;
        linkUrl?: string | null;
        linkLabel?: string | null;
        waitDuration?: number | null;
      }>;
    }>;
  }>
): CompilableStep[] {
  return steps.map((s) => ({
    stepNumber: s.stepNumber,
    title: s.title,
    actions: [],
    branches: s.branches.map((b, bi) => ({
      branchLabel: b.label,
      conditionDescription: b.conditionDescription,
      sortOrder: bi,
      actions: b.actions.map((a, ai) => ({
        actionType: a.actionType,
        content: a.content,
        linkUrl: a.linkUrl ?? null,
        linkLabel: a.linkLabel ?? null,
        waitDuration: a.waitDuration ?? null,
        sortOrder: ai
      }))
    }))
  }));
}

export const REJECT_ON_INVALID =
  process.env.FIX_D_ROUTING_REJECT_ON_INVALID === 'true';

export function hasCompileErrors(fsm: CompiledScriptFsm): boolean {
  return fsm.diagnostics.some((d) => d.severity === 'error');
}

/** Human-readable error list for the upload UI. */
export function formatCompileErrors(fsm: CompiledScriptFsm): string[] {
  return fsm.diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => d.message);
}

/** Post-wait copy per node, for the Wait-boundary guard — same derivation. */
export function postWaitCopyForNode(node: FsmNode): string[] {
  const fake = {
    actions: node.deliverables.map(deliverableToActionLike),
    branches: node.edges.map((e) => ({
      actions: e.deliverables.map(deliverableToActionLike)
    }))
  };
  return collectPostWaitContents(fake);
}

function deliverableToActionLike(d: Deliverable, i: number) {
  const type =
    d.kind === 'ask'
      ? 'ask_question'
      : d.kind === 'wait'
        ? d.waitKind === 'response'
          ? 'wait_for_response'
          : 'wait_duration'
        : d.kind;
  const content = 'text' in d ? d.text : null;
  return { actionType: type, content, sortOrder: i };
}
