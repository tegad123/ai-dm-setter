/**
 * Verify gpt-4o-mini (the Anthropic-path fallback model) still accepts
 * max_completion_tokens after the callOpenAI refactor. Without this
 * test, switching max_tokens→max_completion_tokens could silently break
 * the fallback branch.
 *
 * Run: npx tsx scripts/probe-gpt4o-mini-compat.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { getCredentials } from '../src/lib/credential-store';
import OpenAI from 'openai';

async function main() {
  const daetradez = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true }
  });
  if (!daetradez) {
    console.error('daetradez not found');
    process.exit(1);
  }
  const creds = await getCredentials(daetradez.id, 'OPENAI');
  const apiKey = creds?.apiKey as string;
  const client = new OpenAI({ apiKey });

  console.log('[gpt-4o-mini + max_completion_tokens + temp=0.85]');
  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.85,
      max_completion_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON: {"ok": true}' },
        { role: 'user', content: 'ping' }
      ]
    });
    console.log(`  ✓ accepted`);
    console.log(`  response: ${res.choices[0]?.message?.content}`);
    console.log(
      `  usage: prompt=${res.usage?.prompt_tokens} completion=${res.usage?.completion_tokens}`
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${msg}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
