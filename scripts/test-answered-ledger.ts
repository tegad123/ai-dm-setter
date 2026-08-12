// Fix D Phase 2 — answered-question ledger gate behavior.
// The reasks_captured_variable guard must fire when a variable was ANSWERED
// this conversation even if it was not persisted to capturedDataPoints.
// Run: NODE_PATH=$PWD/node_modules npx tsx scripts/test-answered-ledger.ts

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

const anchors = [
  {
    variableName: 'incomeGoal',
    stepNumber: 4,
    askContents: ["what's your income goal with trading"]
  }
];

// The AI draft re-asks the income-goal question.
const reAskDraft = "so what's your income goal with trading bro?";

function hasReask(fails: string[]): boolean {
  return fails.some((f) => f.startsWith('reasks_captured_variable:'));
}

// 1. Variable NOT captured and NOT answered → no reask fail (legit first ask).
{
  const r = scoreVoiceQuality(reAskDraft, {
    scriptAskAnchors: anchors,
    currentScriptStepNumber: 4,
    capturedDataPoints: {},
    answeredAnchorVariables: []
  });
  check('unanswered variable: re-ask allowed', !hasReask(r.hardFails));
}

// 2. Variable captured in cdp → reask fail (existing behavior preserved).
{
  const r = scoreVoiceQuality(reAskDraft, {
    scriptAskAnchors: anchors,
    currentScriptStepNumber: 4,
    capturedDataPoints: {
      incomeGoal: { value: '15000', confidence: 'HIGH' }
    },
    answeredAnchorVariables: []
  });
  check('captured variable: re-ask blocked', hasReask(r.hardFails));
}

// 3. THE FIX: variable answered but NOT persisted → reask fail.
{
  const r = scoreVoiceQuality(reAskDraft, {
    scriptAskAnchors: anchors,
    currentScriptStepNumber: 4,
    capturedDataPoints: {},
    answeredAnchorVariables: ['incomeGoal']
  });
  check(
    'answered-but-unpersisted variable: re-ask blocked',
    hasReask(r.hardFails)
  );
}

// 4. answeredAnchorVariables names a DIFFERENT variable → no false block.
{
  const r = scoreVoiceQuality(reAskDraft, {
    scriptAskAnchors: anchors,
    currentScriptStepNumber: 4,
    capturedDataPoints: {},
    answeredAnchorVariables: ['capital']
  });
  check(
    'different answered variable: re-ask still allowed',
    !hasReask(r.hardFails)
  );
}

console.log(`answered-ledger tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
