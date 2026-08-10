// ---------------------------------------------------------------------------
// Fix D — Phase 0: conversation state machine skeleton.
// ---------------------------------------------------------------------------
// SHADOW ONLY in Phase 0. Nothing in this module changes behavior; the
// machine's verdicts are computed alongside the live code paths and logged
// to EgressShadowLog for comparison. The live guards stay authoritative
// until the shadow diff is clean and Ali signs off (cutover exit criterion,
// FIX_D_STATE_MACHINE_PROPOSAL.md Phase 0).
//
// Design rule carried from the proposal: a held state is TERMINAL for
// outbound AI sends — only an explicit operator action releases it. The
// four typed holds replace the overloaded `awaitingHumanReview` boolean so
// an operator always knows WHY a conversation is held.
// ---------------------------------------------------------------------------

export type TypedHold =
  | 'HELD_DISTRESS'
  | 'HELD_SCHEDULING_CONFLICT'
  | 'HELD_OPERATOR_REVIEW'
  | 'HELD_GATE_EXHAUSTED';

export type ConversationPhase =
  | 'ACTIVE' // AI is driving normally
  | TypedHold
  | 'AI_OFF'; // operator disabled AI (aiActive=false) — not a hold, a mode

// The state the machine reasons over. Phase 0 derives this from the live
// Conversation row (the boolean-era columns); later phases make the machine
// the owner of these fields.
export interface MachineState {
  conversationId: string;
  phase: ConversationPhase;
  aiActive: boolean;
  // Script variables the machine knows are bound (Phase 0: names present in
  // capturedDataPoints with a non-empty value).
  boundVariables: Set<string>;
}

// Events are the ONLY way state changes once the machine owns state (Phase
// 1+). Phase 0 defines the vocabulary and the transition skeleton so shadow
// verdicts and later phases share one model.
export type MachineEvent =
  | { type: 'LEAD_MESSAGED' }
  | { type: 'DISTRESS_DETECTED' }
  | { type: 'SCHEDULING_CONFLICT_DETECTED' }
  | { type: 'GATE_EXHAUSTED' }
  | { type: 'ESCALATED_FOR_REVIEW' }
  | { type: 'OPERATOR_REPLIED' }
  | { type: 'OPERATOR_RELEASED_HOLD'; hold: TypedHold }
  | { type: 'OPERATOR_TOGGLED_AI'; active: boolean };

const HOLDS: readonly TypedHold[] = [
  'HELD_DISTRESS',
  'HELD_SCHEDULING_CONFLICT',
  'HELD_OPERATOR_REVIEW',
  'HELD_GATE_EXHAUSTED'
];

export function isHold(phase: ConversationPhase): phase is TypedHold {
  return (HOLDS as readonly string[]).includes(phase);
}

// Hold precedence when multiple boolean-era flags are set at once (a real
// case: distressDetected + awaitingHumanReview). Distress outranks
// everything; scheduling conflict outranks generic review.
export const HOLD_PRECEDENCE: readonly TypedHold[] = [
  'HELD_DISTRESS',
  'HELD_SCHEDULING_CONFLICT',
  'HELD_GATE_EXHAUSTED',
  'HELD_OPERATOR_REVIEW'
];

// Pure transition. Phase 0: exercised by tests and shadow derivation only.
export function transition(
  state: MachineState,
  event: MachineEvent
): MachineState {
  const to = (phase: ConversationPhase): MachineState => ({
    ...state,
    phase
  });

  switch (event.type) {
    case 'DISTRESS_DETECTED':
      // Highest-precedence hold; entered from anywhere.
      return to('HELD_DISTRESS');

    case 'SCHEDULING_CONFLICT_DETECTED':
      return state.phase === 'HELD_DISTRESS'
        ? state
        : to('HELD_SCHEDULING_CONFLICT');

    case 'GATE_EXHAUSTED':
      return isHold(state.phase) ? state : to('HELD_GATE_EXHAUSTED');

    case 'ESCALATED_FOR_REVIEW':
      return isHold(state.phase) ? state : to('HELD_OPERATOR_REVIEW');

    case 'OPERATOR_REPLIED':
      // An operator reply releases every hold EXCEPT distress, which needs
      // an explicit release (terminal-state protection, F1).
      return isHold(state.phase) && state.phase !== 'HELD_DISTRESS'
        ? to('ACTIVE')
        : state;

    case 'OPERATOR_RELEASED_HOLD':
      return state.phase === event.hold ? to('ACTIVE') : state;

    case 'OPERATOR_TOGGLED_AI':
      return { ...state, aiActive: event.active };

    case 'LEAD_MESSAGED':
      // A lead message never releases a hold by itself.
      return state;
  }
}
