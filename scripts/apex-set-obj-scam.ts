// One-off: read Apex persona's objectionHandling, add OBJ-SCAM entry, write back
// Usage: npx tsx scripts/apex-set-obj-scam.ts [--dry-run]
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

// OBJ-SCAM script from Apex Trades DM Script V1 PDF
const APEX_OBJ_SCAM =
  "Completely fair — honestly I'd be asking the same thing. There's so much garbage online it makes sense to be sceptical. I'm Marcus, I've been trading for years and I help people build real systems, not hype. Everything I teach is based on what actually works in live markets. No fake screenshots, no overnight promises. The call is literally just a conversation — I want to understand your situation and see if what I do actually fits. If it doesn't, I'll tell you straight. What specifically feels off to you?";

const DRY_RUN = process.argv.includes('--dry-run');

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
  const c = await retry(() =>
    prisma.conversation.findFirst({
      where: { lead: { platformUserId: '27316153248002036' } },
      orderBy: { createdAt: 'desc' },
      select: { personaId: true }
    })
  );
  if (!c?.personaId) throw new Error('No conversation found for test PSID');

  const persona = await retry(() =>
    prisma.aIPersona.findUnique({
      where: { id: c.personaId! },
      select: { id: true, personaName: true, objectionHandling: true }
    })
  );
  if (!persona) throw new Error('Persona not found: ' + c.personaId);

  console.log('Persona:', persona.personaName, '(' + persona.id + ')');
  console.log(
    'Current objectionHandling:',
    JSON.stringify(persona.objectionHandling, null, 2)
  );

  // Merge OBJ-SCAM into existing objectionHandling
  const existing = (
    Array.isArray(persona.objectionHandling) ? persona.objectionHandling : []
  ) as Record<string, unknown>[];
  const hasScam = existing.some(
    (o) => typeof o?.type === 'string' && /scam/i.test(String(o.type))
  );
  if (hasScam) {
    console.log('OBJ-SCAM entry already exists — no change needed');
    await prisma.$disconnect();
    return;
  }

  const updated = [...existing, { type: 'OBJ-SCAM', script: APEX_OBJ_SCAM }];
  console.log('\nNew objectionHandling:', JSON.stringify(updated, null, 2));

  if (DRY_RUN) {
    console.log('\n[DRY RUN] — no write');
    await prisma.$disconnect();
    return;
  }

  await retry(() =>
    prisma.aIPersona.update({
      where: { id: persona.id },
      data: { objectionHandling: updated as object }
    })
  );
  console.log('\n✅ OBJ-SCAM written to Apex persona');
  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
