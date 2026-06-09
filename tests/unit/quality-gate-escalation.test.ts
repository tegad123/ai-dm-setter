// BUG A — silent quality gate failure
// Run: npx tsx --test tests/unit/quality-gate-escalation.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ScheduledReplyStatus } from '@prisma/client';
import {
  buildQualityGateGeneratedResult,
  FAILED_QUALITY_GATE_STATUS,
  isQualityGateEscalationError,
  isTerminalQualityGateResult,
  QualityGateEscalationError,
  QUALITY_GATE_FAILURE_LAST_ERROR,
  QUALITY_GATE_FAILURE_REASON
} from '../../src/lib/quality-gate-escalation';
import { scoreVoiceQualityGroup } from '../../src/lib/voice-quality-gate';

describe('quality gate escalation helpers', () => {
  it('defines the durable ScheduledReply failure status', () => {
    assert.equal(
      ScheduledReplyStatus.FAILED_QUALITY_GATE,
      FAILED_QUALITY_GATE_STATUS
    );
  });

  it('recognizes terminal quality-gate failures only', () => {
    assert.equal(
      isTerminalQualityGateResult({ qualityGateTerminalFailure: true }),
      true
    );
    assert.equal(
      isTerminalQualityGateResult({ qualityGateTerminalFailure: false }),
      false
    );
    assert.equal(isTerminalQualityGateResult(null), false);
  });

  it('preserves generated copy and hard-fail metadata for manual review', () => {
    const generated = buildQualityGateGeneratedResult({
      reply: 'bad first bubble',
      messages: ['bad first bubble', 'bad second bubble'],
      stage: 'CALL_PROPOSAL',
      subStage: 'READY',
      stageConfidence: 0.4,
      systemPromptVersion: 'test-v1',
      suggestionId: 'sug_123',
      qualityGateHardFails: ['call_proposal_prereqs_missing: buy_in_confirmed'],
      qualityGateAttempts: 3
    }) as Record<string, unknown>;

    assert.equal(generated.reply, 'bad first bubble');
    assert.deepEqual(generated.messages, [
      'bad first bubble',
      'bad second bubble'
    ]);
    assert.equal(generated.qualityGateTerminalFailure, true);
    assert.equal(
      generated.qualityGateFailureReason,
      QUALITY_GATE_FAILURE_REASON
    );
    assert.deepEqual(generated.qualityGateHardFails, [
      'call_proposal_prereqs_missing: buy_in_confirmed'
    ]);
    assert.equal(generated.qualityGateAttempts, 3);
  });

  it('carries scheduled-reply escalation context without crashing callers', () => {
    const generatedResult = buildQualityGateGeneratedResult({
      reply: 'draft',
      messages: ['draft'],
      qualityGateHardFails: ['msg_verbatim_violation: missing required msg']
    });
    const error = new QualityGateEscalationError({
      conversationId: 'conv_123',
      accountId: 'acct_123',
      suggestionId: 'sug_123',
      generatedResult,
      hardFails: ['msg_verbatim_violation: missing required msg']
    });

    assert.equal(error.message, QUALITY_GATE_FAILURE_LAST_ERROR);
    assert.equal(isQualityGateEscalationError(error), true);
    assert.equal(error.code, FAILED_QUALITY_GATE_STATUS);
    assert.equal(error.conversationId, 'conv_123');
    assert.deepEqual(error.hardFails, [
      'msg_verbatim_violation: missing required msg'
    ]);
  });
});

describe('gate-trusts-position guard (F5.1 [4])', () => {
  // NOTE: step_distance_violation is a SOFT signal post-2026-06-05 (it ships
  // best-effort, never silences) — it may live in a soft bucket rather than
  // hardFails. These tests assert the GUARD: whether the gate generates the
  // violation at all, by inspecting the full result for the signal string.
  const callProposalReply = 'wanna hop on a quick call to map it out?';
  const hasStepDistance = (result: unknown) =>
    JSON.stringify(result).includes('step_distance_violation');

  it('GENERATES step_distance_violation on a far-ahead reply when no jump', () => {
    // Call-proposal content (infers a far-ahead step) while gate thinks we're on
    // step 1 and the position did NOT jump → this IS a forward over-skip.
    const result = scoreVoiceQualityGroup([callProposalReply], {
      currentScriptStepNumber: 1,
      positionJumpedThisTurn: false
    });
    assert.ok(
      hasStepDistance(result),
      'expected step_distance_violation when far-ahead reply without a jump'
    );
  });

  it('SUPPRESSES step_distance_violation when position legitimately jumped', () => {
    // Same reply, but the position caught up this turn (provable 1b path) →
    // a catch-up to the true step is not an over-skip → must NOT be flagged.
    const result = scoreVoiceQualityGroup([callProposalReply], {
      currentScriptStepNumber: 1,
      positionJumpedThisTurn: true
    });
    assert.ok(
      !hasStepDistance(result),
      'step_distance_violation must be suppressed on a legit catch-up turn'
    );
  });
});

describe('call-proposal gate — script-derived prereqs + qualified bypass (F5.1 8.2)', () => {
  const callReply =
    'wanna hop on a quick call with my coach anthony to map this out?';
  const hasPrereqFail = (r: unknown) =>
    JSON.stringify(r).includes('call_proposal_prereqs_missing');

  it('BLOCKS the call proposal when prereqs are missing and lead is not qualified', () => {
    const r = scoreVoiceQualityGroup([callReply], { capturedDataPoints: {} });
    assert.ok(hasPrereqFail(r), 'expected prereq gate to block (no bypass)');
  });

  it('BYPASSES the gate when lead.stage === QUALIFIED', () => {
    const r = scoreVoiceQualityGroup([callReply], {
      capturedDataPoints: {},
      leadStage: 'QUALIFIED'
    });
    assert.ok(!hasPrereqFail(r), 'QUALIFIED lead must not be blocked');
  });

  it('BYPASSES the gate when capitalThresholdMet === true', () => {
    const r = scoreVoiceQualityGroup([callReply], {
      capturedDataPoints: {},
      capitalThresholdMet: true
    });
    assert.ok(!hasPrereqFail(r), 'capital-verified lead must not be blocked');
  });

  it('uses the DERIVED prereqs when provided (a 1-prereq script blocks on just that)', () => {
    // A non-DAE script that only requires income_goal → missing it blocks, but
    // none of the DAE-specific fields (work/belief/buy_in) are required.
    const derived = [
      {
        id: 'income_goal',
        label: 'monthly income goal',
        stepNumber: 2,
        acceptableKeys: ['incomeGoal', 'income_goal']
      }
    ];
    const blocked = scoreVoiceQualityGroup([callReply], {
      capturedDataPoints: {},
      callProposalPrereqs: derived
    });
    assert.ok(
      hasPrereqFail(blocked) &&
        JSON.stringify(blocked).includes('income_goal') &&
        !JSON.stringify(blocked).includes('work_background'),
      'derived gate blocks only on the script-own prereq, not DAE fields'
    );
    // once income_goal is captured (from its own ask step 2), gate clears
    const cleared = scoreVoiceQualityGroup([callReply], {
      capturedDataPoints: {
        incomeGoal: {
          value: 15000,
          confidence: 'HIGH',
          sourceStepNumber: 2,
          extractionMethod: 'amount_after_step_9_prompt'
        },
        branchHistory: [
          {
            eventType: 'step_completed',
            stepNumber: 2,
            completedAt: '2026-06-09T00:00:00.000Z'
          }
        ]
      },
      callProposalPrereqs: derived
    });
    assert.ok(
      !hasPrereqFail(cleared),
      'derived gate clears once the script-own prereq is captured'
    );
  });
});
