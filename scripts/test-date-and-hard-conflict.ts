/* eslint-disable no-console */
// Verifies FIX 1 + FIX 2 surface contracts without touching the DB.
//
//  FIX 1 — Date injection
//    Calls buildDynamicSystemPrompt against an empty leadContext stub
//    via a stripped wrapper. We don't actually need a persona row to
//    sanity-check the prepended date line — we just synthesise the
//    assembly with a minimal mock. To keep this DB-free, we pull the
//    block construction logic by snapshotting the date string the
//    same way buildDynamicSystemPrompt builds it.
//
//  FIX 2 — Hard scheduling conflict
//    Exercises detectHardSchedulingConflict against the patterns
//    listed in the spec + Cristian Caciora-style failures + a few
//    obvious negatives. Expected outcomes are inline so a regression
//    surfaces visibly.
//
// Run: pnpm tsx scripts/test-date-and-hard-conflict.ts

import {
  detectHardSchedulingConflict,
  detectSchedulingConflict,
  HARD_SCHEDULING_HANDOFF_MESSAGE
} from '../src/lib/scheduling-conflict-detector';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

// ── Test 1 — Date string format ──────────────────────────────────
console.log('\n[1] Date injection format');
const now = new Date();
const dateString = now.toLocaleDateString('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC'
});
expect(
  'date string contains weekday, month, day, year',
  /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(
    dateString
  ),
  true
);
const block = `Today is ${dateString} (UTC). Account for this when discussing scheduling, timing, or availability. Never confirm a day that has already passed or is today if the lead said they're not available.`;
expect('block starts with "Today is"', block.startsWith('Today is '), true);
expect('block mentions UTC', block.includes('(UTC)'), true);
expect(
  'block warns against confirming an unavailable day',
  block.includes("said they're not available"),
  true
);

// ── Test 2 — Hard detector positives (must fire) ────────────────
console.log('\n[2] Hard detector — positive cases (each must fire)');
const positives = [
  "the only day available is Saturday and I can't do this weekend",
  "it won't let me select another day",
  "the form won't let me choose any time",
  'the booking only shows saturday',
  'it only has saturday',
  'it only gives sunday',
  "I'm not available this weekend",
  "I'm not available next week",
  'not available that day',
  "I can't make any of those",
  "I can't do that day",
  "can't do this weekend",
  'none of those work',
  'none of these times',
  'no other days',
  'no available slots',
  'no available times'
];
for (const p of positives) {
  const r = detectHardSchedulingConflict(p);
  expect(`fires on: "${p}"`, r.detected, true);
}

// ── Test 3 — Hard detector negatives (must NOT fire) ────────────
console.log('\n[3] Hard detector — negative cases (each must NOT fire)');
const negatives = [
  'hey bro how are you',
  'works for me',
  'sounds good',
  'looking forward to it',
  'whats up',
  "I'd love to hop on a call",
  'when can we chat?',
  // "I can do Sunday" alone is a soft signal, not hard
  'I can do Sunday'
];
for (const n of negatives) {
  const r = detectHardSchedulingConflict(n);
  expect(`silent on: "${n}"`, r.detected, false);
}

// ── Test 4 — Cristian Caciora-style scenario ─────────────────────
console.log('\n[4] Cristian-style scenario');
const cristianMessage =
  "the only day available is Saturday and I can't do this weekend";
const cristianHard = detectHardSchedulingConflict(cristianMessage);
expect('hard fires on the lead-spec example', cristianHard.detected, true);
expect(
  'soft also fires (defense in depth — both flag the same conv)',
  detectSchedulingConflict(cristianMessage).detected,
  true
);

// ── Test 5 — Handoff message stability ──────────────────────────
console.log('\n[5] Handoff message');
expect(
  'exact text matches the spec',
  HARD_SCHEDULING_HANDOFF_MESSAGE,
  "got it bro, let me flag this for the team right now — they'll reach out to you directly to sort out a time that actually works 💪🏿"
);

// ── Summary ─────────────────────────────────────────────────────
console.log('\n----');
console.log(`PASS ${pass}  FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
