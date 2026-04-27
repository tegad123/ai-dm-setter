/* eslint-disable no-console */
// Verification suite for the four Souljah J 2026-04-25 fixes.
//
//   FIX 1 — repeated_question soft signal
//   FIX 2 — repeated_call_pitch hard-fail
//   FIX 3 — GBP-aware R24 threshold compare + parser
//   FIX 4 — human-handoff briefing in buildDynamicSystemPrompt
//
// Pure-logic tests where possible. FIX 4 hits the real prompt builder
// against a live persona row + DB, then deletes nothing (read-only).

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import {
  scoreVoiceQuality,
  scoreVoiceQualityGroup
} from '../src/lib/voice-quality-gate';
import {
  parseLeadCapitalAnswer,
  detectConversationCurrency
} from '../src/lib/ai-engine';
import { buildDynamicSystemPrompt } from '../src/lib/ai-prompts';
import prisma from '../src/lib/prisma';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

async function main() {
  // ── FIX 1 — repeated_question soft signal ─────────────────────
  console.log('\n[FIX 1] Repeated question soft signal');
  const previousAI =
    'got it bro, and how much capital you got ready to start with on the trading side?';
  const repeatingReply =
    'yeah I hear you on strategy bro, and how much capital you got ready to start?';
  const acknowledgingReply =
    "good q tbh — strategy's all about confluence on the higher TFs first. lemme know how you're approaching that, then we can talk capital";
  const r1Repeat = scoreVoiceQuality(repeatingReply, {
    previousAIMessage: previousAI
  });
  const r1Ack = scoreVoiceQuality(acknowledgingReply, {
    previousAIMessage: previousAI
  });
  expect(
    'fires repeated_question on a near-duplicate Q',
    r1Repeat.softSignals.repeated_question,
    -0.4
  );
  expect(
    'silent when the AI answers the strategy Q before re-asking',
    r1Ack.softSignals.repeated_question,
    undefined
  );

  // No previous AI msg → must no-op even on identical text.
  const r1None = scoreVoiceQuality(repeatingReply, {
    previousAIMessage: null
  });
  expect(
    'no fire when previousAIMessage is null (first AI turn)',
    r1None.softSignals.repeated_question,
    undefined
  );

  // ── FIX 2 — repeated_call_pitch hard fail ─────────────────────
  console.log('\n[FIX 2] Repeated call pitch hard-fail');
  const prevPitch = 'wanna hop on a quick call with Anthony this week?';
  const currPitchAgain =
    "yeah let's hop on a quick call bro — anthony will lock you in";
  const currNoPitch =
    "yeah totally hear you bro, and on the strategy side, what's the holdup?";
  const r2Repeat = scoreVoiceQualityGroup([currPitchAgain], {
    previousAIMessage: prevPitch
  });
  const r2NoRepeat = scoreVoiceQualityGroup([currNoPitch], {
    previousAIMessage: prevPitch
  });
  expect(
    'hard-fails on second consecutive call pitch',
    r2Repeat.hardFails.some((f) => f.includes('repeated_call_pitch:')),
    true
  );
  expect(
    'no fire when current turn does NOT pitch',
    r2NoRepeat.hardFails.some((f) => f.includes('repeated_call_pitch:')),
    false
  );
  // No previous AI message → cannot fire even on a pitch-shaped current.
  const r2NoPrev = scoreVoiceQualityGroup([currPitchAgain], {
    previousAIMessage: null
  });
  expect(
    'no fire when there is no previous AI turn',
    r2NoPrev.hardFails.some((f) => f.includes('repeated_call_pitch:')),
    false
  );

  // ── FIX 3 — GBP-aware capital parser + threshold compare ─────
  console.log('\n[FIX 3] GBP currency awareness');
  // Parser must extract amount from a £ string.
  const gbp1k = parseLeadCapitalAnswer('I have £1,000 ready');
  expect('parseLeadCapitalAnswer extracts 1000 from "£1,000"', gbp1k, {
    kind: 'amount',
    amount: 1000
  });
  const gbp800 = parseLeadCapitalAnswer('£800 saved up');
  expect('parseLeadCapitalAnswer extracts 800 from "£800"', gbp800, {
    kind: 'amount',
    amount: 800
  });

  // detectConversationCurrency: synthesise a conversation row + lead
  // message containing £, then probe.
  const stamp = `gbp-test-${Date.now()}`;
  const account = await prisma.account.create({
    data: { name: stamp, slug: stamp }
  });
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: 'GBP Test',
      handle: 'gbp_test',
      platform: 'INSTAGRAM',
      platformUserId: `pu-${stamp}`,
      stage: 'NEW_LEAD',
      triggerType: 'DM',
      conversation: { create: { aiActive: true } }
    },
    include: { conversation: true }
  });
  const conversationId = lead.conversation!.id;
  await prisma.message.create({
    data: {
      conversationId,
      sender: 'LEAD',
      content: 'I have about £1,000 set aside for trading',
      timestamp: new Date()
    }
  });
  const currency = await detectConversationCurrency(conversationId);
  expect('detectConversationCurrency → GBP when lead used £', currency, 'GBP');

  // Lead with no £ → USD default.
  const account2 = await prisma.account.create({
    data: { name: `${stamp}-usd`, slug: `${stamp}-usd` }
  });
  const lead2 = await prisma.lead.create({
    data: {
      accountId: account2.id,
      name: 'USD Test',
      handle: 'usd_test',
      platform: 'INSTAGRAM',
      platformUserId: `pu-usd-${stamp}`,
      stage: 'NEW_LEAD',
      triggerType: 'DM',
      conversation: { create: { aiActive: true } }
    },
    include: { conversation: true }
  });
  const conversationId2 = lead2.conversation!.id;
  await prisma.message.create({
    data: {
      conversationId: conversationId2,
      sender: 'LEAD',
      content: 'I have $1,000 saved',
      timestamp: new Date()
    }
  });
  const currency2 = await detectConversationCurrency(conversationId2);
  expect('detectConversationCurrency → USD when lead used $', currency2, 'USD');

  // ── FIX 3 prompt block emission ───────────────────────────────
  console.log('\n[FIX 3] GBP prompt block emission');
  const personaForPrompt = await prisma.aIPersona.findFirst({
    select: { accountId: true }
  });
  if (!personaForPrompt) {
    console.error('No aIPersona row found — skipping prompt-block tests.');
  } else {
    const minimalContext = {
      leadId: 'test',
      leadName: 'Test',
      handle: 'test_handle',
      platform: 'INSTAGRAM',
      status: 'NEW_LEAD',
      triggerType: 'DM',
      triggerSource: null,
      qualityScore: 0
    } as any;
    const promptGbp = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext,
      undefined,
      undefined,
      undefined,
      'GBP'
    );
    expect(
      'GBP block appears when conversationCurrency=GBP',
      promptGbp.includes('## CURRENCY CONTEXT (GBP)'),
      true
    );
    expect(
      'GBP block mentions £800 ≈ $1,000',
      promptGbp.includes('£800') && promptGbp.includes('$1,000'),
      true
    );
    const promptUsd = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext,
      undefined,
      undefined,
      undefined,
      'USD'
    );
    expect(
      'GBP block absent when conversationCurrency=USD',
      promptUsd.includes('## CURRENCY CONTEXT (GBP)'),
      false
    );

    // ── FIX 4 — Human-handoff briefing block ─────────────────────
    console.log('\n[FIX 4] Human-handoff briefing block');
    const promptWithHumans = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext,
      undefined,
      undefined,
      [
        { content: 'yo bro how much capital you got?', timestamp: new Date() },
        { content: 'cool, lemme know if you wanna chat', timestamp: new Date() }
      ]
    );
    expect(
      'handoff block appears when priorHumanMessages has entries',
      promptWithHumans.includes('## HUMAN HANDOFF (CRITICAL'),
      true
    );
    expect(
      'handoff block tells AI not to restart',
      promptWithHumans.includes('DO NOT re-introduce yourself'),
      true
    );
    expect(
      'handoff block lists the recent human turns',
      promptWithHumans.includes('how much capital you got?'),
      true
    );
    const promptNoHumans = await buildDynamicSystemPrompt(
      personaForPrompt.accountId,
      minimalContext,
      undefined,
      undefined,
      []
    );
    expect(
      'handoff block absent when priorHumanMessages is empty',
      promptNoHumans.includes('## HUMAN HANDOFF (CRITICAL'),
      false
    );
  }

  // ── Cleanup synthetic accounts ──────────────────────────────
  console.log('\nCleaning up synthetic data…');
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.message.deleteMany({
    where: { conversationId: conversationId2 }
  });
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.conversation.delete({ where: { id: conversationId2 } });
  await prisma.lead.delete({ where: { id: lead.id } });
  await prisma.lead.delete({ where: { id: lead2.id } });
  await prisma.account.delete({ where: { id: account.id } });
  await prisma.account.delete({ where: { id: account2.id } });

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
