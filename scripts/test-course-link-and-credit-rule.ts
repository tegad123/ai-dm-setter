/* eslint-disable no-console */
// Verifies:
//   • voice-quality-gate hard-fails ALL course/payment placeholder
//     variants (the George 2026-04-08 leak shape + others)
//   • generic bracketed-placeholder fallback still fires on tokens
//     not in the dedicated set (e.g. [BOOKING LINK], [LINK])
//   • clean replies with real https:// URLs do not false-fire
//   • master prompt now contains the CREDIT CARD PIVOT RULE block
//     with both the acceptable and forbidden language

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import { scoreVoiceQuality } from '../src/lib/voice-quality-gate';
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
  // ── TEST 1: George leak shape ─────────────────────────────────
  console.log('\n[TEST 1] George 2026-04-08 leak — [COURSE PAYMENT LINK]');
  const r1 = scoreVoiceQuality(
    "Let's get it bro. Here's the link → [COURSE PAYMENT LINK]. Once you're in you'll get immediate access."
  );
  expect(
    'hard-fails course_link_placeholder_leaked',
    r1.hardFails.some((f) => f.includes('course_link_placeholder_leaked:')),
    true
  );
  expect(
    'failure message names the matched token',
    r1.hardFails.some((f) => f.includes('[COURSE PAYMENT LINK]')),
    true
  );

  // ── TEST 2: each spec-listed variant fires ────────────────────
  console.log('\n[TEST 2] all spec-listed course-link variants fire');
  const variants: Array<[string, string]> = [
    ['[COURSE PAYMENT LINK]', 'yo bro grab it: [COURSE PAYMENT LINK]'],
    ['[COURSE LINK]', "here's the course bro: [COURSE LINK]"],
    ['[PAYMENT LINK]', 'drop your card here bro: [PAYMENT LINK]'],
    ['[WHOP LINK]', 'this is it: [WHOP LINK]'],
    ['[CHECKOUT LINK]', 'go check this out → [CHECKOUT LINK]'],
    ['[COURSE URL]', 'smash this bro: [COURSE URL]']
  ];
  for (const [token, sample] of variants) {
    const r = scoreVoiceQuality(sample);
    expect(
      `course leak: "${token}"`,
      r.hardFails.some((f) => f.includes('course_link_placeholder_leaked:')),
      true
    );
  }

  // ── TEST 3: lowercase variant still caught (case-insensitive) ─
  console.log('\n[TEST 3] lowercase variants caught');
  const r3 = scoreVoiceQuality('here you go bro: [course payment link]');
  expect(
    'lowercase [course payment link] fires',
    r3.hardFails.some((f) => f.includes('course_link_placeholder_leaked:')),
    true
  );

  // ── TEST 4: generic fallback still works ──────────────────────
  console.log(
    '\n[TEST 4] generic bracketed-placeholder fallback (non-course tokens)'
  );
  const r4 = scoreVoiceQuality('drop your time here bro: [BOOKING LINK]');
  expect(
    '[BOOKING LINK] fires bracketed_placeholder_leaked',
    r4.hardFails.some((f) => f.includes('bracketed_placeholder_leaked:')),
    true
  );
  expect(
    '[BOOKING LINK] does NOT misfire course-specific check',
    r4.hardFails.some((f) => f.includes('course_link_placeholder_leaked:')),
    false
  );

  // ── TEST 5: clean reply with real URL passes ──────────────────
  console.log('\n[TEST 5] clean reply with real URL passes');
  const r5 = scoreVoiceQuality(
    "yo let's get it bro: https://whop.com/checkout/17xvsu5mtr2luz7SrD-UXYx-Rx1U-Q8lg-IBn57oRarBX6/"
  );
  expect(
    'no placeholder failures with real URL',
    r5.hardFails.some(
      (f) =>
        f.includes('course_link_placeholder_leaked:') ||
        f.includes('bracketed_placeholder_leaked:')
    ),
    false
  );

  // ── TEST 6: incidental brackets in lowercase content (eg [a]) ─
  console.log('\n[TEST 6] lowercase incidental brackets do not false-fire');
  const r6 = scoreVoiceQuality(
    "here's the deal: option [a] vs option [b], pick whichever bro"
  );
  expect(
    'lowercase [a] / [b] do NOT fire',
    r6.hardFails.some(
      (f) =>
        f.includes('bracketed_placeholder_leaked:') ||
        f.includes('course_link_placeholder_leaked:')
    ),
    false
  );

  // ── TEST 7: CREDIT CARD PIVOT RULE in master prompt ───────────
  console.log('\n[TEST 7] CREDIT CARD PIVOT RULE — master prompt assertions');
  const persona = await prisma.aIPersona.findFirst({
    select: { accountId: true }
  });
  if (persona) {
    const minimalContext = {
      leadId: 'test',
      leadName: 'Test',
      handle: 'test_handle',
      platform: 'INSTAGRAM',
      status: 'NEW_LEAD',
      triggerType: 'DM',
      qualityScore: 0
    } as any;
    const prompt = await buildDynamicSystemPrompt(
      persona.accountId,
      minimalContext
    );
    expect(
      'prompt contains CREDIT CARD PIVOT RULE heading',
      prompt.includes('CREDIT CARD PIVOT RULE'),
      true
    );
    expect(
      'prompt distinguishes credit for course vs trading capital',
      prompt.includes('credit for trading capital') ||
        prompt.includes('NEVER acceptable'),
      true
    );
    expect(
      'prompt mentions Klarna / payment plan branch',
      prompt.toLowerCase().includes('klarna') ||
        prompt.toLowerCase().includes('payment plan') ||
        prompt.toLowerCase().includes('installment'),
      true
    );
    expect(
      'prompt limits the rule to US/CA',
      prompt.includes('US/CA') ||
        prompt.toLowerCase().includes('us/ca only') ||
        prompt.toLowerCase().includes('united states'),
      true
    );
    expect(
      'prompt explicitly forbids "use your credit card for trading capital"',
      prompt.includes('credit card for trading capital'),
      true
    );
    expect(
      'prompt includes the acceptable phrasing example',
      prompt.includes('used their card to invest in the course'),
      true
    );
  }

  await prisma.$disconnect();

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
