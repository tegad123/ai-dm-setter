// BUG 19 — keepalive-on-active-conversation
// What: silent-stop heartbeat fired "yo bro you still around?" 8
//       minutes after @arro_.92 burst-typed 5 messages between
//       7:03–7:05 AM. The AI had also responded by 7:06; the lead
//       was clearly active. The fallback insulted them and they
//       disengaged.
// Found: 2026-05-05 production audit.
// Fixed: isConversationActive guard in src/lib/silent-stop-recovery.ts
//       (skips any conversation where lead AND AI have spoken in the
//       last 10 min, OR lead has spoken and awaitingAiResponse=true).
// Run: npx tsx --test tests/unit/bug-19-keepalive-on-active-conversation.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  ACTIVE_WINDOW_MS_FOR_TEST,
  isConversationActiveForTest
} from '../../src/lib/silent-stop-recovery';

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000);

describe('isConversationActive — bug 19 keepalive on active conversation', () => {
  it('returns TRUE when lead burst-typed and AI responded in last 10 min', () => {
    // The exact @arro_.92 shape: lead 5 messages 7:03–7:05, AI reply
    // at 7:06, evaluation at 7:13 (8 min after the AI reply, 8 min
    // after the last lead message). Both sides have spoken inside
    // the 10-min active window → conversation is active → heartbeat
    // must skip.
    const active = isConversationActiveForTest({
      awaitingAiResponse: false,
      messages: [
        { sender: 'LEAD', timestamp: minutesAgo(10) },
        { sender: 'LEAD', timestamp: minutesAgo(9.5) },
        { sender: 'LEAD', timestamp: minutesAgo(9) },
        { sender: 'LEAD', timestamp: minutesAgo(8.5) },
        { sender: 'LEAD', timestamp: minutesAgo(8) },
        { sender: 'AI', timestamp: minutesAgo(7) }
      ]
    });
    assert.equal(active, true);
  });

  it('returns TRUE when lead spoke recently AND awaitingAiResponse is true (mid-generation)', () => {
    // Lead just spoke, AI hasn't replied yet but the pipeline is
    // mid-flight. Firing the silent-stop here would step on the
    // in-flight reply.
    const active = isConversationActiveForTest({
      awaitingAiResponse: true,
      messages: [{ sender: 'LEAD', timestamp: minutesAgo(2) }]
    });
    assert.equal(active, true);
  });

  it('returns FALSE when lead has gone genuinely silent (>10 min) after AI reply', () => {
    // The legitimate silent-stop trigger: AI's last turn was the
    // most recent message and >10 min have passed without the lead
    // returning. Heartbeat should fire here.
    const active = isConversationActiveForTest({
      awaitingAiResponse: true,
      messages: [
        { sender: 'LEAD', timestamp: minutesAgo(20) },
        { sender: 'AI', timestamp: minutesAgo(19) }
      ]
    });
    assert.equal(active, false);
  });

  it('returns FALSE when only AI has spoken recently (no lead activity in window)', () => {
    // AI sent something but the lead has been quiet — not "active"
    // in the back-and-forth sense. The heartbeat is allowed.
    const active = isConversationActiveForTest({
      awaitingAiResponse: false,
      messages: [
        { sender: 'LEAD', timestamp: minutesAgo(60) },
        { sender: 'AI', timestamp: minutesAgo(5) }
      ]
    });
    assert.equal(active, false);
  });

  it('returns FALSE when lead spoke recently but AI has not, and we are NOT awaiting (paused convo)', () => {
    // Edge case: aiActive=false (paused), lead replied with no
    // pending reply. Without awaitingAiResponse the heartbeat
    // shouldn't be tripping anyway, but if it ever did, we want it
    // to skip.
    const active = isConversationActiveForTest({
      awaitingAiResponse: false,
      messages: [{ sender: 'LEAD', timestamp: minutesAgo(3) }]
    });
    assert.equal(active, false);
  });

  it('ACTIVE_WINDOW_MS is 10 minutes', () => {
    // Lock the window value so an accidental edit to the constant
    // surfaces as a test failure, not a silent regression.
    assert.equal(ACTIVE_WINDOW_MS_FOR_TEST, 10 * 60 * 1000);
  });
});
