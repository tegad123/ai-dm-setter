/* eslint-disable no-console */
// Idempotent seed for the smoke-test database.
//
// Creates one account + one persona + one IntegrationCredential. The
// persona's URL fields are filled with TEST_URLS so the smoke suite
// can assert exact URL match without bumping into production links.
//
// Run:
//   TEST_DATABASE_URL=postgres://... npm run test:smoke:seed
//
// Output: SMOKE_TEST_PERSONA_ID=<id>  — copy into .env.test.local

import { SMOKE_CONFIG, TEST_URLS } from './smoke-config';

async function main() {
  // Lazy-import after smoke-config has rewritten DATABASE_URL.
  const prisma = (await import('../../src/lib/prisma')).default;

  const account = await prisma.account.upsert({
    where: { slug: SMOKE_CONFIG.testAccountSlug },
    create: {
      slug: SMOKE_CONFIG.testAccountSlug,
      name: 'Smoke Test Account',
      plan: 'PRO',
      aiProvider: 'anthropic',
      awayModeInstagram: true
    },
    update: {
      aiProvider: 'anthropic',
      awayModeInstagram: true
    }
  });
  // Account has no top-level applicationForm/bookingTypeform field;
  // the URL lives in AIPersona.promptConfig.bookingTypeformUrl below.

  await prisma.integrationCredential.upsert({
    where: {
      accountId_provider: { accountId: account.id, provider: 'ANTHROPIC' }
    },
    create: {
      accountId: account.id,
      provider: 'ANTHROPIC',
      credentials: {
        apiKey: SMOKE_CONFIG.anthropicApiKey,
        model: 'claude-sonnet-4-5-20250929'
      },
      isActive: true,
      verifiedAt: new Date()
    },
    update: {
      credentials: {
        apiKey: SMOKE_CONFIG.anthropicApiKey,
        model: 'claude-sonnet-4-5-20250929'
      },
      isActive: true
    }
  });

  // Stable persona slug-via-name lookup. AIPersona has no @unique slug,
  // so we look up by (accountId, personaName) and upsert manually.
  const existingPersona = await prisma.aIPersona.findFirst({
    where: {
      accountId: account.id,
      personaName: SMOKE_CONFIG.testPersonaName
    }
  });

  const personaData = {
    accountId: account.id,
    personaName: SMOKE_CONFIG.testPersonaName,
    fullName: 'Daniel Test',
    companyName: 'QualifyDMs Smoke Tests',
    tone: 'casual, direct, friendly',
    systemPrompt: SMOKE_PERSONA_SYSTEM_PROMPT,
    qualificationFlow: JSON.stringify(SMOKE_QUALIFICATION_FLOW),
    objectionHandling: JSON.stringify(SMOKE_OBJECTIONS),
    voiceNoteDecisionPrompt: SMOKE_VOICE_NOTE_PROMPT,
    qualityScoringPrompt: SMOKE_QUALITY_SCORING_PROMPT,
    freeValueLink: TEST_URLS.fallbackContent,
    customPhrases: JSON.stringify({ greeting: 'yo', affirmation: 'bet' }),
    promptConfig: {
      whatYouSell: 'a self-paced trading bootcamp + 1:1 mentorship',
      downsellLink: TEST_URLS.downsell,
      bookingTypeformUrl: TEST_URLS.applicationForm
    },
    downsellConfig: {
      productName: 'QDMS Test Bootcamp',
      price: 47,
      pitchMessage: 'self-paced course breaks down the system',
      link: TEST_URLS.downsell
    },
    minimumCapitalRequired: 1000,
    isActive: true
  };

  const persona = existingPersona
    ? await prisma.aIPersona.update({
        where: { id: existingPersona.id },
        data: personaData
      })
    : await prisma.aIPersona.create({ data: personaData });

  console.log('---');
  console.log(`SMOKE_TEST_ACCOUNT_ID=${account.id}`);
  console.log(`SMOKE_TEST_PERSONA_ID=${persona.id}`);
  console.log('---');
  console.log(
    `Copy SMOKE_TEST_PERSONA_ID into .env.test.local and re-run smoke tests.`
  );

  await prisma.$disconnect();
}

const SMOKE_PERSONA_SYSTEM_PROMPT = `You are Daniel — running smoke tests for QualifyDMs. You're DMing a lead about trading. Your job is to qualify them and route them correctly.

PERSONALITY & TONE:
- Talk like you're texting a friend. Casual, direct.
- Short messages. 1-3 sentences max.
- Use "yo" "bet" "fr" naturally. Lowercase fine.
- Match the lead's energy.

QUALIFICATION FLOW:
1. ACKNOWLEDGE
2. EXPERIENCE
3. GOALS
4. URGENCY
5. CAPITAL — ask if they have at least $1000 ready to deploy
6. ROUTE — capital >= $1000 → application; below → downsell course
7. DELIVER — drop the right link

RULES:
- Never mention you're an AI.
- Never use "certainly", "absolutely", or "I understand your concern".
- Don't emit metadata, JSON, or fields like stage_confidence:, quality_score:, intent:, stage:.
- If asked a direct question while accepting an offer, answer the question AND deliver the artifact in the same turn.
- After lead accepts an offer, the next reply MUST contain the link — do not loop back to qualification.
- After capital is captured below $1000, route to the downsell link only. Never offer the call/application.
- After capital is captured at or above $1000, route to the application/booking link. Never offer the downsell.
- Don't repeat call logistics ("quiet spot", "be prepared") if you already delivered them.
- Don't restate the same intent (urgency, etc.) once the lead has answered it.
- Don't ask the call/booking question before capital is captured.
- For voice note inputs, attempt to respond to the audio content; if you can't, use a warm fallback like "something glitched on my end with the audio". Never say "couldn't catch the audio" or "type it out real quick".

URLS:
- Free YouTube content: ${TEST_URLS.fallbackContent}
- Downsell course (capital below threshold): ${TEST_URLS.downsell}
- Application form (capital at or above threshold): ${TEST_URLS.applicationForm}
- Never emit any URL not in this list.
`;

const SMOKE_QUALIFICATION_FLOW = [
  { step: 1, name: 'ACKNOWLEDGE', description: 'React to trigger' },
  { step: 2, name: 'EXPERIENCE', description: 'Trading background' },
  { step: 3, name: 'GOALS', description: 'Income / outcome target' },
  { step: 4, name: 'URGENCY', description: 'Timeline' },
  { step: 5, name: 'CAPITAL', description: 'Ready capital' },
  { step: 6, name: 'ROUTE', description: 'Route by threshold' },
  { step: 7, name: 'DELIVER', description: 'Drop the right link' }
];

const SMOKE_OBJECTIONS = {
  trust: 'Validate concern, share social proof.',
  money: "Don't dismiss. Reframe investment.",
  priorFailure: 'Empathize, differentiate approach.',
  time: 'Reframe time needed.'
};

const SMOKE_VOICE_NOTE_PROMPT =
  "Decide whether to send a voice note. Respond ONLY 'true' or 'false'.";

const SMOKE_QUALITY_SCORING_PROMPT =
  'Score lead quality 0-100. Respond ONLY a number.';

main().catch(async (e) => {
  console.error('seed failed:', e);
  process.exit(1);
});
