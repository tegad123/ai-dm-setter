/**
 * Before the Sonnet→gpt-5-mini swap, verify that daetradez actually has
 * a usable OpenAI credential stored. If they do, use it to list models
 * (phase 1) and probe gpt-5-mini candidates (phase 2). If they don't,
 * stop — the swap would break production until a key is added.
 *
 * Run: npx tsx scripts/probe-daetradez-openai-cred.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';
import OpenAI from 'openai';

const CANDIDATES_HINT = ['gpt-5.4-mini', 'gpt-5-mini'];

// GPT-5 family rejects some GPT-4 parameters. This sweep establishes
// which params are usable before we commit to a code path.
interface ParamSet {
  label: string;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  response_format?: { type: 'json_object' };
}
const PARAM_SWEEPS: ParamSet[] = [
  {
    label: 'GPT-4 style (max_tokens, temp=0.85, response_format)',
    temperature: 0.85,
    max_tokens: 1500,
    response_format: { type: 'json_object' }
  },
  {
    label: 'GPT-5 style (max_completion_tokens, temp=0.85, response_format)',
    temperature: 0.85,
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' }
  },
  {
    label: 'GPT-5 style (max_completion_tokens, temp=1.0, response_format)',
    temperature: 1.0,
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' }
  },
  {
    label: 'GPT-5 style (max_completion_tokens, no temp, response_format)',
    max_completion_tokens: 1500,
    response_format: { type: 'json_object' }
  }
];

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
    `Account: ${account.slug} id=${account.id} aiProvider=${account.aiProvider}`
  );

  const creds = await getCredentials(account.id, 'OPENAI');
  if (!creds?.apiKey) {
    console.error(
      '\n✗ NO OpenAI credential stored for daetradez. Swap would break prod.'
    );
    console.error(
      '  Next steps: add an OpenAI key via Settings → Integrations, OR'
    );
    console.error(
      '  add OPENAI_API_KEY to .env for env-fallback, then re-run this probe.'
    );
    await prisma.$disconnect();
    process.exit(2);
  }
  const apiKey = creds.apiKey as string;
  console.log(`✓ OpenAI credential present (len=${apiKey.length})`);
  console.log(`  stored model: ${creds.model ?? '(none — uses default)'}`);

  const client = new OpenAI({ apiKey });

  console.log('\n── PHASE 1: model IDs containing "5" (sorted) ──');
  const list = await client.models.list();
  const ids = list.data
    .map((m) => m.id)
    .filter((id) => id.includes('5'))
    .sort();
  for (const id of ids) console.log(`  ${id}`);
  console.log(`\nTotal with "5": ${ids.length}`);

  const listedMiniCandidates = ids.filter(
    (id) => id.includes('gpt-5') && id.includes('mini')
  );
  const probeSet = Array.from(
    new Set([...listedMiniCandidates, ...CANDIDATES_HINT])
  );
  console.log(`\nCandidates to probe: ${probeSet.join(', ')}`);

  console.log('\n── PHASE 2: chat.completions param sweep per candidate ──');
  for (const model of probeSet) {
    console.log(`\n====== [${model}] ======`);
    for (const sweep of PARAM_SWEEPS) {
      console.log(`  trying: ${sweep.label}`);
      try {
        const params = {
          model,
          messages: [
            {
              role: 'system' as const,
              content:
                'Return only valid JSON: {"test": true, "stage": "OPENING"}'
            },
            { role: 'user' as const, content: 'ping' }
          ],
          ...(sweep.temperature !== undefined && {
            temperature: sweep.temperature
          }),
          ...(sweep.max_tokens !== undefined && {
            max_tokens: sweep.max_tokens
          }),
          ...(sweep.max_completion_tokens !== undefined && {
            max_completion_tokens: sweep.max_completion_tokens
          }),
          ...(sweep.response_format && {
            response_format: sweep.response_format
          })
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await client.chat.completions.create(params as any);
        const content = res.choices[0]?.message?.content ?? '';
        let parses = false;
        try {
          JSON.parse(content);
          parses = true;
        } catch {
          parses = false;
        }
        console.log(`    ✓ accepted. parses=${parses}`);
        console.log(`      response: ${content.slice(0, 80)}`);
        console.log(
          `      usage: prompt=${res.usage?.prompt_tokens} completion=${res.usage?.completion_tokens}`
        );
        const u = res.usage as {
          prompt_tokens_details?: { cached_tokens?: number };
        };
        const cached = u?.prompt_tokens_details?.cached_tokens;
        console.log(
          `      cached_tokens: ${cached === undefined ? 'N/A' : cached}`
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`    ✗ ${msg.slice(0, 200)}`);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('PROBE CRASHED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(3);
});
