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
  isConversationActiveForTest,
  latestLeadAlreadyAnsweredForTest
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

  it('returns TRUE for the @shepherdgushe.zw shape (HUMAN replied recently, then lead replied within window)', () => {
    // HUMAN reply from the operator's phone (humanSource=PHONE)
    // counts as "bot side spoke recently" — the operator is engaged,
    // firing a silent-stop on top of their flow makes things worse.
    // Lead at 9:57, HUMAN at 9:54 (3 min before), silent-stop check
    // at 10:02 (5 min after lead). recentLead=true, recentBotSide=
    // true (HUMAN within window) → active → SKIP.
    const active = isConversationActiveForTest({
      awaitingAiResponse: true,
      messages: [
        { sender: 'LEAD', timestamp: minutesAgo(13) },
        { sender: 'HUMAN', timestamp: minutesAgo(8) },
        { sender: 'LEAD', timestamp: minutesAgo(5) }
      ]
    });
    assert.equal(active, true);
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

  it('returns TRUE when a stale awaiting row already has AI replies after the latest lead', () => {
    // Test 6 shape (2026-05-05): the lead returned after 15+ min with
    // a buying signal, the AI shipped a multi-bubble call pitch, but
    // the final Conversation update did not land before the silent-stop
    // heartbeat. The detector must trust the actual Message rows: if
    // latest non-system is AI/HUMAN after latest LEAD, the lead was
    // answered and silent-stop must skip/repair instead of creating an
    // OPERATOR_REVIEW event or keepalive.
    const alreadyAnswered = latestLeadAlreadyAnsweredForTest({
      messages: [
        { sender: 'LEAD', timestamp: minutesAgo(20) },
        { sender: 'AI', timestamp: minutesAgo(18) },
        { sender: 'AI', timestamp: minutesAgo(17) },
        { sender: 'AI', timestamp: minutesAgo(15) }
      ]
    });
    assert.equal(alreadyAnswered, true);
  });
});
