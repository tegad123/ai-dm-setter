/**
 * Four-part check for the multi-bubble issue on daetradez.
 *
 * Check 1 — confirm persona.promptConfig.multiBubbleEnabled is true.
 * Check 2 — confirm IntegrationCredential.credentials.model +
 *           list every OpenAI model id containing "5".
 * Check 3 — pull last 10 AISuggestions, show messageBubbles +
 *           bubbleCount + modelUsed + qualityGateScore.
 * Check 4 — detect markdown formatting in any of the recent
 *           responseText payloads (so we see whether the new
 *           voice-gate rule would now catch them).
 *
 * Run: npx tsx scripts/diag-daetradez-bubble-state.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';
import OpenAI from 'openai';

async function main() {
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { slug: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'daetradez', mode: 'insensitive' } }
      ]
    },
    select: { id: true, slug: true, aiProvider: true }
  });
  if (!account) {
    console.error('daetradez account not found');
    process.exit(1);
  }
  console.log(
    `daetradez: id=${account.id} slug=${account.slug} aiProvider=${account.aiProvider}\n`
  );

  // ── CHECK 1 — persona.multiBubbleEnabled ───────────────────────
  console.log('=== CHECK 1 — persona.promptConfig.multiBubbleEnabled ===');
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: account.id, isActive: true },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      personaName: true,
      updatedAt: true,
      promptConfig: true
    }
  });
  if (!persona) {
    console.log('  No active persona');
  } else {
    const pc = (persona.promptConfig as Record<string, unknown> | null) ?? {};
    const multi = pc.multiBubbleEnabled;
    console.log(
      `  persona=${persona.personaName} (${persona.id}) updatedAt=${persona.updatedAt.toISOString()}`
    );
    console.log(
      `  multiBubbleEnabled = ${String(multi ?? '<unset>')} ${multi === true ? '✓' : '✗'}`
    );
  }

  // ── CHECK 2 — model string + /v1/models list ───────────────────
  console.log('\n=== CHECK 2a — IntegrationCredential stored model ===');
  const creds = await getCredentials(account.id, 'OPENAI');
  const storedModel = (creds?.model as string | undefined) ?? '<unset>';
  console.log(`  stored model: ${storedModel}`);
  console.log(`  apiKey: ${creds?.apiKey ? 'present' : 'missing'}`);

  console.log('\n=== CHECK 2b — /v1/models ids containing "5" ===');
  if (creds?.apiKey) {
    try {
      const client = new OpenAI({ apiKey: creds.apiKey as string });
      const list = await client.models.list();
      const ids = list.data
        .map((m) => m.id)
        .filter((id) => id.includes('5'))
        .sort();
      for (const id of ids) console.log(`  ${id}`);
      console.log(`  (total: ${ids.length})`);
      const likelyCandidates = ids.filter(
        (id) =>
          id.includes('gpt-5') &&
          id.includes('mini') &&
          !id.includes('codex') &&
          !id.includes('search') &&
          !id.includes('audio') &&
          !id.includes('realtime')
      );
      console.log(
        `\n  mini candidates (excluding codex/search/audio/realtime):`
      );
      for (const id of likelyCandidates) console.log(`    ${id}`);
    } catch (e) {
      console.log(`  fetch failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ── CHECK 3 — recent AISuggestions ─────────────────────────────
  console.log('\n=== CHECK 3 — last 10 AISuggestions for daetradez ===');
  const suggestions = await prisma.aISuggestion.findMany({
    where: { accountId: account.id },
    orderBy: { generatedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      generatedAt: true,
      responseText: true,
      messageBubbles: true,
      bubbleCount: true,
      modelUsed: true,
      qualityGateScore: true,
      qualityGateAttempts: true
    }
  });
  const MARKDOWN_RE = /(\*\*[^*]+\*\*|^\s*\d+\.\s+\*\*|(^|\n)\s{0,3}#{1,6}\s)/m;
  for (const s of suggestions) {
    const bubbleArr = s.messageBubbles as unknown;
    const bubbles = Array.isArray(bubbleArr) ? bubbleArr : null;
    const hasMarkdown = MARKDOWN_RE.test(s.responseText);
    console.log(`\n  ${s.generatedAt.toISOString()}  id=${s.id}`);
    console.log(
      `    model=${s.modelUsed ?? '<null>'}  score=${s.qualityGateScore}  attempts=${s.qualityGateAttempts}  bubbleCount=${s.bubbleCount}`
    );
    console.log(
      `    messageBubbles=${bubbles ? `[${bubbles.length}]` : 'null'}   markdown=${hasMarkdown ? 'YES' : 'no'}`
    );
    console.log(
      `    responseText: ${s.responseText.slice(0, 180).replace(/\n/g, ' ⏎ ')}`
    );
    if (bubbles && bubbles.length > 0) {
      for (let i = 0; i < bubbles.length; i++) {
        console.log(`      bubble[${i}]: ${String(bubbles[i]).slice(0, 120)}`);
      }
    }
  }

  // Summary
  const nullBubbles = suggestions.filter(
    (s) => s.messageBubbles === null
  ).length;
  const singleBubble = suggestions.filter((s) => s.bubbleCount === 1).length;
  const markdownHits = suggestions.filter((s) =>
    MARKDOWN_RE.test(s.responseText)
  ).length;
  const gpt54 = suggestions.filter(
    (s) => s.modelUsed === 'gpt-5.4-mini'
  ).length;
  const gpt4o = suggestions.filter((s) => s.modelUsed === 'gpt-4o-mini').length;

  console.log('\n=== Summary over last 10 ===');
  console.log(`  messageBubbles=null: ${nullBubbles}/10`);
  console.log(`  bubbleCount=1: ${singleBubble}/10`);
  console.log(`  contains markdown: ${markdownHits}/10`);
  console.log(`  modelUsed=gpt-5.4-mini: ${gpt54}/10`);
  console.log(`  modelUsed=gpt-4o-mini: ${gpt4o}/10`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
