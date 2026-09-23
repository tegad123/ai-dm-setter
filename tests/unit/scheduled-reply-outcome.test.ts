import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  buildScheduledReplyClaimSnapshot,
  retryScheduledReplyData,
  SCHEDULED_REPLY_TERMINAL_REASONS,
  terminalScheduledReplyData
} from '../../src/lib/scheduled-reply-outcome';

describe('scheduled reply structured outcomes', () => {
  it('writes terminal status, reason and timestamps together', () => {
    const at = new Date('2026-09-22T09:00:00.000Z');
    assert.deepEqual(
      terminalScheduledReplyData({
        status: 'CANCELLED',
        reasonCode: SCHEDULED_REPLY_TERMINAL_REASONS.SUPERSEDED_NEWER_INBOUND,
        terminalAt: at,
        lastError: 'newer inbound won'
      }),
      {
        status: 'CANCELLED',
        terminalReasonCode: 'SUPERSEDED_NEWER_INBOUND',
        terminalAt: at,
        processedAt: at,
        lastError: 'newer inbound won'
      }
    );
  });

  it('clears stale terminal evidence before a retry', () => {
    const retryAt = new Date('2026-09-22T09:05:00.000Z');
    assert.deepEqual(
      retryScheduledReplyData({ attempts: 2, scheduledFor: retryAt }),
      {
        status: 'PENDING',
        terminalReasonCode: null,
        terminalAt: null,
        processedAt: null,
        attempts: 2,
        scheduledFor: retryAt
      }
    );
  });

  it('captures the exact cursor, branch and lead turn seen at claim time', () => {
    assert.deepEqual(
      buildScheduledReplyClaimSnapshot({
        claimedAt: new Date('2026-09-22T09:00:00.000Z'),
        conversationUpdatedAt: new Date('2026-09-22T08:59:59.000Z'),
        latestLeadMessageId: 'msg-2',
        latestLeadMessageAt: new Date('2026-09-22T08:59:58.000Z'),
        currentScriptStep: 7,
        systemStage: 'Qualification',
        capturedDataPoints: {
          branchHistory: [
            { stepNumber: 6, selectedBranchLabel: 'Default' },
            { stepNumber: 7, selectedBranchLabel: 'Qualified' }
          ]
        }
      }),
      {
        claimedAt: '2026-09-22T09:00:00.000Z',
        conversationUpdatedAt: '2026-09-22T08:59:59.000Z',
        latestLeadMessageId: 'msg-2',
        latestLeadMessageAt: '2026-09-22T08:59:58.000Z',
        currentScriptStep: 7,
        systemStage: 'Qualification',
        selectedBranchLabel: 'Qualified'
      }
    );
  });
});
