import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function main() {
  const lead = await prisma.lead.findFirst({
    where: { platformUserId: '27377136925304709' },
    orderBy: { createdAt: 'desc' },
    select: { conversation: { select: { id: true } } }
  });
  console.log(lead?.conversation?.id ?? 'none');
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
