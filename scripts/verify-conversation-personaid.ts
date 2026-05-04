// Audit F4.2 verification — confirms every Conversation has a personaId
// resolvable to an AIPersona within the same Account.
//
// Run after the 20260504000000_add_conversation_personaid migration applies
// in any environment. Exits 0 on success, 1 on any integrity violation.
//
//   pnpm tsx scripts/verify-conversation-personaid.ts
//
// Re-run as part of the quarterly audit kit (Appendix C of
// audit/2026-05-03-multi-tenant-leak-audit.md).

import prisma from '@/lib/prisma';

interface IntegrityResult {
  totalConversations: number;
  nullPersonaId: number;
  crossAccountMismatch: number;
  multiPersonaAccounts: number;
}

async function check(): Promise<IntegrityResult> {
  const totalConversations = await prisma.conversation.count();

  // 1. Zero NULL personaId — schema enforces NOT NULL post-migration, but
  // the count below proves the constraint is actually live in this DB.
  const [{ count: nullCount }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count
    FROM "Conversation"
    WHERE "personaId" IS NULL
  `;

  // 2. Conversation.persona must belong to the same Account as
  // Conversation.lead. A mismatch means a backfill or live insert
  // assigned a persona from a different tenant — the precise bug the
  // audit was chartered to prevent.
  const [{ count: mismatchCount }] = await prisma.$queryRaw<
    { count: bigint }[]
  >`
    SELECT COUNT(*)::bigint AS count
    FROM "Conversation" c
    JOIN "Lead" l ON l."id" = c."leadId"
    JOIN "AIPersona" p ON p."id" = c."personaId"
    WHERE l."accountId" <> p."accountId"
  `;

  // 3. Diagnostic only — count accounts that already operate with
  // multiple personas. These are the accounts whose remediation matters
  // most; the count should grow as multi-persona becomes a sold feature.
  const [{ count: multiPersonaCount }] = await prisma.$queryRaw<
    { count: bigint }[]
  >`
    SELECT COUNT(*)::bigint AS count
    FROM (
      SELECT "accountId"
      FROM "AIPersona"
      GROUP BY "accountId"
      HAVING COUNT(*) >= 2
    ) sub
  `;

  return {
    totalConversations,
    nullPersonaId: Number(nullCount),
    crossAccountMismatch: Number(mismatchCount),
    multiPersonaAccounts: Number(multiPersonaCount)
  };
}

async function main() {
  console.log('[verify-conversation-personaid] Starting integrity check');
  const result = await check();

  console.log(
    `[verify-conversation-personaid] Conversations:      ${result.totalConversations}`
  );
  console.log(
    `[verify-conversation-personaid] NULL personaId:     ${result.nullPersonaId}`
  );
  console.log(
    `[verify-conversation-personaid] Cross-account FK:   ${result.crossAccountMismatch}`
  );
  console.log(
    `[verify-conversation-personaid] Multi-persona accts:${result.multiPersonaAccounts} (informational)`
  );

  const failed = result.nullPersonaId > 0 || result.crossAccountMismatch > 0;
  if (failed) {
    console.error('[verify-conversation-personaid] FAIL — integrity violated');
    process.exit(1);
  }

  console.log('[verify-conversation-personaid] PASS');
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[verify-conversation-personaid] ERROR:', err);
  await prisma.$disconnect();
  process.exit(1);
});
