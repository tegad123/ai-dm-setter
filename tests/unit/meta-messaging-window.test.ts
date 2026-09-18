// Run: NODE_PATH=$PWD/node_modules npx tsx --test tests/unit/meta-messaging-window.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  assertHumanAgentTagIsOperatorInitiated,
  decideAutomatedMessageWindow,
  META_STANDARD_MESSAGING_WINDOW_MS
} from '../../src/lib/meta-messaging-window';

describe('automated Meta messaging window', () => {
  const now = new Date('2026-09-18T20:24:39.000Z');

  it('uses the standard send path for a 12-hour follow-up', () => {
    const decision = decideAutomatedMessageWindow({
      now,
      messages: [
        {
          sender: 'LEAD',
          timestamp: new Date(now.getTime() - 12 * 60 * 60 * 1000)
        }
      ]
    });

    assert.equal(decision.action, 'send_standard');
    assert.equal(decision.ageMs, 12 * 60 * 60 * 1000);
  });

  it('uses the newest lead inbound when messages are unordered', () => {
    const newest = new Date(now.getTime() - 30 * 60 * 1000);
    const decision = decideAutomatedMessageWindow({
      now,
      messages: [
        { sender: 'LEAD', timestamp: newest },
        {
          sender: 'LEAD',
          timestamp: new Date(now.getTime() - 23 * 60 * 60 * 1000)
        },
        { sender: 'AI', timestamp: now }
      ]
    });

    assert.equal(decision.action, 'send_standard');
    assert.equal(decision.latestLeadInboundAt?.getTime(), newest.getTime());
  });

  it('cancels automated sends at or beyond 24 hours', () => {
    for (const ageMs of [
      META_STANDARD_MESSAGING_WINDOW_MS,
      META_STANDARD_MESSAGING_WINDOW_MS + 1
    ]) {
      const decision = decideAutomatedMessageWindow({
        now,
        messages: [
          {
            sender: 'LEAD',
            timestamp: new Date(now.getTime() - ageMs)
          }
        ]
      });
      assert.equal(decision.action, 'cancel_outside_window');
    }
  });

  it('cancels when no lead inbound establishes a messaging window', () => {
    const decision = decideAutomatedMessageWindow({
      now,
      messages: [{ sender: 'AI', timestamp: now }]
    });

    assert.equal(decision.action, 'cancel_outside_window');
    assert.equal(decision.latestLeadInboundAt, null);
  });
});

describe('HUMAN_AGENT policy guard', () => {
  it('blocks automated use of the HUMAN_AGENT tag', () => {
    assert.throws(
      () =>
        assertHumanAgentTagIsOperatorInitiated({
          tag: 'HUMAN_AGENT',
          operatorInitiated: false
        }),
      /genuine operator-initiated reply/
    );
  });

  it('allows an explicitly operator-initiated HUMAN_AGENT reply', () => {
    assert.doesNotThrow(() =>
      assertHumanAgentTagIsOperatorInitiated({
        tag: 'HUMAN_AGENT',
        operatorInitiated: true
      })
    );
  });

  it('allows ordinary automated responses without the tag', () => {
    assert.doesNotThrow(() =>
      assertHumanAgentTagIsOperatorInitiated({ operatorInitiated: false })
    );
  });
});
