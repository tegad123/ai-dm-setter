// Unit tests for shouldAutoSendReply — the send-decision gate.
//
// Policy: auto-send fires when aiActive=true AND (awayMode=true OR
// autoSendOverride=true).
//
// Why awayMode is back: Conversation.aiActive @default(true) means
// every conversation row starts with aiActive=true. Without the
// awayMode/autoSendOverride check, every lead on every account would
// auto-send regardless of whether the operator enabled AI for that
// account. The awayMode||autoSendOverride term scopes auto-send to
// accounts where the operator deliberately turned it on.
//
// autoSendOverride=true is set by the ai-toggle route when the operator
// explicitly enables AI per-conversation. This lets per-conversation
// override work on accounts where global away-mode is off.
//
// Run: npx tsx --test tests/unit/should-auto-send-reply.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { shouldAutoSendReply } from '../../src/lib/webhook-processor';

describe('shouldAutoSendReply', () => {
  it('aiActive=true + awayMode=true → AUTO-SEND (normal away-mode path)', () => {
    assert.equal(
      shouldAutoSendReply({
        aiActive: true,
        awayMode: true,
        autoSendOverride: false
      }),
      true
    );
  });

  it('aiActive=true + awayMode=false + autoSendOverride=true → AUTO-SEND (operator explicit)', () => {
    // Operator flipped AI on for this specific conversation even though
    // global away-mode is off. autoSendOverride=true (set by ai-toggle
    // route) carries the intent.
    assert.equal(
      shouldAutoSendReply({
        aiActive: true,
        awayMode: false,
        autoSendOverride: true
      }),
      true
    );
  });

  it('aiActive=true + awayMode=false + autoSendOverride=false → SUGGEST only', () => {
    // aiActive=true from schema default, operator never explicitly
    // enabled auto-send, account has away-mode off. Must NOT fire.
    // This is the root-cause case from the 2026-05-05 "bot fires for
    // every lead" incident.
    assert.equal(
      shouldAutoSendReply({
        aiActive: true,
        awayMode: false,
        autoSendOverride: false
      }),
      false
    );
  });

  it('aiActive=false + awayMode=true → SUGGEST (operator paused this convo)', () => {
    // Per-convo AI is off. Account away-mode cannot override an
    // explicit operator pause.
    assert.equal(
      shouldAutoSendReply({
        aiActive: false,
        awayMode: true,
        autoSendOverride: false
      }),
      false
    );
  });

  it('aiActive=false + awayMode=false → SUGGEST', () => {
    assert.equal(
      shouldAutoSendReply({
        aiActive: false,
        awayMode: false,
        autoSendOverride: false
      }),
      false
    );
  });
});
