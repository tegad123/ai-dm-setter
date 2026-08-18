// P1-A (Tega 2026-08-18): missing-ask hard-fail must fire on react/ask-then-wait
// steps where the selected branch (e.g. "Default") carries only the empathy
// [MSG] and no [ASK] — the silent-stall mechanism. Must NOT fire on silent
// branches, judge-only branches, booking steps, or when a question is present.
// Run: NODE_PATH=$PWD/node_modules npx tsx scripts/test-missing-ask-p1a.ts

import { scoreVoiceQuality } from '../src/lib/voice-quality-gate';

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}
const fires = (fails: string[]) =>
  fails.some((f) => f.startsWith('missing_required_question_on_ask_step:'));

const EMPATHY_NO_Q = 'I respect that bro, I truly do. I hear so many ppl talk.';
const EMPATHY_WITH_Q =
  'I respect that bro, I truly do. What is the main thing driving that for you?';

// 1. THE BUG: step requires an ask (step-level), selected branch has no ask,
//    reply has no question, branch not silent → MUST fire.
check(
  'react-step, Default branch no ask, empathy only → fires',
  fires(
    scoreVoiceQuality(EMPATHY_NO_Q, {
      currentStepHasAnyAskAction: true,
      activeBranchHasAskAction: false,
      currentStepActiveBranchIsSilent: false,
      currentScriptStepNumber: 5
    }).hardFails
  )
);

// 2. Same step but the reply DOES contain the question → must NOT fire.
check(
  'react-step with a question present → does not fire',
  !fires(
    scoreVoiceQuality(EMPATHY_WITH_Q, {
      currentStepHasAnyAskAction: true,
      activeBranchHasAskAction: false,
      currentStepActiveBranchIsSilent: false,
      currentScriptStepNumber: 5
    }).hardFails
  )
);

// 3. Silent acknowledgment branch (intentionally question-free) → must NOT fire.
check(
  'silent branch, no question → does not fire (handled by silent guard)',
  !fires(
    scoreVoiceQuality(EMPATHY_NO_Q, {
      currentStepHasAnyAskAction: true,
      currentStepActiveBranchIsSilent: true,
      currentScriptStepNumber: 5
    }).hardFails
  )
);

// 4. Judge-only branch → must NOT fire.
check(
  'judge-only branch → does not fire',
  !fires(
    scoreVoiceQuality(EMPATHY_NO_Q, {
      currentStepHasAnyAskAction: true,
      currentStepActiveBranchIsJudgeOnly: true,
      currentScriptStepNumber: 5
    }).hardFails
  )
);

// 5. Booking/link step (>=17) → must NOT fire (those legitimately ship a link,
//    not a question).
check(
  'booking/link step (>=17) → does not fire',
  !fires(
    scoreVoiceQuality(EMPATHY_NO_Q, {
      currentStepHasAnyAskAction: true,
      currentStepActiveBranchIsSilent: false,
      currentScriptStepNumber: 17
    }).hardFails
  )
);

// 6. Step genuinely has NO ask at all (pure MSG+WAIT step) → must NOT fire.
check(
  'step with no ask action at all → does not fire',
  !fires(
    scoreVoiceQuality(EMPATHY_NO_Q, {
      currentStepHasAnyAskAction: false,
      activeBranchHasAskAction: false,
      currentStepActiveBranchIsSilent: false,
      currentScriptStepNumber: 5
    }).hardFails
  )
);

console.log(`P1-A missing-ask tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
