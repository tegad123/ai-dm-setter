import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}
async function main() {
  const SHAZIM = '27053194794302900';
  const SEEMAL = '27377136925304709';
  for (const [name, puid] of [
    ['Shazim', SHAZIM],
    ['Seemal', SEEMAL]
  ]) {
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { platformUserId: puid },
        orderBy: { createdAt: 'desc' },
        select: {
          conversation: {
            select: {
              personaId: true,
              persona: { select: { promptConfig: true, personaName: true } }
            }
          }
        }
      })
    );
    const pc = lead?.conversation?.persona?.promptConfig as
      | Record<string, unknown>
      | undefined;
    console.log(
      `${name}: persona=${lead?.conversation?.personaId} flag=${pc?.disableLeadStageProgression ?? '(UNSET)'}`
    );
  }
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
