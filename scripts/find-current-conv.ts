import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const SENDER_ID = process.env.E2E_SENDER_ID || '27053194794302900';
async function main() {
  const leads = await prisma.lead.findMany({
    where: { platformUserId: SENDER_ID },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      stage: true,
      createdAt: true,
      conversation: { select: { id: true, createdAt: true } }
    }
  });
  leads.forEach((l) =>
    console.log(
      'lead',
      l.id,
      l.stage,
      l.createdAt,
      '| conv',
      l.conversation?.id,
      l.conversation?.createdAt
    )
  );
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
