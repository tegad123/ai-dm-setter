/**
 * One-shot probe to confirm the Sonnet 4.6 model string works against
 * the account's Anthropic credentials. Tries the date-stamped variant
 * first, then the alias. Prints which works.
 *
 * Run: npx tsx scripts/probe-sonnet-46.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import Anthropic from '@anthropic-ai/sdk';

const CANDIDATES = ['claude-sonnet-4-6-20260217', 'claude-sonnet-4-6'];

async function probe(apiKey: string, model: string) {
  const client = new Anthropic({ apiKey });
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 20,
      messages: [{ role: 'user', content: 'reply with a single word: ok' }]
    });
    const text =
      res.content[0]?.type === 'text' ? res.content[0].text.trim() : '';
    console.log(`✓ ${model} — accepted. reply="${text}"`);
    console.log(
      `  usage: input=${res.usage.input_tokens} output=${res.usage.output_tokens}`
    );
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`✗ ${model} — ${msg.slice(0, 200)}`);
    return false;
  }
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set in .env');
    process.exit(2);
  }
  for (const model of CANDIDATES) {
    const ok = await probe(apiKey, model);
    if (ok) {
      console.log(`\n→ USE: "${model}"`);
      process.exit(0);
    }
  }
  console.error('\nNo candidate accepted. Check available models.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
