/**
 * Two-phase probe before swapping back to OpenAI gpt-5-mini:
 *
 *   PHASE 1 — List every OpenAI model ID containing "5", sorted.
 *             Human-verifies the exact string.
 *   PHASE 2 — For each likely gpt-5-mini candidate, make a minimal
 *             chat.completions call with the exact params the main
 *             generation path uses (temperature 0.85, max_tokens 1500,
 *             response_format: json_object). Report acceptance +
 *             prompt_tokens_details.cached_tokens availability.
 *
 * Run: npx tsx scripts/probe-gpt5-mini.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import OpenAI from 'openai';

const CANDIDATES_HINT = [
  'gpt-5-mini',
  'gpt-5.1-mini',
  'gpt-5.2-mini',
  'gpt-5.3-mini',
  'gpt-5.4-mini',
  'gpt-5-mini-latest'
];

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set in .env');
    process.exit(2);
  }
  const client = new OpenAI({ apiKey });

  // ── PHASE 1 — list models ──
  console.log('── PHASE 1: model IDs containing "5" ──');
  const list = await client.models.list();
  const ids = list.data
    .map((m) => m.id)
    .filter((id) => id.includes('5'))
    .sort();
  for (const id of ids) console.log(`  ${id}`);
  console.log(`\nTotal with "5": ${ids.length}`);

  // Pick candidate set: anything matching "gpt-5" + "mini" in the list,
  // plus the hint list so we flag obvious misses.
  const listedMiniCandidates = ids.filter(
    (id) => id.includes('gpt-5') && id.includes('mini')
  );
  const probeSet = Array.from(
    new Set([...listedMiniCandidates, ...CANDIDATES_HINT])
  );
  console.log(`\nCandidates to probe: ${probeSet.join(', ')}`);

  // ── PHASE 2 — JSON compatibility probe for each candidate ──
  console.log('\n── PHASE 2: chat.completions JSON compatibility ──');
  for (const model of probeSet) {
    console.log(`\n[${model}]`);
    try {
      const res = await client.chat.completions.create({
        model,
        temperature: 0.85,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Return only valid JSON: {"test": true, "stage": "OPENING"}'
          },
          { role: 'user', content: 'ping' }
        ]
      });
      const content = res.choices[0]?.message?.content ?? '';
      let parses = false;
      try {
        JSON.parse(content);
        parses = true;
      } catch {
        parses = false;
      }
      console.log(`  ✓ accepted`);
      console.log(`    response: ${content.slice(0, 100)}`);
      console.log(`    parses: ${parses}`);
      console.log(
        `    usage: prompt=${res.usage?.prompt_tokens} completion=${res.usage?.completion_tokens}`
      );
      const u = res.usage as {
        prompt_tokens_details?: { cached_tokens?: number };
      };
      const cached = u?.prompt_tokens_details?.cached_tokens;
      console.log(
        `    cached_tokens: ${cached === undefined ? 'field not returned' : cached}`
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${msg.slice(0, 300)}`);
    }
  }
}

main().catch((e) => {
  console.error('PROBE CRASHED:', e);
  process.exit(3);
});
