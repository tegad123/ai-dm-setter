// ---------------------------------------------------------------------------
// Fix D — Phase 1: interrupt layer.
// ---------------------------------------------------------------------------
// Certain lead intents — "how much is it", "is this a scam", "I don't have
// time" — must be ANSWERED on the turn they arrive, regardless of what step
// the funnel is on or which branch the token/LLM router picks. The old
// approach expressed these as script branches and relied on branch routing
// to select them; routing picks ONE branch per turn, so a bundle that
// carries both a normal answer and a price question loses the price intent
// (Tega item 2, 2026-07-28). The temporary fix for that lived inline in
// ai-engine and only covered price.
//
// This layer generalizes it: detect the interrupt intent in the inbound
// message BEFORE branch routing, find the matching branch on the current
// step (by label), and return its scripted answer copy so the caller can
// surface it deterministically. Intent detection is a table of cue
// patterns; the ANSWER always comes from the persona's own configured
// branch copy, never a hardcoded string — so nothing tenant-specific
// leaks and unconfigured personas simply produce no interrupt.
//
// Position is deliberately untouched: an interrupt answers in place and
// does not advance currentScriptStep (the caller must not mark the step
// complete off an interrupt turn).
// ---------------------------------------------------------------------------

import type { ScriptBranch, ScriptStep } from './script-types';

export type InterruptKind = 'price' | 'objection_scam' | 'objection_time';

interface InterruptDef {
  kind: InterruptKind;
  // Cue in the inbound lead message.
  cue: RegExp;
  // Branch label on the current step whose scripted copy answers this
  // interrupt. Matched case-insensitively against branchLabel.
  branchLabelCue: RegExp;
}

// Order matters: first match wins. Price is most specific, checked first.
const INTERRUPTS: readonly InterruptDef[] = [
  {
    kind: 'price',
    cue: /\b(how\s+much|price|cost|do\s+i\s+(have\s+to\s+)?pay|is\s+(it|the\s+link|this)\s+(actually\s+|really\s+)?free|any\s+catch)\b/i,
    branchLabelCue: /price|cost|how\s*much/i
  },
  {
    kind: 'objection_scam',
    cue: /\b(scam|legit|real\s+or\s+fake|is\s+this\s+(a\s+)?(scam|fake|real)|too\s+good\s+to\s+be\s+true|you\s+trying\s+to\s+(rob|scam))\b/i,
    branchLabelCue: /scam|legit|trust|objection.*scam/i
  },
  {
    kind: 'objection_time',
    cue: /\b(no\s+time|don'?t\s+have\s+(the\s+)?time|too\s+busy|not\s+enough\s+time|how\s+(much\s+)?time\s+(does|will)\s+(it|this)\s+take)\b/i,
    branchLabelCue: /time|busy|objection.*time/i
  }
];

const PLACEHOLDER_RE = /\{\{[^}]+\}\}/;

function firstScriptedMessage(branch: ScriptBranch | undefined): string | null {
  if (!branch) return null;
  const msg = branch.actions.find(
    (a) =>
      a.actionType === 'send_message' &&
      typeof a.content === 'string' &&
      a.content.trim().length > 0
  )?.content;
  const trimmed = msg?.trim() ?? '';
  // Unresolved placeholders would ship a broken bubble — decline instead.
  if (!trimmed || PLACEHOLDER_RE.test(trimmed)) return null;
  return trimmed;
}

export interface InterruptMatch {
  kind: InterruptKind;
  branchLabel: string;
  answerCopy: string;
}

// Detect an interrupt intent in the inbound message and resolve its answer
// from the current step's branches. Returns null when no interrupt applies,
// no matching branch exists, or the branch copy is unusable (empty /
// placeholder). Pure and synchronous — safe to call before branch routing.
export function detectInterrupt(
  leadMessage: string | null | undefined,
  currentStep: ScriptStep | null | undefined
): InterruptMatch | null {
  if (!leadMessage || !currentStep) return null;
  const branches = currentStep.branches ?? [];
  if (branches.length === 0) return null;

  for (const def of INTERRUPTS) {
    if (!def.cue.test(leadMessage)) continue;
    const branch = branches.find((b) =>
      def.branchLabelCue.test(b.branchLabel ?? '')
    );
    const answerCopy = firstScriptedMessage(branch);
    if (branch && answerCopy) {
      return { kind: def.kind, branchLabel: branch.branchLabel, answerCopy };
    }
    // Cue matched but this step has no usable answer branch for it. Keep
    // scanning: the message may also match a different interrupt that DOES
    // have a branch here (e.g. "how much time does this take" matches the
    // price cue but the step only carries a time-objection branch). If
    // nothing matches, routing handles it normally.
  }
  return null;
}
