/* eslint-disable no-console */
// Calls the real buildDynamicSystemPrompt() against a live account row
// and prints the first 3 lines + asserts the date is at the very top.
//
// Run: pnpm tsx scripts/test-date-injection-live.ts

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import {
  buildDynamicSystemPrompt,
  type LeadContext
} from '../src/lib/ai-prompts';

async function main() {
  // Pick any account that has an aiPersona row — we just need a valid
  // accountId so the prompt assembly executes.
  const persona = await prisma.aIPersona.findFirst({
    select: { accountId: true }
  });
  if (!persona) {
    console.error('No aIPersona rows found — cannot run live assembly test.');
    process.exit(1);
  }

  const minimalContext: LeadContext = {
    leadId: 'test-lead',
    leadName: 'Test',
    leadHandle: 'test',
    leadStage: 'NEW_LEAD',
    leadIntentTag: 'NEUTRAL',
    qualityScore: 0,
    triggerType: 'DM',
    triggerSource: null,
    platform: 'INSTAGRAM',
    conversationHistory: [],
    proposedSlots: null,
    selectedSlot: null,
    bookingId: null,
    bookingUrl: null,
    leadEmail: null,
    leadPhone: null,
    leadTimezone: null,
    conversationStats: null
  } as unknown as LeadContext;

  const prompt = await buildDynamicSystemPrompt(
    persona.accountId,
    minimalContext
  );

  console.log('── First 5 lines of assembled prompt ──');
  prompt
    .split('\n')
    .slice(0, 5)
    .forEach((l, i) => console.log(`  ${i}: ${l}`));

  const firstLine = prompt.split('\n')[0];
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC'
  });
  const ok = firstLine.startsWith('Today is ') && firstLine.includes(today);
  console.log(
    `\nFirst line starts with "Today is" and contains "${today}": ${ok ? '✓ PASS' : '✗ FAIL'}`
  );

  await prisma.$disconnect();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
