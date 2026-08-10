// Fix D Phase 0 — unit tests for the transition skeleton + canSend verdicts.
// Run: NODE_PATH=$PWD/node_modules npx tsx scripts/test-state-machine.ts

import {
  transition,
  type MachineState,
  type MachineEvent
} from '../src/lib/state-machine/types';
import { canSend, deriveMachineState } from '../src/lib/state-machine/can-send';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

const base: MachineState = {
  conversationId: 'c1',
  phase: 'ACTIVE',
  aiActive: true,
  boundVariables: new Set()
};
const at = (phase: MachineState['phase']): MachineState => ({
  ...base,
  phase
});
const ev = (e: MachineEvent, s: MachineState) => transition(s, e);

// ── transition: hold entry ──────────────────────────────────────────
check(
  'distress enters HELD_DISTRESS from anywhere',
  ev({ type: 'DISTRESS_DETECTED' }, at('HELD_GATE_EXHAUSTED')).phase ===
    'HELD_DISTRESS'
);
check(
  'gate exhaustion holds an ACTIVE conversation',
  ev({ type: 'GATE_EXHAUSTED' }, base).phase === 'HELD_GATE_EXHAUSTED'
);
check(
  'gate exhaustion does NOT downgrade an existing distress hold',
  ev({ type: 'GATE_EXHAUSTED' }, at('HELD_DISTRESS')).phase === 'HELD_DISTRESS'
);
check(
  'scheduling conflict does not override distress',
  ev({ type: 'SCHEDULING_CONFLICT_DETECTED' }, at('HELD_DISTRESS')).phase ===
    'HELD_DISTRESS'
);

// ── transition: release semantics (F1 terminal-state protection) ───
check(
  'operator reply releases a gate hold',
  ev({ type: 'OPERATOR_REPLIED' }, at('HELD_GATE_EXHAUSTED')).phase === 'ACTIVE'
);
check(
  'operator reply does NOT release a distress hold',
  ev({ type: 'OPERATOR_REPLIED' }, at('HELD_DISTRESS')).phase ===
    'HELD_DISTRESS'
);
check(
  'explicit release clears distress',
  ev(
    { type: 'OPERATOR_RELEASED_HOLD', hold: 'HELD_DISTRESS' },
    at('HELD_DISTRESS')
  ).phase === 'ACTIVE'
);
check(
  'release of the WRONG hold type is a no-op',
  ev(
    { type: 'OPERATOR_RELEASED_HOLD', hold: 'HELD_GATE_EXHAUSTED' },
    at('HELD_DISTRESS')
  ).phase === 'HELD_DISTRESS'
);
check(
  'lead message never releases a hold',
  ev({ type: 'LEAD_MESSAGED' }, at('HELD_GATE_EXHAUSTED')).phase ===
    'HELD_GATE_EXHAUSTED'
);

// ── canSend verdicts ────────────────────────────────────────────────
const draft = (text: string, operatorInitiated = false) => ({
  text,
  operatorInitiated
});
check('ACTIVE conversation sends', canSend(base, draft('hey bro')).allow);
check(
  'held conversation blocks AI send',
  !canSend(at('HELD_DISTRESS'), draft('hey')).allow
);
check(
  'operator-initiated send bypasses the hold (replying IS the resolution)',
  canSend(at('HELD_DISTRESS'), draft('hey', true)).allow
);
check(
  'aiActive=false blocks AI send',
  !canSend({ ...base, aiActive: false }, draft('hey')).allow
);
check(
  'unresolved {{var}} artifact blocks',
  !canSend(base, draft('your goal of {{incomeGoal}} bro')).allow
);
check(
  'unresolved {var} artifact blocks',
  !canSend(base, draft('your goal of {incomeGoal} bro')).allow
);
check(
  'normal prose with braces-free text passes',
  canSend(base, draft('what got you into trading?')).allow
);

// ── deriveMachineState precedence ──────────────────────────────────
const row = {
  id: 'c1',
  aiActive: true,
  distressDetected: false,
  schedulingConflict: false,
  awaitingHumanReview: false
};
check('clean row derives ACTIVE', deriveMachineState(row).phase === 'ACTIVE');
check(
  'distress outranks awaitingHumanReview',
  deriveMachineState({
    ...row,
    distressDetected: true,
    awaitingHumanReview: true
  }).phase === 'HELD_DISTRESS'
);
check(
  'awaitingHumanReview + gate signal derives HELD_GATE_EXHAUSTED',
  deriveMachineState({
    ...row,
    awaitingHumanReview: true,
    qualityGateHeld: true
  }).phase === 'HELD_GATE_EXHAUSTED'
);
check(
  'awaitingHumanReview without gate signal derives HELD_OPERATOR_REVIEW',
  deriveMachineState({ ...row, awaitingHumanReview: true }).phase ===
    'HELD_OPERATOR_REVIEW'
);
check(
  'aiActive=false derives AI_OFF even when held',
  deriveMachineState({ ...row, aiActive: false, awaitingHumanReview: true })
    .phase === 'AI_OFF'
);

console.log(`state-machine tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
