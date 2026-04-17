/**
 * Test the closing-signal detector against the 6 spec scenarios.
 * Pure-function tests — no DB, no API calls.
 *
 * Usage: npx tsx scripts/test-closing-signal.ts
 */

import { isClosingSignal } from '../src/lib/closing-signal-detector';

interface Case {
  name: string;
  leadMessage: string;
  lastAIMessage: string | null;
  lastAIAgeMs: number | null; // null = no prior AI message at all
  expectIsClosing: boolean;
  notes?: string;
}

const NOW = Date.now();
/** Returns an age-in-ms duration (NOT a timestamp) for the test case. */
const minAgo = (m: number) => m * 60 * 1000;

const CASES: Case[] = [
  {
    name: 'TEST 1 — Emoji-only after AI sign-off',
    leadMessage: '🫡🤝',
    lastAIMessage: 'cool, take care bro. catch you later!',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: true
  },
  {
    name: 'TEST 2 — Short ack after AI sign-off',
    leadMessage: 'bet',
    lastAIMessage: "lmk when you're ready bro",
    lastAIAgeMs: minAgo(1),
    expectIsClosing: true
  },
  {
    name: 'TEST 3 — Short ack WITHOUT prior AI sign-off',
    leadMessage: 'bet',
    lastAIMessage: 'how much you looking to make monthly?',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: false,
    notes: '"bet" here confirms agreement, not closing'
  },
  {
    name: 'TEST 4 — Closing word + question',
    leadMessage: 'alright bro but quick question how much is it?',
    lastAIMessage: 'catch you later bro',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: false,
    notes: 'Question mark overrides closing word'
  },
  {
    name: 'TEST 5 — Re-engagement 24h after close',
    leadMessage: 'yo',
    lastAIMessage: 'take care bro',
    lastAIAgeMs: 24 * 60 * 60 * 1000,
    expectIsClosing: false,
    notes: 'Outside 2h window → re-engagement'
  },
  {
    name: 'TEST 6 — Reaction/like (emoji-only short message)',
    leadMessage: '👍',
    lastAIMessage: 'hit me up when you got time bro',
    lastAIAgeMs: minAgo(2),
    expectIsClosing: true
  },
  // Additional edge cases from the spec discussion
  {
    name: 'BONUS — "cool, so how much is it?" (closing word + real question)',
    leadMessage: 'cool, so how much is it?',
    lastAIMessage: 'catch you later',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: false,
    notes: 'Question mark rule wins'
  },
  {
    name: 'BONUS — "thanks bro" with AI sign-off',
    leadMessage: 'thanks bro',
    lastAIMessage: 'take care man',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: true
  },
  {
    name: 'BONUS — "appreciate it" with AI sign-off',
    leadMessage: 'appreciate it',
    lastAIMessage: 'here if you need anything bro',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: true
  },
  {
    name: 'BONUS — emoji-only but AI did NOT sign off',
    leadMessage: '🔥',
    lastAIMessage: 'how much you looking to make monthly?',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: false,
    notes: 'No signoff detected → not a close'
  },
  {
    name: 'BONUS — Lead provides email as short msg after booking signoff',
    leadMessage: 'foo@bar.com',
    lastAIMessage: 'catch you later bro',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: false,
    notes:
      'Contains letters/digits, not in closing words, 11 chars > has content'
  },
  {
    name: 'BONUS — Empty/whitespace message',
    leadMessage: '   ',
    lastAIMessage: 'hit me up bro',
    lastAIAgeMs: minAgo(1),
    expectIsClosing: true
  }
];

let pass = 0;
let fail = 0;

for (const tc of CASES) {
  const result = isClosingSignal(
    tc.leadMessage,
    tc.lastAIMessage,
    tc.lastAIAgeMs !== null ? new Date(NOW - tc.lastAIAgeMs) : null
  );
  const ok = result.isClosing === tc.expectIsClosing;
  const icon = ok ? '✓' : '✗';
  console.log(`${icon} ${tc.name}`);
  console.log(
    `    lead: "${tc.leadMessage}" | AI prior: "${(tc.lastAIMessage || '(null)').slice(0, 50)}"`
  );
  console.log(
    `    expect=${tc.expectIsClosing} got=${result.isClosing} reason="${result.reason}"`
  );
  if (tc.notes) console.log(`    notes: ${tc.notes}`);
  console.log('');
  if (ok) pass++;
  else fail++;
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
