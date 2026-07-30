/**
 * Regression guard for the branch-lock / serializer dual-opener bug
 * (Tega, 2026-07-30). Two invariants the fix must hold FOREVER:
 *   1. selectBranchesForPrompt returns AT MOST ONE branch, ever.
 *   2. It NEVER falls back to "all branches" when nothing is locked.
 *
 * The bug: on a ManyChat/ambiguous inbound, no branch locked, and the
 * serializer returned every Step-1 branch → the model emitted both the Warm
 * and CTA openers (and the CTA condition was BYPASSED, not just duplicated).
 *
 * Run: npx tsx scripts/test-branch-serializer.ts
 */
import assert from 'node:assert/strict';
import { selectBranchesForPrompt } from '@/lib/script-serializer';

const step1 = {
  stepNumber: 1,
  branches: [
    { branchLabel: 'CTA Inbound (clicked ManyChat automation)', actions: [] },
    { branchLabel: "CTA Inbound — didn't click button", actions: [] },
    { branchLabel: 'Outbound (story views / post likes)', actions: [] },
    { branchLabel: "Warm Inbound (DM'd directly)", actions: [] }
  ]
};

const step4 = {
  stepNumber: 4,
  branches: [
    { branchLabel: 'Default', actions: [] },
    { branchLabel: 'Price Question', actions: [] },
    { branchLabel: 'Surface answer', actions: [] }
  ]
};

function run() {
  // 1. Plain inbound DM → resolves to exactly the Warm branch (one opener).
  const warm = selectBranchesForPrompt(step1, {
    conversationSource: 'INBOUND',
    leadSource: 'INBOUND'
  });
  assert.equal(warm.length, 1, 'INBOUND → exactly one step-1 branch');
  assert.match(
    warm[0].branchLabel,
    /warm/i,
    'INBOUND → the warm branch specifically'
  );

  // 2. THE BUG CASE: unrecognized source (mode=null) — must NOT return all
  //    four. Must collapse to exactly one (the warm default), never zero.
  const ambiguous = selectBranchesForPrompt(step1, {
    conversationSource: 'SOMETHING_WEIRD',
    leadSource: null
  });
  assert.equal(
    ambiguous.length,
    1,
    'ambiguous step-1 → exactly one branch, NOT all four (the dual-opener bug)'
  );
  assert.match(
    ambiguous[0].branchLabel,
    /warm/i,
    'ambiguous step-1 → collapses to the warm default'
  );

  // 3. No context at all → still exactly one, never all.
  const empty = selectBranchesForPrompt(step1, {});
  assert.equal(empty.length, 1, 'no-context step-1 → exactly one branch');

  // 4. A locked branch is honored (single source of truth respected).
  const locked = selectBranchesForPrompt(step1, {
    selectedBranchLabel: "Warm Inbound (DM'd directly)",
    selectedBranchStepNumber: 1
  });
  assert.equal(locked.length, 1, 'locked → one branch');
  assert.equal(locked[0].branchLabel, "Warm Inbound (DM'd directly)");

  // 5. Steps 2–8 with NO lock → emit NONE (smart-mode drives), never all.
  const unlocked = selectBranchesForPrompt(step4, {});
  assert.equal(
    unlocked.length,
    0,
    'unlocked step 4 → zero branches (smart mode), NOT all three'
  );

  // 6. Steps 2–8 WITH a valid lock → that one branch only.
  const lockedStep4 = selectBranchesForPrompt(step4, {
    selectedBranchLabel: 'Price Question',
    selectedBranchStepNumber: 4
  });
  assert.equal(lockedStep4.length, 1, 'locked step 4 → one branch');
  assert.equal(lockedStep4[0].branchLabel, 'Price Question');

  // 7. Universal invariant across every context shape: result is always ≤ 1.
  const contexts = [
    {},
    { conversationSource: 'MANYCHAT' },
    { conversationSource: 'INBOUND' },
    { conversationSource: 'OUTBOUND' },
    {
      conversationSource: 'MANYCHAT',
      manyChatFiredAt: new Date().toISOString()
    },
    { selectedBranchLabel: 'nonexistent', selectedBranchStepNumber: 1 }
  ];
  for (const ctx of contexts) {
    assert.ok(
      selectBranchesForPrompt(step1, ctx).length <= 1,
      `step1 result must be <=1 for ${JSON.stringify(ctx)}`
    );
    assert.ok(
      selectBranchesForPrompt(step4, ctx).length <= 1,
      `step4 result must be <=1 for ${JSON.stringify(ctx)}`
    );
  }

  console.log(
    'branch-serializer invariant tests passed (<=1 branch, never all)'
  );
}

run();
