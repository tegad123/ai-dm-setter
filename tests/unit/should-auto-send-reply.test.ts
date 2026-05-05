// Unit tests for shouldAutoSendReply — the send-decision gate.
//
// The policy (2026-05-05): AI auto-sends iff `aiActive=true` on the
// conversation. Away-mode does NOT influence this — it only controls
// the default value of aiActive on NEW conversation creation, never
// delivery for an existing conversation.
//
// These four cases are the locked-in contract. If a future change
// re-couples send-decision to away-mode (the prior buggy behavior),
// the first case (aiActive=true + awayMode=false → AUTO-SEND) flips
// and this test fails.
//
// Run: npx tsx --test tests/unit/should-auto-send-reply.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { shouldAutoSendReply } from '../../src/lib/webhook-processor';

describe('shouldAutoSendReply — aiActive is the sole send-decision gate', () => {
  it('aiActive=true + awayMode=false → AUTO-SEND (was the bug)', () => {
    // Pre-fix: this returned false because the dual-gate required
    // (awayMode || autoSendOverride). Operators flipping aiActive on
    // for a single conversation got an AISuggestion that never
    // shipped. Post-fix: aiActive=true alone produces auto-send.
    assert.equal(shouldAutoSendReply({ aiActive: true }), true);
  });

  it('aiActive=false + awayMode=true → SUGGEST', () => {
    // Operator paused this specific conversation. Even with platform
    // away-mode on, this one stays in suggestion mode. aiActive is
    // the override — operator's per-convo intent wins.
    assert.equal(shouldAutoSendReply({ aiActive: false }), false);
  });

  it('aiActive=true + awayMode=true → AUTO-SEND', () => {
    // Both signals aligned — auto-send. Same answer as pre-fix.
    assert.equal(shouldAutoSendReply({ aiActive: true }), true);
  });

  it('aiActive=false + awayMode=false → SUGGEST', () => {
    // Both signals aligned — suggestion mode only. Same answer as
    // pre-fix.
    assert.equal(shouldAutoSendReply({ aiActive: false }), false);
  });

  it('signature shape — function takes only aiActive (away-mode is not a parameter)', () => {
    // Locks the API contract: if a future change adds awayMode (or
    // autoSendOverride) back to the signature, this assert fails and
    // the maintainer has to think about whether they really want to
    // re-couple the policy. The signature itself is the documented
    // invariant.
    const fnArity = shouldAutoSendReply.length;
    assert.equal(
      fnArity,
      1,
      'shouldAutoSendReply should accept exactly one args object'
    );
  });
});
