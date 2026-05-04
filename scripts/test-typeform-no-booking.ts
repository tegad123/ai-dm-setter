/* eslint-disable no-console */
// Regression coverage for Typeform filled but no booking slot:
//   1. "Not yet, only the basic" triggers the screened-out soft exit
//   2. "Filled it out" with no time triggers the same path
//   3. Specific day/time does not trigger the soft exit
//   4. No available slots remains a scheduling conflict, not screen-out
//   5. The generated safety-net result carries the typeform-screened-out tag
//   6. The safety-net result cannot schedule follow-ups
//   7. Atigib Bliz exact case blocks the wrong "what do you need" reply

import {
  detectTypeformFilledNoBookingContext,
  looksLikeSchedulingConflictInsteadOfScreenOut,
  scoreVoiceQualityGroup,
  TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE
} from '../src/lib/voice-quality-gate';
import { generateReply } from '../src/lib/ai-engine';
import type { ConversationMessage } from '../src/lib/ai-engine';
import type { LeadContext } from '../src/lib/ai-prompts';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(
      `  FAIL ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

function hasHardFail(failures: string[], reason: string): boolean {
  return failures.some((f) => f.includes(`${reason}:`));
}

const bookingQuestion = 'what day and time did you book for?';

const leadContext: LeadContext = {
  leadName: 'Atigib Bliz',
  handle: 'atigib',
  platform: 'INSTAGRAM',
  status: 'CALL_PROPOSED',
  triggerType: 'DM',
  triggerSource: null,
  qualityScore: 80
};

function history(leadReply: string): ConversationMessage[] {
  return [
    {
      id: 'ai-1',
      sender: 'AI',
      content: bookingQuestion,
      timestamp: new Date('2026-04-29T16:00:00.000Z')
    },
    {
      id: 'lead-1',
      sender: 'LEAD',
      content: leadReply,
      timestamp: new Date('2026-04-29T16:01:00.000Z')
    }
  ];
}

async function main() {
  console.log('\n[TEST 1] "Not yet, only the basic" triggers soft exit');
  expect(
    'screen-out context detected',
    detectTypeformFilledNoBookingContext(
      bookingQuestion,
      'Not yet. I only did the basic'
    ),
    true
  );
  // Both account and persona IDs are unused — this scenario hits the
  // typeform-screened-out early exit at the top of generateReply,
  // BEFORE the F3.1 personaId FK guard runs.
  const notYet = await generateReply(
    'unused-account',
    'unused-persona',
    history('Not yet. I only did the basic'),
    leadContext
  );
  expect('soft exit flag set', notYet.softExit, true);
  expect('UNQUALIFIED stage set', notYet.stage, 'UNQUALIFIED');
  expect(
    'fixed exit message sent',
    notYet.reply,
    TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE
  );
  expect('typeform flag set', notYet.typeformFilledNoBooking, true);

  console.log('\n[TEST 2] "Filled it out" with no time triggers soft exit');
  expect(
    'filled form with no time detected',
    detectTypeformFilledNoBookingContext(
      bookingQuestion,
      'I filled out the form'
    ),
    true
  );

  console.log('\n[TEST 3] Specific time given is not screened out');
  expect(
    'tomorrow at 2pm is treated as booked time',
    detectTypeformFilledNoBookingContext(
      bookingQuestion,
      'tomorrow at 2pm EST'
    ),
    false
  );

  console.log('\n[TEST 4] No available slots escalates, not soft exits');
  expect(
    'no available times is scheduling-conflict-shaped',
    looksLikeSchedulingConflictInsteadOfScreenOut(
      "I couldn't find any available times"
    ),
    true
  );
  expect(
    'no available times does not trigger screen-out',
    detectTypeformFilledNoBookingContext(
      bookingQuestion,
      "I filled it out but couldn't find any available times"
    ),
    false
  );

  console.log('\n[TEST 5] Tag applied by safety-net result');
  expect('suggested tag is typeform-screened-out', notYet.suggestedTags, [
    'typeform-screened-out'
  ]);

  console.log('\n[TEST 6] No follow-ups after screened out');
  expect('suggested delay is zero', notYet.suggestedDelay, 0);
  expect('screen-out is terminal', notYet.typeformFilledNoBooking, true);

  console.log('\n[TEST 7] Atigib exact case blocks wrong continuation');
  const wrong = scoreVoiceQualityGroup(
    [
      "gotchu bro, that basic step is fine for now, what's the main thing you need before you finish it?"
    ],
    {
      previousAIMessage: bookingQuestion,
      previousLeadMessage: 'Not yet. I only did the basic'
    }
  );
  expect(
    'wrong continuation hard-fails',
    hasHardFail(wrong.hardFails, 'typeform_filled_no_booking_wrong_path'),
    true
  );
  const correct = scoreVoiceQualityGroup(
    [TYPEFORM_NO_BOOKING_SOFT_EXIT_MESSAGE],
    {
      previousAIMessage: bookingQuestion,
      previousLeadMessage: 'Not yet. I only did the basic'
    }
  );
  expect(
    'fixed exit avoids hard fail',
    hasHardFail(correct.hardFails, 'typeform_filled_no_booking_wrong_path'),
    false
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
