import { PrismaClient } from '@prisma/client';
const url = (process.env.PROD_DATABASE_URL ?? '')
  .replace(':6543/', ':5432/')
  .replace('?pgbouncer=true', '');
const prisma = new PrismaClient({ datasources: { db: { url } } });
async function main() {
  const t = await prisma.generationTurnTrace.findFirst({
    where: { conversationId: 'cms0ic2xg0003kt04wsbri1qg' },
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      stepNumber: true,
      branchSelected: true,
      replyPreview: true,
      qualityHardFails: true
    }
  });
  console.log(
    `trace ${t?.createdAt.toISOString()} step=${t?.stepNumber} branch="${t?.branchSelected}"`
  );
  console.log('reply:', t?.replyPreview?.slice(0, 200));
  console.log('hardFails:', JSON.stringify(t?.qualityHardFails)?.slice(0, 300));
}
main().finally(() => prisma.$disconnect());
