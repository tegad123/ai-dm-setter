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
  const SEEMAL_ID = process.env.E2E_SEEMAL_SENDER_ID || '';
  // Find Seemal's lead by name across all accounts
  const leads = await retry(() =>
    prisma.lead.findMany({
      where: {
        OR: [
          { name: { contains: 'eemal', mode: 'insensitive' } },
          { handle: { contains: 'eemal', mode: 'insensitive' } }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        name: true,
        handle: true,
        platformUserId: true,
        accountId: true,
        conversation: {
          select: {
            id: true,
            personaId: true,
            persona: { select: { id: true, personaName: true } }
          }
        }
      }
    })
  );
  console.log('Seemal leads found:', leads.length);
  leads.forEach((l) =>
    console.log(
      `  lead=${l.id} "${l.name}" @${l.handle} puid=${l.platformUserId} persona=${l.conversation?.persona?.id} "${l.conversation?.persona?.personaName}"`
    )
  );
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
