// ---------------------------------------------------------------------------
// Fix D — Phase 0: canSend, the single egress gate (SHADOW ONLY this phase).
// ---------------------------------------------------------------------------
// Every outbound message will pass through one canSend(state, draft) before
// it leaves — generation, exhaustion fallback, drip, recovery cron. In
// Phase 0 the verdict is computed and logged, never enforced; the live
// guards (awaitingHumanReview patch 9e55a78 + send-time re-gate 0d3287f)
// stay authoritative until the shadow diff is clean.
// ---------------------------------------------------------------------------

import {
  type MachineState,
  type TypedHold,
  HOLD_PRECEDENCE,
  isHold
} from './types';

export type CanSendVerdict =
  | { allow: true }
  | {
      allow: false;
      reason:
        | 'HOLD' // conversation is in a terminal hold
        | 'AI_OFF' // operator disabled AI
        | 'UNSET_VARIABLE' // draft references a variable that isn't bound
        | 'NO_CONVERSATION_STATE'; // can't resolve the conversation to gate on
      hold?: TypedHold;
      detail: string;
    };

// Unresolved template artifacts that must never reach a lead. Catches raw
// {{var}} / {var} leftovers and the known sentinel strings the variable
// resolver emits when a binding is missing.
//
// The final alternation catches ALL-CAPS bracketed placeholders like
// "[BOOKING LINK]" / "[FIRST NAME]" — the class that leaked to a lead in the
// Steven Petty P0 (2026-04-20). It mirrors the ship-time regex already proven
// at webhook-processor.ts (`/\[[A-Z][A-Z0-9 _]{2,}\]/`) but sits here so EVERY
// send path (crons, keepalive, call-confirmation) gets the protection, not
// just the sendAIReply path. The first char is required UPPERCASE so natural
// lowercase asides ("[note]", "[link]") don't false-fire — a leaked template
// token is always an upper-case slot name.
const UNRESOLVED_VARIABLE_RE =
  /\{\{[^}]*\}\}|(?<![\w$])\{[a-zA-Z_][a-zA-Z0-9_]*\}|\[unknown\]|\bundefined, \b|\[[A-Z][A-Z0-9 _]{2,}\]/;

// Thrown by a send function when the egress gate (authoritative mode) blocks
// the send. Callers can catch it to distinguish a policy block from a
// platform/network send failure.
export class EgressBlockedError extends Error {
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'EgressBlockedError';
    this.reason = reason;
  }
}

export interface CanSendDraft {
  text: string;
  // true when a HUMAN operator initiated this send (manual reply, approved
  // suggestion). Operator sends bypass hold blocking — replying manually to
  // a held conversation is exactly what the hold asks for.
  operatorInitiated: boolean;
  // true for the ONE F1 distress supportive reply sent at detection time.
  // Pending Tega's decision (2026-09-11): the machine's HELD_DISTRESS rule
  // has been blocking this reply on Facebook since the Aug 18 cutover
  // (five leads, Message row saved, platformMessageId null) while the F1
  // flow intends it to ship once. With FIX_D_DISTRESS_SUPPORTIVE_EXEMPT=true
  // that single reply passes a HELD_DISTRESS hold; everything else on the
  // conversation still holds. Default off = current Facebook behaviour.
  distressSupportive?: boolean;
}

const DISTRESS_SUPPORTIVE_EXEMPT =
  process.env.FIX_D_DISTRESS_SUPPORTIVE_EXEMPT === 'true';

export function canSend(
  state: MachineState,
  draft: CanSendDraft
): CanSendVerdict {
  if (draft.operatorInitiated) {
    return { allow: true };
  }

  if (!state.aiActive || state.phase === 'AI_OFF') {
    return {
      allow: false,
      reason: 'AI_OFF',
      detail: 'operator disabled AI for this conversation'
    };
  }

  if (isHold(state.phase)) {
    if (
      state.phase === 'HELD_DISTRESS' &&
      draft.distressSupportive === true &&
      DISTRESS_SUPPORTIVE_EXEMPT
    ) {
      return { allow: true };
    }
    return {
      allow: false,
      reason: 'HOLD',
      hold: state.phase,
      detail: `conversation is ${state.phase}; only an operator action releases it`
    };
  }

  const m = UNRESOLVED_VARIABLE_RE.exec(draft.text);
  if (m) {
    return {
      allow: false,
      reason: 'UNSET_VARIABLE',
      detail: `draft contains unresolved variable artifact "${m[0]}"`
    };
  }

  return { allow: true };
}

// Derive the machine's view of a conversation from the boolean-era columns.
// This is the Phase 0 bridge: the shadow compares "what the machine would
// hold" against what the live flags say. `qualityGateHeld` distinguishes
// HELD_GATE_EXHAUSTED from generic HELD_OPERATOR_REVIEW when the
// awaitingHumanReview boolean is set.
export function deriveMachineState(row: {
  id: string;
  aiActive: boolean;
  distressDetected: boolean;
  schedulingConflict: boolean;
  awaitingHumanReview: boolean;
  qualityGateHeld?: boolean;
  boundVariables?: Set<string>;
}): MachineState {
  const holds: TypedHold[] = [];
  if (row.distressDetected) holds.push('HELD_DISTRESS');
  if (row.schedulingConflict) holds.push('HELD_SCHEDULING_CONFLICT');
  if (row.awaitingHumanReview) {
    holds.push(
      row.qualityGateHeld ? 'HELD_GATE_EXHAUSTED' : 'HELD_OPERATOR_REVIEW'
    );
  }

  const phase = !row.aiActive
    ? ('AI_OFF' as const)
    : (HOLD_PRECEDENCE.find((h) => holds.includes(h)) ?? ('ACTIVE' as const));

  return {
    conversationId: row.id,
    phase,
    aiActive: row.aiActive,
    boundVariables: row.boundVariables ?? new Set()
  };
}
