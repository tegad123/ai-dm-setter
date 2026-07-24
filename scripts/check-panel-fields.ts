import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function main() {
  for (const [name, id] of [
    ['Shazim', 'cmrnhau1g0003jf05f1bywex1'],
    ['Seemal', 'cmrnhe5ji000glc04ch2k49r3']
  ]) {
    // What the panel's API returns: GET /api/conversations/[id] -> include messages
    const conv = await prisma.conversation.findUnique({
      where: { id },
      select: {
        stageOpeningAt: true,
        stageSituationDiscoveryAt: true,
        stageGoalEmotionalWhyAt: true,
        stageUrgencyAt: true,
        stageSoftPitchCommitmentAt: true,
        stageFinancialScreeningAt: true,
        stageBookingAt: true,
        messages: { where: { sender: 'AI' }, select: { stage: true } }
      }
    });
    const stamps = [
      'stageOpeningAt',
      'stageSituationDiscoveryAt',
      'stageGoalEmotionalWhyAt',
      'stageUrgencyAt',
      'stageSoftPitchCommitmentAt',
      'stageFinancialScreeningAt',
      'stageBookingAt'
    ];
    const lit = stamps.filter((k) => (conv as any)[k] != null);
    const msgStages =
      conv?.messages.filter((m) => m.stage != null).map((m) => m.stage) ?? [];
    console.log(
      `${name}: reachedStages=[${lit.join(',')}] | AI msg.stage non-null=[${msgStages.join(',')}]`
    );
  }
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await prisma.$disconnect();
  process.exit(1);
});
