/**
 * End-to-end test of the gpt-5.4-mini main-generation path.
 *
 * Spins up a disposable Account with aiProvider='openai' + a stored
 * OpenAI credential (re-using daetradez's key via per-account creds is
 * gnarly — this test uses an env key). Runs generateReply, asserts:
 *
 *   TEST 1 — Call returns parseable JSON with `stage` set.
 *   TEST 2 — modelUsed = "gpt-5.4-mini", input/output tokens logged.
 *   TEST 3 — parseAIResponse handles gpt-5.4-mini output (17 fields).
 *   TEST 4 — Second call may populate cacheReadTokens (automatic
 *            OpenAI caching kicks in on prompts >1024 tokens).
 *
 * The test pulls daetradez's stored OpenAI key and injects it as
 * OPENAI_API_KEY so generateReply's env-fallback path uses it. This
 * avoids having to seed encrypted IntegrationCredential rows per-test.
 *
 * Run: npx tsx scripts/test-gpt5-4-mini-generation.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';
import { generateReply } from '../src/lib/ai-engine';
import type { LeadContext } from '../src/lib/ai-prompts';

let pass = 0;
let fail = 0;
const fails: string[] = [];

function assert(cond: unknown, label: string, detail?: string) {
  if (cond) {
    console.log(`✓ ${label}`);
    pass++;
  } else {
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
    fails.push(label);
    fail++;
  }
}

async function withTestAccount<T>(
  run: (ctx: {
    accountId: string;
    leadId: string;
    conversationId: string;
  }) => Promise<T>
): Promise<T> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const account = await prisma.account.create({
    data: {
      name: `gpt54-test-${suffix}`,
      slug: `gpt54-test-${suffix}`,
      aiProvider: 'openai'
    }
  });
  await prisma.aIPersona.create({
    data: {
      accountId: account.id,
      personaName: 'Test',
      fullName: 'Test Owner',
      systemPrompt: 'You are a test persona.'
    }
  });
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: `Lead ${suffix}`,
      handle: `lead_${suffix}`,
      platform: 'FACEBOOK',
      platformUserId: `psid_${suffix}`,
      triggerType: 'DM',
      stage: 'NEW_LEAD'
    }
  });
  const conversation = await prisma.conversation.create({
    data: { leadId: lead.id, aiActive: true }
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: 'LEAD',
      content: "yo, saw your post about trading. what's the vibe?",
      timestamp: new Date()
    }
  });
  try {
    return await run({
      accountId: account.id,
      leadId: lead.id,
      conversationId: conversation.id
    });
  } finally {
    await prisma.aISuggestion
      .deleteMany({ where: { conversationId: conversation.id } })
      .catch(() => {});
    await prisma.message
      .deleteMany({ where: { conversationId: conversation.id } })
      .catch(() => {});
    await prisma.conversation
      .delete({ where: { id: conversation.id } })
      .catch(() => {});
    await prisma.leadStageTransition
      .deleteMany({ where: { leadId: lead.id } })
      .catch(() => {});
    await prisma.lead.delete({ where: { id: lead.id } }).catch(() => {});
    await prisma.aIPersona
      .deleteMany({ where: { accountId: account.id } })
      .catch(() => {});
    await prisma.account.delete({ where: { id: account.id } }).catch(() => {});
  }
}

async function buildHistory(conversationId: string) {
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { timestamp: 'asc' }
  });
  return msgs.map((m) => ({
    id: m.id,
    role: m.sender === 'LEAD' ? ('user' as const) : ('assistant' as const),
    content: m.content,
    sender: m.sender,
    timestamp: m.timestamp.toISOString()
  }));
}

function makeLeadContext(leadName: string): LeadContext {
  return {
    leadName,
    handle: 'testhandle',
    platform: 'FACEBOOK',
    status: 'NEW_LEAD',
    triggerType: 'DM',
    triggerSource: null,
    qualityScore: 0,
    tags: [],
    source: undefined,
    experience: undefined,
    incomeLevel: undefined,
    geography: undefined,
    timezone: undefined
  };
}

async function main() {
  // Seed env OPENAI_API_KEY from daetradez's stored credential so
  // generateReply's env-fallback path has a key to use.
  const daetradez = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true }
  });
  if (daetradez) {
    const creds = await getCredentials(daetradez.id, 'OPENAI');
    if (creds?.apiKey) {
      process.env.OPENAI_API_KEY = creds.apiKey as string;
      // Local .env pins AI_PROVIDER=anthropic which hijacks accounts
      // without stored creds onto Anthropic. Force the env-fallback
      // branch to OpenAI for this test so it mirrors daetradez's
      // production path (aiProvider='openai' + stored cred).
      process.env.AI_PROVIDER = 'openai';
      delete process.env.AI_MODEL;
      console.log('(using daetradez-stored OpenAI key via env injection)');
    } else {
      console.error(
        'No stored OpenAI credential for daetradez — test cannot hit API.'
      );
      process.exit(3);
    }
  }

  try {
    await withTestAccount(async ({ accountId, conversationId }) => {
      const leadCtx = makeLeadContext(`Lead-${accountId.slice(-4)}`);

      const history1 = await buildHistory(conversationId);
      const r1 = await generateReply(
        accountId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        history1 as any,
        leadCtx
      );
      assert(
        typeof r1.reply === 'string' && r1.reply.length > 0,
        'TEST 1 — first call returns non-empty reply'
      );
      assert(
        typeof r1.stage === 'string' && r1.stage.length > 0,
        'TEST 1b — stage populated',
        `stage="${r1.stage}"`
      );

      const s1 = await prisma.aISuggestion.findFirst({
        where: { conversationId },
        orderBy: { generatedAt: 'desc' }
      });
      assert(
        s1?.modelUsed === 'gpt-5.4-mini',
        'TEST 2a — modelUsed = gpt-5.4-mini',
        `modelUsed="${s1?.modelUsed}"`
      );
      assert(
        (s1?.inputTokens ?? 0) > 0 && (s1?.outputTokens ?? 0) > 0,
        'TEST 2b — inputTokens + outputTokens > 0',
        `in=${s1?.inputTokens} out=${s1?.outputTokens}`
      );
      console.log(
        `  usage: in=${s1?.inputTokens} out=${s1?.outputTokens} cached=${s1?.cacheReadTokens}`
      );

      // TEST 3: parseAIResponse handled the output. We can probe this
      // indirectly by checking that the 17-field schema was populated
      // beyond just `reply` + `stage` — a plain-text reply would cause
      // parseAIResponse to fall through to defaults.
      assert(
        typeof r1.stageConfidence === 'number',
        'TEST 3a — stageConfidence populated (JSON shape intact)'
      );
      assert(
        typeof r1.sentimentScore === 'number',
        'TEST 3b — sentimentScore populated'
      );
      assert(
        r1.escalateToHuman === false || r1.escalateToHuman === true,
        'TEST 3c — escalateToHuman boolean populated'
      );

      // TEST 4: Cache hit on turn 2. OpenAI auto-caches prompts >1024
      // tokens but only starts returning cached_tokens after a few
      // seconds. Not all 2nd calls will hit — so this is best-effort.
      await prisma.message.create({
        data: {
          conversationId,
          sender: 'AI',
          content: r1.reply,
          timestamp: new Date()
        }
      });
      await prisma.message.create({
        data: {
          conversationId,
          sender: 'LEAD',
          content: 'cool. what do you trade?',
          timestamp: new Date(Date.now() + 1000)
        }
      });
      const history2 = await buildHistory(conversationId);
      const r2 = await generateReply(
        accountId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        history2 as any,
        leadCtx
      );
      assert(!!r2.reply, 'TEST 4a — second call returns reply');
      const s2 = await prisma.aISuggestion.findFirst({
        where: { conversationId },
        orderBy: { generatedAt: 'desc' }
      });
      console.log(
        `  turn 2 usage: in=${s2?.inputTokens} out=${s2?.outputTokens} cached=${s2?.cacheReadTokens}`
      );
      // Best-effort: note caching without hard-asserting (OpenAI caching
      // is probabilistic on short convos).
      if ((s2?.cacheReadTokens ?? 0) > 0) {
        console.log('  (cache hit detected on turn 2 ✓)');
      } else {
        console.log(
          '  (no cache hit on turn 2 — not a failure, expected for short prompts)'
        );
      }
    });
  } finally {
    console.log(`\nResults: ${pass} passed, ${fail} failed.`);
    if (fails.length > 0) {
      console.log('FAILS:');
      fails.forEach((f) => console.log('  - ' + f));
    }
    await prisma.$disconnect().catch(() => {});
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('TEST RUNNER CRASHED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
