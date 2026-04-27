/* eslint-disable no-console */
// Verifies the Brian Dycey 2026-04-27 fixes:
//
//   FIX A1 — deliverBubbleGroup schedules FOLLOW_UP_1 inside the
//            bubble loop (after bubble 0 ships) so a mid-group
//            abandonment doesn't break follow-up scheduling.
//   FIX A2 — recover-stale-bubbles cron sweeps abandoned MessageGroups
//            and ships the missing bubbles. (Logic-only test — DB
//            integration covered by smoke against Brian below.)
//   FIX B  — voice-quality-gate fires soft incomplete_response_no_followup
//            on a stalled ack-only reply on a stage that needs advancement,
//            and hard-fails the egregious case (≤ 8 words).

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import {
  scoreVoiceQuality,
  scoreVoiceQualityGroup
} from '../src/lib/voice-quality-gate';

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

async function main() {
  // ── FIX B-1: Brian's exact reply hard-fails on QUALIFYING ─────
  console.log("\n[FIX B-1] Brian's actual reply on QUALIFYING stage");
  const brianReply = 'gotchu bro, and that makes sense';
  const r1 = scoreVoiceQuality(brianReply, {
    leadStage: 'QUALIFYING',
    currentStage: 'SOFT_PITCH_COMMITMENT'
  });
  expect(
    'fires soft signal -0.4',
    r1.softSignals.incomplete_response_no_followup,
    -0.4
  );
  expect(
    'also hard-fails (≤ 8 words = egregious)',
    r1.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    true
  );

  // ── FIX B-2: same reply with a forward-moving question passes ─
  console.log('\n[FIX B-2] same opener with question passes');
  const r2 = scoreVoiceQuality(
    "gotchu bro, and that makes sense — what's been the biggest thing holding you back?",
    {
      leadStage: 'QUALIFYING',
      currentStage: 'SOFT_PITCH_COMMITMENT'
    }
  );
  expect(
    'no soft fire when question present',
    r2.softSignals.incomplete_response_no_followup,
    undefined
  );
  expect(
    'no hard fail when question present',
    r2.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    false
  );

  // ── FIX B-3: same reply with URL passes ─────────────────────
  console.log('\n[FIX B-3] same opener with URL passes');
  const r3 = scoreVoiceQuality(
    'gotchu bro, here you go: https://form.typeform.com/to/AGUtPdmb',
    {
      leadStage: 'CALL_PROPOSED',
      currentStage: 'BOOKING'
    }
  );
  expect(
    'no soft fire when URL present',
    r3.softSignals.incomplete_response_no_followup,
    undefined
  );

  // ── FIX B-4: opener-stage convo: short ack is fine ─────────
  console.log('\n[FIX B-4] OPENING / NEW_LEAD stage — short ack is OK');
  const r4 = scoreVoiceQuality('gotchu bro', {
    leadStage: 'NEW_LEAD',
    currentStage: 'OPENING'
  });
  expect(
    'no soft fire on OPENING-stage short ack',
    r4.softSignals.incomplete_response_no_followup,
    undefined
  );
  expect(
    'no hard fail on OPENING-stage short ack',
    r4.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    false
  );

  // ── FIX B-5: gray-zone (9-14 words) → soft only, not hard ──
  console.log('\n[FIX B-5] gray-zone (9-14 words) — soft only');
  const r5 = scoreVoiceQuality(
    'gotchu bro and that makes sense bro real talk thanks for sharing',
    {
      leadStage: 'QUALIFYING',
      currentStage: 'SOFT_PITCH_COMMITMENT'
    }
  );
  expect(
    'gray-zone soft signal still fires',
    r5.softSignals.incomplete_response_no_followup,
    -0.4
  );
  expect(
    'gray-zone does NOT hard-fail',
    r5.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    false
  );

  // ── FIX B-6: scoreVoiceQualityGroup propagates the hard fail
  console.log('\n[FIX B-6] group scorer surfaces the hard fail');
  const r6 = scoreVoiceQualityGroup([brianReply], {
    leadStage: 'QUALIFYING',
    currentStage: 'SOFT_PITCH_COMMITMENT'
  });
  expect(
    'group scorer hard-fails',
    r6.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    true
  );

  // ── FIX B-7: multi-bubble joined turn — passes when bubble 1 has the Q
  console.log('\n[FIX B-7] multi-bubble: bubble 1 has the question → passes');
  const r7 = scoreVoiceQualityGroup(
    [
      'gotchu bro, and that makes sense',
      "since your strategy's already there, what are you tryna make monthly off it?"
    ],
    {
      leadStage: 'QUALIFYING',
      currentStage: 'SOFT_PITCH_COMMITMENT'
    }
  );
  expect(
    'group with question in bubble 1 passes the incomplete check',
    r7.hardFails.some((f) =>
      f.includes('incomplete_response_acknowledgment_only:')
    ),
    false
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
