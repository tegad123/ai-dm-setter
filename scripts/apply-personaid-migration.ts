/**
 * Manual applier for the F4.2 Conversation.personaId migration.
 *
 * Why this exists: Prisma's `migrate deploy` and `db execute` wrap the
 * full migration in a single transaction. The DDL steps (ALTER TABLE
 * ADD COLUMN, ALTER COLUMN SET NOT NULL) acquire AccessExclusive locks
 * on Conversation, which conflict with every concurrent webhook txn.
 * On a busy production table the lock acquisition hangs indefinitely,
 * eventually crossing the build-step timeout.
 *
 * This script breaks the migration into 6 statements run in their own
 * transactions, each with `SET LOCAL lock_timeout = '5s'` so a stuck
 * statement fails fast and is retried. The retry-loop covers up to 60
 * attempts (5min total wall-clock) per step. Idempotent — every step
 * checks the post-condition before doing the work, so safe to re-run.
 *
 * Run: pnpm tsx scripts/apply-personaid-migration.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv();
import prisma from '../src/lib/prisma';

const MIGRATION_NAME = '20260504000000_add_conversation_personaid';

async function step(
  label: string,
  precheck: () => Promise<boolean>,
  apply: () => Promise<void>
): Promise<void> {
  if (await precheck()) {
    console.log(`[skip] ${label} — already applied`);
    return;
  }
  for (let i = 1; i <= 60; i++) {
    try {
      console.log(`[apply ${i}/60] ${label}`);
      await apply();
      console.log(`[ok] ${label}`);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        /lock_timeout|deadlock|canceling statement due to lock timeout/i.test(
          msg
        )
      ) {
        console.log(`  ↳ lock contention — retry in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `[exhausted] ${label} — could not acquire lock after 60 retries`
  );
}

async function columnExists(): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name = 'personaId';
  `;
  return Number(r[0].n) > 0;
}

async function columnIsNotNull(): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ is_nullable: string }>>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name = 'personaId';
  `;
  return r.length > 0 && r[0].is_nullable === 'NO';
}

async function fkExists(): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM pg_constraint
    WHERE conname = 'Conversation_personaId_fkey';
  `;
  return Number(r[0].n) > 0;
}

async function indexExists(): Promise<boolean> {
  const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM pg_indexes
    WHERE tablename = 'Conversation'
      AND indexname = 'Conversation_personaId_idx';
  `;
  return Number(r[0].n) > 0;
}

async function nullCount(): Promise<number> {
  const r = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "Conversation" WHERE "personaId" IS NULL;
  `;
  return Number(r[0].n);
}

async function main() {
  console.log('Starting piecewise migration applier...\n');

  // Step 1: ADD COLUMN nullable
  await step('ADD COLUMN "personaId" TEXT', columnExists, async () => {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`),
      prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '60s'`),
      prisma.$executeRawUnsafe(
        `ALTER TABLE "Conversation" ADD COLUMN "personaId" TEXT`
      )
    ]);
  });

  // Step 2: backfill via temp-table + indexed lookup
  await step(
    'Backfill personaId on existing rows',
    async () => (await nullCount()) === 0,
    async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5min'`),
        prisma.$executeRawUnsafe(`
          CREATE TEMP TABLE _convo_persona_backfill ON COMMIT DROP AS
          SELECT
            l."id" AS lead_id,
            (
              SELECT p."id"
              FROM "AIPersona" p
              WHERE p."accountId" = l."accountId"
              ORDER BY p."isActive" DESC, p."updatedAt" DESC
              LIMIT 1
            ) AS persona_id
          FROM "Lead" l
          WHERE EXISTS (
            SELECT 1 FROM "Conversation" c
            WHERE c."leadId" = l."id" AND c."personaId" IS NULL
          )
        `),
        prisma.$executeRawUnsafe(
          `CREATE INDEX ON _convo_persona_backfill (lead_id)`
        ),
        prisma.$executeRawUnsafe(`
          UPDATE "Conversation" c
          SET "personaId" = b.persona_id
          FROM _convo_persona_backfill b
          WHERE c."leadId" = b.lead_id
            AND c."personaId" IS NULL
            AND b.persona_id IS NOT NULL
        `)
      ]);
    }
  );

  // Verify backfill: every conversation's account must have a persona
  const unowned = await nullCount();
  if (unowned > 0) {
    console.error(
      `\n[FATAL] ${unowned} conversations could not be assigned a personaId. ` +
        `Their account must have at least one AIPersona row. Aborting before SET NOT NULL.`
    );
    const orphans = await prisma.$queryRaw<
      Array<{ accountId: string; n: bigint }>
    >`
      SELECT l."accountId", COUNT(c."id")::bigint AS n
      FROM "Conversation" c JOIN "Lead" l ON l."id" = c."leadId"
      WHERE c."personaId" IS NULL GROUP BY l."accountId";
    `;
    console.error('Affected accounts:', orphans);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log('[ok] All conversations have personaId\n');

  // Step 3: SET NOT NULL
  await step(
    'ALTER COLUMN "personaId" SET NOT NULL',
    columnIsNotNull,
    async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5min'`),
        prisma.$executeRawUnsafe(
          `ALTER TABLE "Conversation" ALTER COLUMN "personaId" SET NOT NULL`
        )
      ]);
    }
  );

  // Step 4: FK constraint
  await step(
    'ADD CONSTRAINT "Conversation_personaId_fkey"',
    fkExists,
    async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5min'`),
        prisma.$executeRawUnsafe(`
          ALTER TABLE "Conversation"
          ADD CONSTRAINT "Conversation_personaId_fkey"
          FOREIGN KEY ("personaId") REFERENCES "AIPersona"("id")
          ON DELETE RESTRICT ON UPDATE CASCADE
        `)
      ]);
    }
  );

  // Step 5: Index
  await step(
    'CREATE INDEX "Conversation_personaId_idx"',
    indexExists,
    async () => {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '5s'`),
        prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '5min'`),
        prisma.$executeRawUnsafe(
          `CREATE INDEX "Conversation_personaId_idx" ON "Conversation"("personaId")`
        )
      ]);
    }
  );

  // Step 6: Mark migration as applied in _prisma_migrations
  const existing = await prisma.$queryRaw<
    Array<{ id: string; finished_at: Date | null }>
  >`
    SELECT id, finished_at FROM "_prisma_migrations"
    WHERE migration_name = ${MIGRATION_NAME};
  `;
  if (existing.length === 0 || existing[0].finished_at === null) {
    console.log(
      `[apply] Marking ${MIGRATION_NAME} as applied in _prisma_migrations`
    );
    if (existing.length === 0) {
      // Insert fresh row
      await prisma.$executeRawUnsafe(`
        INSERT INTO "_prisma_migrations"
        (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES (
          gen_random_uuid()::text,
          'manually-applied-via-script',
          NOW(),
          '${MIGRATION_NAME}',
          'Applied piecewise via scripts/apply-personaid-migration.ts on 2026-05-04 prod-incident recovery',
          NULL,
          NOW(),
          1
        );
      `);
    } else {
      // Update existing failed row
      await prisma.$executeRawUnsafe(`
        UPDATE "_prisma_migrations"
        SET finished_at = NOW(),
            applied_steps_count = 1,
            rolled_back_at = NULL,
            logs = COALESCE(logs, '') || E'\nApplied piecewise via scripts/apply-personaid-migration.ts on 2026-05-04 prod-incident recovery'
        WHERE migration_name = '${MIGRATION_NAME}';
      `);
    }
    console.log('[ok] Migration row marked as applied');
  } else {
    console.log(
      `[skip] Migration row already finished_at=${existing[0].finished_at.toISOString()}`
    );
  }

  // Final verification
  const final = await prisma.$queryRaw<
    Array<{ n: bigint }>
  >`SELECT COUNT(*)::bigint AS n FROM "Conversation" WHERE "personaId" IS NULL;`;
  const totalConvos = await prisma.$queryRaw<
    Array<{ n: bigint }>
  >`SELECT COUNT(*)::bigint AS n FROM "Conversation";`;
  console.log(`\n=== FINAL ===`);
  console.log(`Total Conversation rows: ${Number(totalConvos[0].n)}`);
  console.log(`NULL personaId: ${Number(final[0].n)}`);
  console.log(`Column non-null: ${await columnIsNotNull()}`);
  console.log(`FK constraint: ${await fkExists()}`);
  console.log(`Index: ${await indexExists()}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
