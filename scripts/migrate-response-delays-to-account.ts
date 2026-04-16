/**
 * One-time migration: copy responseDelayMin/Max from each account's
 * active persona (or most recent if none active) onto the Account model.
 *
 * Safe to run multiple times — only writes when account still has the
 * default values (300/600).
 *
 * Usage: npx tsx scripts/migrate-response-delays-to-account.ts
 */

import prisma from '../src/lib/prisma';

async function main() {
  console.log('[migrate-response-delays] Starting...');

  const accounts = await prisma.account.findMany({
    select: {
      id: true,
      name: true,
      responseDelayMin: true,
      responseDelayMax: true
    }
  });

  console.log(`[migrate-response-delays] Found ${accounts.length} accounts`);

  let migrated = 0;
  let skipped = 0;

  for (const account of accounts) {
    // Skip if account already has non-default values
    if (account.responseDelayMin !== 300 || account.responseDelayMax !== 600) {
      console.log(
        `  [SKIP] ${account.name || account.id}: already has custom values (${account.responseDelayMin}/${account.responseDelayMax})`
      );
      skipped++;
      continue;
    }

    // Find the active persona first, fall back to most recent
    const persona =
      (await prisma.aIPersona.findFirst({
        where: { accountId: account.id, isActive: true },
        select: { responseDelayMin: true, responseDelayMax: true }
      })) ??
      (await prisma.aIPersona.findFirst({
        where: { accountId: account.id },
        orderBy: { updatedAt: 'desc' },
        select: { responseDelayMin: true, responseDelayMax: true }
      }));

    if (!persona) {
      console.log(
        `  [SKIP] ${account.name || account.id}: no persona found, keeping defaults`
      );
      skipped++;
      continue;
    }

    await prisma.account.update({
      where: { id: account.id },
      data: {
        responseDelayMin: persona.responseDelayMin,
        responseDelayMax: persona.responseDelayMax
      }
    });
    console.log(
      `  [MIGRATED] ${account.name || account.id}: ${persona.responseDelayMin}/${persona.responseDelayMax}`
    );
    migrated++;
  }

  console.log(
    `\n[migrate-response-delays] Done: ${migrated} migrated, ${skipped} skipped`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[migrate-response-delays] Error:', err);
  process.exit(1);
});
