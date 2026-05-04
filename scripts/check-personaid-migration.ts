import { config as loadEnv } from 'dotenv';
loadEnv();
import prisma from '../src/lib/prisma';

async function main() {
  const cols = await prisma.$queryRaw<
    Array<{ column_name: string; is_nullable: string; data_type: string }>
  >`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_name = 'Conversation' AND column_name = 'personaId';
  `;
  console.log('Conversation.personaId column:', cols);

  const nullCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "Conversation" WHERE "personaId" IS NULL;
  `;
  console.log('NULL personaId count:', Number(nullCount[0].count));

  const totalCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "Conversation";
  `;
  console.log('Total Conversation count:', Number(totalCount[0].count));

  const fks = await prisma.$queryRaw<
    Array<{ constraint_name: string; foreign_table: string }>
  >`
    SELECT conname AS constraint_name,
           confrelid::regclass::text AS foreign_table
    FROM pg_constraint
    WHERE conrelid = '"Conversation"'::regclass AND contype = 'f';
  `;
  console.log('Conversation FK constraints:', fks);

  const idx = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'Conversation' AND indexname = 'Conversation_personaId_idx';
  `;
  console.log('personaId index:', idx);

  const migration = await prisma.$queryRaw<
    Array<{
      migration_name: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>
  >`
    SELECT migration_name, finished_at, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name = '20260504000000_add_conversation_personaid';
  `;
  console.log('migration row:', migration);

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
