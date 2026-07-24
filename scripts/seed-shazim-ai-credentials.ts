/**
 * One-off dev seed: per-account Anthropic API key + model for the local
 * "shazim's Workspace" account, plus flipping Account.aiProvider to
 * 'anthropic' so resolveAIProvider() routes generation through it.
 *
 * Why this exists:
 *   ai-engine.resolveAIProvider() reads the API key + model from
 *   IntegrationCredential (provider=ANTHROPIC) first, with the env
 *   var (ANTHROPIC_API_KEY) + the SONNET_46_MODEL hardcoded fallback
 *   as a last-resort. The hardcoded fallback is currently the
 *   deprecated alias 'claude-sonnet-4-20250514' which Anthropic
 *   returns 404 on. Setting the model in the DB per-account bypasses
 *   the broken fallback without scattering code changes.
 *
 * Run: bun tsx scripts/seed-shazim-ai-credentials.ts
 *
 * Idempotent — setCredentials() uses merge upsert semantics. Safe to
 * re-run; existing credentials are preserved and only the provided
 * fields are overwritten.
 */

import { setCredentials } from '../src/lib/credential-store';
import prisma from '../src/lib/prisma';

const TARGET_ACCOUNT_ID = 'cmpa60h9c0000gs4l85idlaby'; // shazim's Workspace
// Haiku 4.5 — cheapest current Anthropic model (~$0.80/MTok input,
// ~$4/MTok output). Tega's preference for the local dev account to
// minimize per-message cost. Trade-off: Haiku is less nuanced than
// Sonnet 4.6 on complex objection handling and stage progression —
// re-evaluate after Days 4-5 reliability work. Flipping back to
// Sonnet ('claude-sonnet-4-6') is one constant + re-run-seed change.
const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

async function main() {
  // ── Sanity checks ──────────────────────────────────────────────
  const account = await prisma.account.findUnique({
    where: { id: TARGET_ACCOUNT_ID },
    select: { id: true, name: true, slug: true, aiProvider: true }
  });
  if (!account) {
    console.error(
      `[seed-ai] Account ${TARGET_ACCOUNT_ID} not found. Run prisma seed first.`
    );
    process.exit(1);
  }
  console.log(
    `[seed-ai] target account: ${account.name} (${account.slug}) — aiProvider=${account.aiProvider}`
  );

  const required = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CREDENTIAL_ENCRYPTION_KEY: process.env.CREDENTIAL_ENCRYPTION_KEY
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(`[seed-ai] missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // ── 1. ANTHROPIC credential ────────────────────────────────────
  await setCredentials(
    TARGET_ACCOUNT_ID,
    'ANTHROPIC',
    {
      apiKey: required.ANTHROPIC_API_KEY!,
      model: ANTHROPIC_MODEL
    },
    {
      seededFromEnv: true,
      seededAt: new Date().toISOString()
    }
  );
  console.log(
    `[seed-ai] ANTHROPIC credential set — model=${ANTHROPIC_MODEL} (apiKey encrypted, length=${required.ANTHROPIC_API_KEY!.length})`
  );

  // ── 2. Route account to Anthropic ──────────────────────────────
  if (account.aiProvider !== 'anthropic') {
    await prisma.account.update({
      where: { id: TARGET_ACCOUNT_ID },
      data: { aiProvider: 'anthropic' }
    });
    console.log(
      `[seed-ai] flipped Account.aiProvider: '${account.aiProvider}' → 'anthropic'`
    );
  } else {
    console.log(`[seed-ai] Account.aiProvider already 'anthropic'`);
  }

  // ── 3. Verify ──────────────────────────────────────────────────
  const cred = await prisma.integrationCredential.findFirst({
    where: { accountId: TARGET_ACCOUNT_ID, provider: 'ANTHROPIC' },
    select: {
      id: true,
      isActive: true,
      credentials: true,
      metadata: true
    }
  });
  if (!cred) {
    console.error('[seed-ai] verification failed: no ANTHROPIC credential row');
    process.exit(1);
  }
  const c = cred.credentials as Record<string, unknown> | null;
  const hasEncryptedApiKey =
    typeof c?.apiKey === 'string' && (c.apiKey as string).includes(':');
  console.log(
    `[seed-ai] verified — credential id=${cred.id} active=${cred.isActive} encryptedApiKey=${hasEncryptedApiKey} model=${c?.model}`
  );

  await prisma.$disconnect();
  console.log('[seed-ai] done.');
}

main().catch((err) => {
  console.error('[seed-ai] failed:', err);
  process.exit(1);
});
