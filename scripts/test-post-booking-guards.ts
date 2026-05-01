/* eslint-disable no-console */
// Pure-logic tests for the Wout Lngrs (2026-05-01) post-booking
// guard set:
//   1. shouldSkipFollowUp returns skip when scheduledCallAt is set
//   2. voice gate hardFails on disqualification language when
//      scheduledCallAt is set
//   3. voice gate soft-flags fabricated_capital_figure when the
//      reply mentions a $amount that's not in priorMessageCorpus
import { shouldSkipFollowUp } from '../src/lib/follow-up-sequence';
import { scoreVoiceQuality } from '../src/lib/voice-quality-gate';

let pass = 0;
let fail = 0;
function record(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? '\n      ' + detail : ''}`);
  }
}

// --- shouldSkipFollowUp ---
const verdict1 = shouldSkipFollowUp({ scheduledCallAt: new Date() });
record(
  'shouldSkipFollowUp: scheduledCallAt set → skip with reason call_already_booked',
  verdict1.skip === true && verdict1.reason === 'call_already_booked'
);

const verdict2 = shouldSkipFollowUp({ scheduledCallAt: null });
record(
  'shouldSkipFollowUp: no booking + clean state → no skip',
  verdict2.skip === false
);

const verdict3 = shouldSkipFollowUp({
  scheduledCallAt: null,
  leadStage: 'UNQUALIFIED'
});
record(
  'shouldSkipFollowUp: UNQUALIFIED still skips (existing behavior)',
  verdict3.skip === true && verdict3.reason === 'lead_unqualified'
);

// --- voice gate: disqualification_after_call_confirmed ---
// Wout's exact bad reply
const woutReply =
  "gotchu bro, with $12 i wouldn't force the main call yet. better move is the lower-ticket/free route while you build closer to $2,000, then we can revisit the full program.";
const woutResult = scoreVoiceQuality(woutReply, {
  scheduledCallAt: new Date('2026-05-03T22:00:00.000Z'),
  // Conversation prior to the bad message — does NOT contain "$12"
  // but DOES contain "12am" (which is what the parser misread).
  priorMessageCorpus:
    "lead said 5k yo bro i'm usually out by 9:30am if it's london\n5pm cdt is 12am ur time so it should work out but are you sure 12am is a good time for you?\nYeah 12am is perfect"
});
record(
  "voice gate: Wout's exact bad reply hard-fails with disqualification_after_call_confirmed",
  woutResult.hardFails.some((f) =>
    f.includes('disqualification_after_call_confirmed:')
  )
);
record(
  "voice gate: Wout's reply also fires fabricated_capital_figure soft signal",
  woutResult.softSignals.fabricated_capital_figure === -0.5
);

// --- voice gate: legit post-booking confirmation does NOT hard fail ---
const legitReply =
  'yo bro, just a quick reminder your call with anthony is sunday 5pm cdt 💪🏿';
const legitResult = scoreVoiceQuality(legitReply, {
  scheduledCallAt: new Date('2026-05-03T22:00:00.000Z'),
  priorMessageCorpus: 'sunday 5pm cdt confirmed 5k capital'
});
record(
  'voice gate: legit post-booking reminder does NOT hard fail',
  !legitResult.hardFails.some((f) =>
    f.includes('disqualification_after_call_confirmed:')
  )
);

// --- voice gate: $ amount that DOES appear in corpus → no soft signal ---
const goodReply = 'gotchu bro, $5,000 is a solid spot to start';
const goodResult = scoreVoiceQuality(goodReply, {
  // No scheduledCallAt so the disqualification gate doesn't fire
  // (we want to test fabricated check in isolation).
  priorMessageCorpus: 'I have $5,000 saved up'
});
record(
  'voice gate: $5,000 mentioned (matches "5,000" in corpus) → no fabricated signal',
  goodResult.softSignals.fabricated_capital_figure === undefined
);

// --- voice gate: $ amount NOT in corpus → soft signal fires ---
const ghostAmt = scoreVoiceQuality('gotchu bro, with $750 you can start', {
  priorMessageCorpus: 'lead said 5k thats my budget'
});
record(
  'voice gate: $750 not in corpus → fabricated_capital_figure fires',
  ghostAmt.softSignals.fabricated_capital_figure === -0.5
);

// --- voice gate: $5k variant (corpus has "5k", reply has "$5,000") ---
// We normalize commas; "5,000" === "5000". But "5k" stays as "5k" —
// not a match. This is a false-positive risk — when the corpus only
// has "5k" but the reply uses "$5,000", the gate would flag it.
// Document the limitation rather than over-engineer the matcher.
const kVariant = scoreVoiceQuality('that 5k is solid bro', {
  priorMessageCorpus: '5000 saved up'
});
// "5k" is parsed to extract digits — '5' which is < 2 chars per
// our regex floor — won't match the regex `\d{2,7}`. So no
// fabrication check fires on '5k'. Good — silent pass.
record(
  'voice gate: bare "5k" reply → no false positive (regex floor 2 digits)',
  kVariant.softSignals.fabricated_capital_figure === undefined
);

console.log(
  `\n${pass}/${pass + fail} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
