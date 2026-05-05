// Run: npx tsx --test tests/unit/detect-booking-advancement.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectBookingAdvancementDetails } from '../../src/lib/ai-engine';

function parsed(
  stage: string,
  message = 'how soon are you trying to make this happen?'
) {
  return {
    format: 'single',
    message,
    messages: [message],
    stage,
    subStage: null,
    stageConfidence: 1,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: null,
    affirmationDetected: false,
    followUpNumber: null,
    softExit: false,
    escalateToHuman: false,
    leadTimezone: null,
    selectedSlotIso: null,
    leadEmail: null,
    suggestedTag: null,
    reasoning: ''
  } as never;
}

describe('detectBookingAdvancementDetails — post-capital non-numeric pivot', () => {
  it('flags URGENCY when the prior AI turn was a capital ask and capital is unverified', () => {
    const result = detectBookingAdvancementDetails(parsed('URGENCY'), {
      prevAiTurnWasCapitalAsk: true,
      capitalVerified: false
    });

    assert.equal(result.advancement, true);
    assert.equal(result.reason, 'post_capital_non_numeric_pivot');
  });

  it('flags GOAL_EMOTIONAL_WHY when the prior AI turn was a capital ask and capital is unverified', () => {
    const result = detectBookingAdvancementDetails(
      parsed('GOAL_EMOTIONAL_WHY'),
      {
        prevAiTurnWasCapitalAsk: true,
        capitalVerified: false
      }
    );

    assert.equal(result.advancement, true);
    assert.equal(result.reason, 'post_capital_non_numeric_pivot');
  });

  it('flags SOFT_PITCH_COMMITMENT with the new reason in the post-capital pivot context', () => {
    const result = detectBookingAdvancementDetails(
      parsed('SOFT_PITCH_COMMITMENT', 'you ready to work together on this?'),
      {
        prevAiTurnWasCapitalAsk: true,
        capitalVerified: false
      }
    );

    assert.equal(result.advancement, true);
    assert.equal(result.reason, 'post_capital_non_numeric_pivot');
  });

  it('does not flag URGENCY when capital is verified', () => {
    const result = detectBookingAdvancementDetails(parsed('URGENCY'), {
      prevAiTurnWasCapitalAsk: true,
      capitalVerified: true
    });

    assert.equal(result.advancement, false);
    assert.equal(result.reason, null);
  });

  it('does not flag legitimate URGENCY when the prior AI turn was not a capital ask', () => {
    const result = detectBookingAdvancementDetails(parsed('URGENCY'), {
      prevAiTurnWasCapitalAsk: false,
      capitalVerified: false
    });

    assert.equal(result.advancement, false);
    assert.equal(result.reason, null);
  });
});
