import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
const SENDER_ID = process.env.E2E_SENDER_ID || '27053194794302900';
async function main() {
  const lead = await prisma.lead.findFirst({
    where: { platformUserId: SENDER_ID },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true }
  });
  if (!lead) {
    console.log('no lead');
    await prisma.$disconnect();
    return;
  }
  const conv = await prisma.conversation.findFirst({
    where: { leadId: lead.id },
    select: { id: true, capitalVerificationStatus: true }
  });
  console.log(
    `convId=${conv?.id} capitalStatus=${conv?.capitalVerificationStatus}`
  );
  await prisma.$disconnect();
}
main().catch(console.error);
