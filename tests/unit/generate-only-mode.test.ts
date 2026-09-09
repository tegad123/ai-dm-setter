// Generate-only shadow mode (2026-09-08, IG parity day 2).
// Run: npx tsx --test tests/unit/generate-only-mode.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeInboundAiActive,
  resolvePlatformGenerateOnly
} from '../../src/lib/generate-only';
import { shouldAutoSendReply } from '../../src/lib/webhook-processor';

describe('resolvePlatformGenerateOnly', () => {
  it('is per platform and defaults to false', () => {
    const acct = { generateOnlyInstagram: true, generateOnlyFacebook: false };
    assert.equal(resolvePlatformGenerateOnly(acct, 'INSTAGRAM'), true);
    assert.equal(resolvePlatformGenerateOnly(acct, 'FACEBOOK'), false);
    assert.equal(resolvePlatformGenerateOnly(null, 'INSTAGRAM'), false);
    assert.equal(resolvePlatformGenerateOnly(acct, 'OTHER'), false);
  });
});

describe('computeInboundAiActive', () => {
  it('unchanged behaviour when generate-only is off: Away Mode decides', () => {
    assert.equal(
      computeInboundAiActive({
        isOngoing: false,
        awayMode: false,
        generateOnly: false,
        defaultAiActive: true
      }),
      false
    );
    assert.equal(
      computeInboundAiActive({
        isOngoing: false,
        awayMode: true,
        generateOnly: false,
        defaultAiActive: true
      }),
      true
    );
  });

  it('generate-only turns AI on for generation even with Away Mode off', () => {
    assert.equal(
      computeInboundAiActive({
        isOngoing: false,
        awayMode: false,
        generateOnly: true,
        defaultAiActive: true
      }),
      true
    );
  });

  it('respects defaultAiActive=false and ongoing conversations', () => {
    assert.equal(
      computeInboundAiActive({
        isOngoing: false,
        awayMode: false,
        generateOnly: true,
        defaultAiActive: false
      }),
      false
    );
    assert.equal(
      computeInboundAiActive({
        isOngoing: true,
        awayMode: true,
        generateOnly: true,
        defaultAiActive: true
      }),
      false
    );
  });
});

describe('generate-only lands in suggestion mode', () => {
  it('AI on + Away Mode off + no override → generated but NOT auto-sent', () => {
    const aiActive = computeInboundAiActive({
      isOngoing: false,
      awayMode: false,
      generateOnly: true,
      defaultAiActive: true
    });
    assert.equal(aiActive, true);
    assert.equal(
      shouldAutoSendReply({
        aiActive,
        awayMode: false,
        autoSendOverride: false
      }),
      false
    );
  });

  it('operator per-conversation override still auto-sends (their explicit choice)', () => {
    assert.equal(
      shouldAutoSendReply({
        aiActive: true,
        awayMode: false,
        autoSendOverride: true
      }),
      true
    );
  });
});
