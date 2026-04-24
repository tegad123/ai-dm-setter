/**
 * Flip daetradez's pinned OpenAI model from gpt-4o-mini to gpt-5.4-mini.
 *
 * The IntegrationCredential.credentials JSON blob carries `model` as a
 * plaintext field alongside the encrypted `apiKey`. setCredentials()
 * merges (encryption only touches apiKey/accessToken/refreshToken), so
 * passing just `{ model }` updates the single field without disturbing
 * the stored key.
 *
 * Also scans every other account's OpenAI credential to report any
 * pinned model values that would override the OPENAI_DEFAULT_MODEL
 * constant at ai-engine.ts.
 *
 * Run: npx tsx scripts/flip-daetradez-gpt54-mini.ts
 */
import { config as loadEnv } from 'dotenv';
loadEnv({ override: true });
import prisma from '../src/lib/prisma';
import { getCredentials, setCredentials } from '../src/lib/credential-store';

const TARGET_MODEL = 'gpt-5.4-mini';
const OLD_MODEL = 'gpt-4o-mini';

async function main() {
  // ── 1. Find daetradez ─────────────────────────────────────────
  const daetradez = await prisma.account.findFirst({
    where: {
      OR: [
        { slug: { contains: 'daetradez', mode: 'insensitive' } },
        { name: { contains: 'daetradez', mode: 'insensitive' } }
      ]
    },
    select: { id: true, slug: true, name: true }
  });
  if (!daetradez) {
    console.error('daetradez account not found');
    process.exit(1);
  }

  const before = await getCredentials(daetradez.id, 'OPENAI');
  console.log(
    `daetradez (${daetradez.slug}): OpenAI creds — apiKey=${before?.apiKey ? 'present' : 'missing'}, stored model=${before?.model ?? '<none>'}`
  );
  if (!before?.apiKey) {
    console.error('No OpenAI apiKey stored — cannot flip. Aborting.');
    process.exit(2);
  }

  if (before.model === TARGET_MODEL) {
    console.log(`Already on ${TARGET_MODEL} — no change.`);
  } else {
    await setCredentials(daetradez.id, 'OPENAI', { model: TARGET_MODEL });
    const after = await getCredentials(daetradez.id, 'OPENAI');
    console.log(
      `✓ Flipped: ${before.model ?? '<none>'} → ${after?.model ?? '<read back failed>'}`
    );
    console.log(
      `  apiKey persisted: ${after?.apiKey === before.apiKey ? 'yes (unchanged)' : 'WARNING: apiKey changed!'}`
    );
  }

  // ── 2. Audit every other OpenAI credential for pinned models ──
  console.log('\n=== Audit: all accounts with OpenAI credentials ===');
  const allOpenAI = await prisma.integrationCredential.findMany({
    where: { provider: 'OPENAI', isActive: true },
    select: { accountId: true }
  });
  const rows: Array<{
    slug: string;
    name: string;
    model: string | null;
    flagged: boolean;
  }> = [];
  for (const c of allOpenAI) {
    const [acct, creds] = await Promise.all([
      prisma.account.findUnique({
        where: { id: c.accountId },
        select: { slug: true, name: true, aiProvider: true }
      }),
      getCredentials(c.accountId, 'OPENAI')
    ]);
    if (!acct) continue;
    const rawModel =
      creds && typeof creds.model === 'string' ? (creds.model as string) : '';
    const model = rawModel.length > 0 ? rawModel : null;
    // A pin is "flagged" if it exists AND it's NOT already the new target.
    // Accounts on aiProvider='anthropic' don't use OpenAI for main gen,
    // so a pinned model there is mostly irrelevant — call it out but
    // don't gate on it.
    const flagged =
      model !== null && model !== TARGET_MODEL && acct.aiProvider === 'openai';
    rows.push({
      slug: acct.slug,
      name: acct.name,
      model,
      flagged
    });
  }
  rows.sort((a, b) => Number(b.flagged) - Number(a.flagged));
  for (const r of rows) {
    const mark = r.flagged ? '⚠ ' : '  ';
    console.log(
      `${mark}${r.slug.padEnd(28)} model=${(r.model ?? '<default>').padEnd(18)} ${r.flagged ? `(pinned to ${r.model}, not ${TARGET_MODEL})` : ''}`
    );
  }
  const flagged = rows.filter((r) => r.flagged);
  console.log(
    `\nAccounts with stale pinned model (aiProvider=openai, not ${TARGET_MODEL}): ${flagged.length}`
  );
  if (flagged.length > 0) {
    console.log(
      `Stale: ${flagged.map((r) => `${r.slug}=${r.model}`).join(', ')}`
    );
  }
  if (rows.filter((r) => r.model === OLD_MODEL).length > 0) {
    console.log(
      `Accounts still pinned to ${OLD_MODEL}: ${rows
        .filter((r) => r.model === OLD_MODEL)
        .map((r) => r.slug)
        .join(', ')}`
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(3);
});
