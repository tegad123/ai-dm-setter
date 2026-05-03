/**
 * Regression coverage for the R37 multi-message burst extension
 * (Jefferson @namejeffe 2026-05-03).
 *
 * The original R37 single-question soft signal (-0.5) only inspects the
 * immediately-preceding LEAD message. The new group-level hardFail
 * `r37_burst_ignored:` fires when the lead sent ≥ 2 consecutive
 * messages — at least one a question or reflective/emotional
 * disclosure — and the AI's reply addresses none of it.
 *
 * Run: npx tsx scripts/test-r37-burst.ts
 */

import assert from 'node:assert/strict';
import {
  scoreVoiceQualityGroup,
  getUnacknowledgedLeadBurst,
  acknowledgesEmotionally
} from '@/lib/voice-quality-gate';

type Msg = { sender: string; content: string };

// Jefferson's exact 2026-05-03 burst — two reflective + one question.
const JEFFERSON_BURST: Msg[] = [
  {
    sender: 'AI',
    content: 'how soon are you trying to make this happen for yourself?'
  },
  { sender: 'LEAD', content: 'sick of the self flagellation haha' },
  { sender: 'LEAD', content: 'Rebuilding confidence man' },
  {
    sender: 'LEAD',
    content:
      "Hows your relationship with these 'behavioural lapses' in this stage of your trading?"
  }
];

// AI reply that ignores the entire burst — the production failure.
const IGNORING_REPLY = 'how soon are you trying to make this happen?';

// AI reply with emotional acknowledgment language ("respect", "takes
// self awareness") — should pass via acknowledgesEmotionally safety
// valve even without an exact topic match.
const EMOTIONAL_ACK_REPLY =
  'respect bro that takes self awareness, anthony breaks down the relationship with behavioural lapses on the call. how soon you trying to make this real?';

// AI reply that mentions a specific topic word ("rebuilding") from the
// burst — should pass via the topic-match path. Note: the gate uses
// `extractSpecificDetails` which extracts named entities (prop firms,
// instruments, strategies). Since "rebuilding" isn't a named entity,
// this path actually relies on `acknowledgesEmotionally` matching the
// "rebuild" pattern — verified separately below.
const TOPIC_REBUILD_REPLY =
  "fair enough bro on rebuilding the confidence — what's your capital situation looking like for the markets?";

// Single-message burst with a question — should NOT trigger the new
// hardFail (≥ 2 messages required); the existing single-message
// `ignored_personal_question` soft signal handles this case.
const SINGLE_QUESTION_HISTORY: Msg[] = [
  { sender: 'AI', content: 'cool, how long you been trading?' },
  { sender: 'LEAD', content: 'whats your favorite prop firm bro?' }
];

// Empty burst (latest sender is AI) — gate must no-op the burst check.
const NO_BURST_HISTORY: Msg[] = [
  { sender: 'LEAD', content: 'sup' },
  { sender: 'AI', content: 'yo bro, what brought you to the page?' }
];

// SYSTEM messages between LEAD turns must not break the burst run —
// internal notes don't acknowledge.
const SYSTEM_BETWEEN_BURST: Msg[] = [
  { sender: 'AI', content: 'cool, what got you into this?' },
  { sender: 'LEAD', content: 'sick of self flagellation haha' },
  { sender: 'SYSTEM', content: '[internal] operator viewed conversation' },
  { sender: 'LEAD', content: 'Rebuilding confidence man' }
];

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

function assertOk(condition: unknown, label: string, detail?: string) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function fired(hardFails: string[]): boolean {
  return hardFails.some((f) => f.includes('r37_burst_ignored:'));
}

async function main() {
  // ── Helper-level: getUnacknowledgedLeadBurst ────────────────────
  console.log('\n[1] getUnacknowledgedLeadBurst — burst extraction');
  const jeffersonBurst = getUnacknowledgedLeadBurst(JEFFERSON_BURST);
  expect(
    'extracts all 3 LEAD messages since last AI',
    jeffersonBurst.messages.length,
    3
  );
  expect('detects question across burst', jeffersonBurst.hasQuestion, true);
  expect(
    'detects reflective content across burst',
    jeffersonBurst.hasReflectiveContent,
    true
  );

  const noBurst = getUnacknowledgedLeadBurst(NO_BURST_HISTORY);
  expect('returns empty when latest sender is AI', noBurst.messages.length, 0);

  const systemSandwich = getUnacknowledgedLeadBurst(SYSTEM_BETWEEN_BURST);
  expect(
    'SYSTEM message between LEAD turns does not break the burst',
    systemSandwich.messages.length,
    2
  );

  expect(
    'undefined history returns empty',
    getUnacknowledgedLeadBurst(undefined).messages.length,
    0
  );
  expect(
    'empty history returns empty',
    getUnacknowledgedLeadBurst([]).messages.length,
    0
  );

  // ── Helper-level: acknowledgesEmotionally ───────────────────────
  console.log('\n[2] acknowledgesEmotionally — safety valve detection');
  expect(
    '"respect bro" matches',
    acknowledgesEmotionally('respect bro that takes self awareness'),
    true
  );
  expect(
    '"damn that takes guts" matches',
    acknowledgesEmotionally('damn bro that takes guts'),
    true
  );
  expect(
    '"rebuild" matches (covers Jefferson topic)',
    acknowledgesEmotionally('fair enough on rebuilding the confidence'),
    true
  );
  expect(
    'pure script-advance does NOT match',
    acknowledgesEmotionally('how soon are you trying to make this happen?'),
    false
  );
  expect('empty string is false', acknowledgesEmotionally(''), false);

  // ── Group gate: Jefferson burst + ignoring reply → hardFail ─────
  console.log(
    '\n[3] Jefferson burst — ignoring reply triggers r37_burst_ignored'
  );
  const ignoring = scoreVoiceQualityGroup([IGNORING_REPLY], {
    conversationHistory: JEFFERSON_BURST
  });
  assertOk(
    fired(ignoring.hardFails),
    'ignoring reply hard-fails',
    `hardFails=${JSON.stringify(ignoring.hardFails)}`
  );

  // ── Group gate: Jefferson burst + emotional ack → PASS ──────────
  console.log('\n[4] Jefferson burst — emotional-ack reply passes burst check');
  const ack = scoreVoiceQualityGroup([EMOTIONAL_ACK_REPLY], {
    conversationHistory: JEFFERSON_BURST
  });
  assertOk(
    !fired(ack.hardFails),
    'emotional-ack reply does NOT fire r37_burst_ignored',
    `hardFails=${JSON.stringify(ack.hardFails)}`
  );

  // ── Group gate: Jefferson burst + topic-word reply → PASS ───────
  console.log('\n[5] Jefferson burst — "rebuilding" topic-word reply passes');
  const topic = scoreVoiceQualityGroup([TOPIC_REBUILD_REPLY], {
    conversationHistory: JEFFERSON_BURST
  });
  assertOk(
    !fired(topic.hardFails),
    'topic-word reply does NOT fire r37_burst_ignored',
    `hardFails=${JSON.stringify(topic.hardFails)}`
  );

  // ── Group gate: single-message lead turn does NOT fire ──────────
  console.log(
    '\n[6] Single-message lead turn — no r37_burst_ignored (handled by soft signal)'
  );
  const single = scoreVoiceQualityGroup(['cool, what other firms you tried?'], {
    conversationHistory: SINGLE_QUESTION_HISTORY,
    previousLeadMessage: 'whats your favorite prop firm bro?'
  });
  assertOk(
    !fired(single.hardFails),
    'single-message turn does NOT fire new burst hardFail',
    `hardFails=${JSON.stringify(single.hardFails)}`
  );

  // ── Group gate: empty burst (latest sender AI) → no-op ──────────
  console.log('\n[7] No burst — gate skips R37 burst check entirely');
  const noBurstGate = scoreVoiceQualityGroup(
    ['yo bro, what brought you to the page?'],
    { conversationHistory: NO_BURST_HISTORY }
  );
  assertOk(
    !fired(noBurstGate.hardFails),
    'no-burst case does not fire r37_burst_ignored',
    `hardFails=${JSON.stringify(noBurstGate.hardFails)}`
  );

  // ── Group gate: undefined conversationHistory → no-op ───────────
  console.log(
    '\n[8] Missing conversationHistory option — gate is backward compatible'
  );
  const noHistory = scoreVoiceQualityGroup([
    'how soon are you trying to make this happen?'
  ]);
  assertOk(
    !fired(noHistory.hardFails),
    'absent conversationHistory does not fire (backward compat)',
    `hardFails=${JSON.stringify(noHistory.hardFails)}`
  );

  // ── Multi-bubble: emotional ack in bubble 0, advance in bubble 1 ─
  console.log(
    '\n[9] Multi-bubble reply — joined string carries emotional ack, gate passes'
  );
  const multiBubble = scoreVoiceQualityGroup(
    [
      "respect bro that's real self awareness",
      'how soon you trying to make this real?'
    ],
    { conversationHistory: JEFFERSON_BURST }
  );
  assertOk(
    !fired(multiBubble.hardFails),
    'multi-bubble emotional ack passes (joined-string check)',
    `hardFails=${JSON.stringify(multiBubble.hardFails)}`
  );

  console.log(`\n----\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('R37 burst test failed:', err);
  process.exit(2);
});
