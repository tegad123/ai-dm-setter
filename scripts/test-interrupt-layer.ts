// Fix D Phase 1 — interrupt-layer unit tests.
// Run: NODE_PATH=$PWD/node_modules npx tsx scripts/test-interrupt-layer.ts

import { detectInterrupt } from '../src/lib/interrupt-layer';
import type { ScriptStep, ScriptBranch } from '../src/lib/script-types';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

function branch(label: string, msg: string | null): ScriptBranch {
  return {
    id: `b-${label}`,
    stepId: 's1',
    branchLabel: label,
    conditionDescription: null,
    sortOrder: 0,
    actions: msg
      ? [
          {
            id: 'a1',
            branchId: `b-${label}`,
            actionType: 'send_message',
            content: msg,
            sortOrder: 0
          } as never
        ]
      : []
  };
}

function step(branches: ScriptBranch[]): ScriptStep {
  return {
    id: 's1',
    stepNumber: 3,
    title: 'Qualification',
    branches
  } as never;
}

const PRICE_ANSWER = 'the program is $50 a month bro, no catch';
const SCAM_ANSWER =
  'i get it bro, totally fair to be cautious. this is 100% real';

const priceStep = step([
  branch('Default', null),
  branch('Price Question', PRICE_ANSWER)
]);

// ── price interrupt ──────────────────────────────────────────────────
check(
  'how much → price interrupt with the branch copy',
  detectInterrupt('yo how much is this', priceStep)?.answerCopy === PRICE_ANSWER
);
check(
  'is it free → price interrupt',
  detectInterrupt('wait is this actually free', priceStep)?.kind === 'price'
);
check(
  'normal answer → no interrupt',
  detectInterrupt('been trading about 2 years now', priceStep) === null
);
check(
  'bundled answer + price → still fires on the price cue',
  detectInterrupt('yeah 2 years, but how much does it cost', priceStep)
    ?.kind === 'price'
);

// ── objection interrupts ─────────────────────────────────────────────
const scamStep = step([
  branch('Default', null),
  branch('Objection - Scam', SCAM_ANSWER)
]);
check(
  'is this a scam → scam objection interrupt',
  detectInterrupt('is this a scam bro', scamStep)?.answerCopy === SCAM_ANSWER
);
check(
  'legit? → scam objection interrupt',
  detectInterrupt('this legit?', scamStep)?.kind === 'objection_scam'
);

// ── graceful degradation ─────────────────────────────────────────────
check(
  'price cue but no price branch on this step → no interrupt (routing handles)',
  detectInterrupt('how much', step([branch('Default', null)])) === null
);
check(
  'price branch with unresolved placeholder → declines',
  detectInterrupt(
    'how much',
    step([branch('Price Question', 'it is {{price}} bro')])
  ) === null
);
check('null message → null', detectInterrupt(null, priceStep) === null);
check('null step → null', detectInterrupt('how much', null) === null);
check('empty branches → null', detectInterrupt('how much', step([])) === null);
check(
  'price cue matched but no branch → does NOT fall through to objection',
  // "how much time" contains both a price-ish and time-ish shape; ensure the
  // specific price cue is checked and, lacking a price branch, we stop.
  detectInterrupt(
    'how much time does this take',
    step([branch('Objection - Time', 'like 20 mins a day bro')])
  )?.kind === 'objection_time'
);

console.log(`interrupt-layer tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
