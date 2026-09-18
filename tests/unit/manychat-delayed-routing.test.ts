import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isManyChatFirstReplyTurn } from '../../src/lib/manychat-first-reply-routing';
import {
  resolveStep1BranchMode,
  selectStep1BranchesForPrompt
} from '../../src/lib/script-serializer';
import { shouldForceColdStartStep1Inbound } from '../../src/lib/ai-engine';

const NOW = Date.parse('2026-09-18T18:00:00.000Z');
const lead = { id: 'lead-first-reply', sender: 'LEAD' };

function firstReplyEvidence(ageMs: number) {
  return {
    conversationSource: 'MANYCHAT',
    openerMessage: 'are you in the markets rn or starting?',
    currentLeadMessageId: lead.id,
    conversationHistory: [lead],
    currentScriptStep: 1,
    handoffReceipt: {
      leadMessageId: lead.id,
      status: 'QUEUED'
    },
    manyChatFiredAt: new Date(NOW - ageMs)
  };
}

const step1Branches = [
  {
    branchLabel: 'Default (ManyChat lead — already answered)',
    actions: [
      { actionType: 'runtime_judgment' },
      { actionType: 'ask_question', content: 'where are you based?' },
      { actionType: 'wait_for_response' }
    ]
  },
  {
    branchLabel: "Warm Inbound (DM'd directly)",
    actions: [
      { actionType: 'send_message', content: 'yo bro appreciate the message' },
      { actionType: 'ask_question', content: 'are you already trading?' },
      { actionType: 'wait_for_response' }
    ]
  }
];

describe('durable ManyChat first-reply routing', () => {
  for (const [label, ageMs] of [
    ['under two hours', 30 * 60_000],
    ['over two hours', 3 * 60 * 60_000],
    ['24 hours', 24 * 60 * 60_000],
    ['multiple days', 4 * 24 * 60 * 60_000]
  ] as const) {
    it(`preserves the first-reply branch ${label} after the opener`, () => {
      const evidence = firstReplyEvidence(ageMs);
      assert.equal(isManyChatFirstReplyTurn(evidence), true);
      assert.equal(
        resolveStep1BranchMode({
          conversationSource: evidence.conversationSource,
          manyChatFiredAt: evidence.manyChatFiredAt,
          manyChatFirstReply: true
        }),
        'manychat_cta'
      );
      assert.deepEqual(
        selectStep1BranchesForPrompt(step1Branches, {
          conversationSource: 'MANYCHAT',
          manyChatFiredAt: evidence.manyChatFiredAt,
          manyChatFirstReply: true
        }).map((branch) => branch.branchLabel),
        ['Default (ManyChat lead — already answered)']
      );
    });
  }

  it('does not force the direct-inbound cold start for a delayed first reply', () => {
    const evidence = firstReplyEvidence(4 * 24 * 60 * 60_000);
    assert.equal(
      shouldForceColdStartStep1Inbound({
        conversationHistory: [
          {
            id: lead.id,
            sender: lead.sender,
            content: 'starting',
            timestamp: new Date(NOW)
          }
        ],
        hasActiveScript: true,
        conversationSource: 'MANYCHAT',
        leadSource: 'OUTBOUND',
        manyChatFiredAt: evidence.manyChatFiredAt,
        currentScriptStep: 1,
        conversationMessageCount: 1,
        manyChatFirstReply: true
      }),
      false
    );
  });

  it('does not restart the first-reply branch after a completed handoff', () => {
    const history = [
      { id: 'opener', sender: 'MANYCHAT' },
      { id: lead.id, sender: 'LEAD' },
      { id: 'ai-reply', sender: 'AI' },
      { id: 'lead-reengagement', sender: 'LEAD' }
    ];
    assert.equal(
      isManyChatFirstReplyTurn({
        conversationSource: 'MANYCHAT',
        openerMessage: 'are you in the markets rn or starting?',
        currentLeadMessageId: 'lead-reengagement',
        conversationHistory: history,
        currentScriptStep: 2,
        handoffReceipt: {
          leadMessageId: lead.id,
          status: 'ALREADY_HANDLED'
        }
      }),
      false
    );
    assert.equal(
      resolveStep1BranchMode({
        conversationSource: 'MANYCHAT',
        manyChatFiredAt: new Date(NOW - 30 * 60_000),
        manyChatFirstReply: false
      }),
      'warm_inbound'
    );
  });

  it('does not treat a second unanswered lead message as the first reply', () => {
    assert.equal(
      isManyChatFirstReplyTurn({
        conversationSource: 'MANYCHAT',
        openerMessage: 'are you in the markets rn or starting?',
        currentLeadMessageId: 'lead-second-message',
        conversationHistory: [
          lead,
          { id: 'lead-second-message', sender: 'LEAD' }
        ],
        currentScriptStep: 1
      }),
      false
    );
  });

  it('does not reopen a receipt already marked handled', () => {
    const evidence = firstReplyEvidence(30 * 60_000);
    assert.equal(
      isManyChatFirstReplyTurn({
        ...evidence,
        handoffReceipt: {
          leadMessageId: lead.id,
          status: 'ALREADY_HANDLED'
        }
      }),
      false
    );
  });

  it('uses stored opener and pristine message state when no receipt exists', () => {
    const evidence = firstReplyEvidence(3 * 24 * 60 * 60_000);
    assert.equal(
      isManyChatFirstReplyTurn({
        ...evidence,
        handoffReceipt: null
      }),
      true
    );
  });
});
