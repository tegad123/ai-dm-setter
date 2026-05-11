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
