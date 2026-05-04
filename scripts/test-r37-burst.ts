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
  acknowledgesEmotionally,
  isExplicitAcceptance,
  aiPromisedArtifact,
  replyDeliversArtifact
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

  // ── R37 acceptance-loopback extension ──────────────────────────
  function firedAcceptance(hardFails: string[]): boolean {
    return hardFails.some((f) => f.includes('r37_acceptance_loopback:'));
  }

  console.log('\n[10] isExplicitAcceptance — phrase recognition');
  const acceptancePositives = [
    'yes',
    'yes of course',
    'definitely',
    'sure',
    'sure bro',
    'ok',
    'okay',
    'kk',
    'sounds good',
    'sounds fire',
    "let's do it",
    "let's go",
    'lfg',
    'bet',
    'bet bro',
    'aight bet',
    '100',
    '100%',
    "i'm in",
    "i'm down",
    'send it',
    'drop it'
  ];
  for (const a of acceptancePositives) {
    expect(`accepts: "${a}"`, isExplicitAcceptance(a), true);
  }
  const acceptanceNegatives = [
    'yes but I have a question about the strategy first',
    'yeah I make about 5k a month from my day job',
    'sure I trade alpha and topstep mostly',
    'i feel sick of the self flagellation honestly',
    "what's your timeline?",
    'ok well actually let me think about it more first'
  ];
  for (const n of acceptanceNegatives) {
    expect(
      `does NOT accept (substantive): "${n.slice(0, 35)}..."`,
      isExplicitAcceptance(n),
      false
    );
  }

  console.log('\n[11] aiPromisedArtifact — promise recognition');
  const promiseSamples = [
    "I'll send you the link bro",
    "let's hop on a quick call",
    'wanna hop on a call this week?',
    "let's get you booked",
    'you down for a quick chat?',
    'want me to send the bootcamp?',
    "here's the application link",
    'I can lock you in for thursday',
    'check this out bro'
  ];
  for (const p of promiseSamples) {
    expect(`promises: "${p.slice(0, 40)}"`, aiPromisedArtifact(p), true);
  }
  expect(
    'no promise on plain qualification Q',
    aiPromisedArtifact('how long you been trading?'),
    false
  );
  expect('null is false', aiPromisedArtifact(null), false);

  console.log('\n[12] replyDeliversArtifact — delivery recognition');
  expect(
    'URL delivery',
    replyDeliversArtifact(
      "here's the link bro: https://form.typeform.com/to/AGUtPdmb"
    ),
    true
  );
  expect(
    'booking-flow delivery',
    replyDeliversArtifact("bet bro, fill it out and lmk once you're done"),
    true
  );
  expect(
    'pure question is NOT delivery',
    replyDeliversArtifact('how soon are you trying to make this happen?'),
    false
  );

  console.log(
    '\n[13] Acceptance + prior promise + question reply → r37_acceptance_loopback'
  );
  const loopback = scoreVoiceQualityGroup(
    ["sick bro, what's your timeline looking like?"],
    {
      previousAIMessage:
        'wanna hop on a quick call with anthony? he can break down exactly how the program works',
      previousLeadMessage: 'yes definitely'
    }
  );
  assertOk(
    firedAcceptance(loopback.hardFails),
    'looping back after "yes definitely" hard-fails',
    `hardFails=${JSON.stringify(loopback.hardFails)}`
  );

  console.log('\n[14] Acceptance + prior promise + delivery reply → PASS');
  const delivers = scoreVoiceQualityGroup(
    [
      "bet bro — here's the link: https://form.typeform.com/to/abc fill it out and lmk"
    ],
    {
      previousAIMessage:
        "wanna hop on a quick call with anthony? I'll send you the booking link",
      previousLeadMessage: 'yes definitely'
    }
  );
  assertOk(
    !firedAcceptance(delivers.hardFails),
    'delivery reply does NOT fire r37_acceptance_loopback',
    `hardFails=${JSON.stringify(delivers.hardFails)}`
  );

  console.log(
    '\n[15] Acceptance with NO prior offer (bare yes/no answer) → no fire'
  );
  const bareYes = scoreVoiceQualityGroup(
    ['cool, what other firms you tried?'],
    {
      previousAIMessage: 'have you traded prop firms before?',
      previousLeadMessage: 'yes'
    }
  );
  assertOk(
    !firedAcceptance(bareYes.hardFails),
    'bare yes to qualification Q does NOT fire (no offer was made)',
    `hardFails=${JSON.stringify(bareYes.hardFails)}`
  );

  console.log(
    '\n[16] Substantive lead reply with "yes" inside → no false-fire'
  );
  const substantive = scoreVoiceQualityGroup(['what other firms you tried?'], {
    previousAIMessage: 'wanna hop on a call?',
    previousLeadMessage:
      "yes but I make about 5k a month from my day job and I'm trying to replace it"
  });
  assertOk(
    !firedAcceptance(substantive.hardFails),
    'substantive reply containing "yes" does NOT fire (length cap on isExplicitAcceptance)',
    `hardFails=${JSON.stringify(substantive.hardFails)}`
  );

  console.log('\n[17] All-bubble joined delivery passes the gate');
  const multiBubbleDeliver = scoreVoiceQualityGroup(
    [
      'bet bro lets get it',
      "here's the link: https://form.typeform.com/to/abc fill it out"
    ],
    {
      previousAIMessage: "let's get you booked — wanna hop on?",
      previousLeadMessage: "let's do it"
    }
  );
  assertOk(
    !firedAcceptance(multiBubbleDeliver.hardFails),
    'multi-bubble delivery (URL in bubble 1) passes the joined check',
    `hardFails=${JSON.stringify(multiBubbleDeliver.hardFails)}`
  );

  console.log(`\n----\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('R37 burst test failed:', err);
  process.exit(2);
});
