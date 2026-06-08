// F5.1 Phase 6B — stepToSopStage maps a script step's systemStage (title /
// stateKey) to the 7-stage SOP enum so the Stage Progression panel + lead.stage
// can reconcile to the REAL position instead of the lagging LLM-emitted stage.
//
// Run: npx tsx --test tests/unit/step-to-sop-stage.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { stepToSopStage } from '../../src/lib/conversation-state-machine';

describe('stepToSopStage (F5.1 6B)', () => {
  it('maps DAE step titles to the right SOP stage', () => {
    assert.equal(stepToSopStage('Intro'), 'OPENING');
    assert.equal(stepToSopStage('Location Check'), 'OPENING');
    assert.equal(stepToSopStage('Experience Depth'), 'SITUATION_DISCOVERY');
    assert.equal(
      stepToSopStage('Current Situation — Job'),
      'SITUATION_DISCOVERY'
    );
    assert.equal(
      stepToSopStage('Desired Outcome - Deep Why'),
      'GOAL_EMOTIONAL_WHY'
    );
    assert.equal(stepToSopStage('Income Goal'), 'GOAL_EMOTIONAL_WHY');
    assert.equal(
      stepToSopStage('Obstacle Identification'),
      'GOAL_EMOTIONAL_WHY'
    );
    assert.equal(stepToSopStage('Urgency (CONDITIONAL)'), 'URGENCY');
    // "Call Proposal" = the soft-pitch/commitment moment; BOOKING is reserved
    // for actually scheduling/confirming the call (Collect Info / Booking Confirmation).
    assert.equal(stepToSopStage('Call Proposal'), 'SOFT_PITCH_COMMITMENT');
    assert.equal(
      stepToSopStage('Buy-In Confirmation'),
      'SOFT_PITCH_COMMITMENT'
    );
    assert.equal(
      stepToSopStage('Capital Clarification'),
      'FINANCIAL_SCREENING'
    );
    assert.equal(stepToSopStage('Capital Routing'), 'FINANCIAL_SCREENING');
    assert.equal(stepToSopStage('Booking Confirmation'), 'BOOKING');
  });

  it('maps a non-DAE (fitness) script income-goal equivalent by keyword', () => {
    assert.equal(stepToSopStage('Revenue Target'), 'GOAL_EMOTIONAL_WHY');
    // "Niche" has no SOP keyword → null (caller falls back to the LLM stage;
    // a null is safe because the panel never regresses).
    assert.equal(stepToSopStage('Niche'), null);
  });

  it('returns null on unmappable / empty input (caller falls back to LLM stage)', () => {
    assert.equal(stepToSopStage(null), null);
    assert.equal(stepToSopStage(undefined), null);
    assert.equal(stepToSopStage(''), null);
    assert.equal(stepToSopStage('zzz nonsense'), null);
  });

  it('checks booking before pitch so a booking step never reads as soft-pitch', () => {
    assert.equal(stepToSopStage('Schedule the call'), 'BOOKING');
    assert.equal(stepToSopStage('confirm call time'), 'BOOKING');
  });
});
