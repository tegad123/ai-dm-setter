import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const p = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});

async function retry<T>(fn: () => Promise<T>, tries = 8): Promise<T> {
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
  // Search specifically for Ahsan Ali — full name or handle
  const leads = await retry(() =>
    p.lead.findMany({
      where: {
        OR: [
          { name: { contains: 'ahsan', mode: 'insensitive' } },
          { handle: { contains: 'ahsan', mode: 'insensitive' } }
        ]
      },
      select: {
        id: true,
        name: true,
        handle: true,
        stage: true,
        createdAt: true
      }
    })
  );

  console.log(`Found ${leads.length} leads matching "ahsan":`);
  leads.forEach((l) =>
    console.log(
      `  ${l.id} | ${l.name} | @${l.handle} | ${l.stage} | ${l.createdAt.toISOString()}`
    )
  );

  if (leads.length === 0) {
    await p.$disconnect();
    return;
  }

  for (const lead of leads) {
    console.log(`\n=== CONV FOR: ${lead.name} (@${lead.handle}) ===`);
    const conv = await retry(() =>
      p.conversation.findFirst({
        where: { leadId: lead.id },
        select: {
          id: true,
          capitalVerificationStatus: true,
          capitalVerifiedAmount: true,
          scheduledCallAt: true,
          systemStage: true,
          currentScriptStep: true,
          capturedDataPoints: true,
          createdAt: true
        }
      })
    );
    if (!conv) {
      console.log('  no conversation');
      continue;
    }
    const cdp = conv.capturedDataPoints as any;
    console.log(`  convId: ${conv.id}`);
    console.log(
      `  capitalVerificationStatus: ${conv.capitalVerificationStatus}`
    );
    console.log(`  capitalVerifiedAmount: ${conv.capitalVerifiedAmount}`);
    console.log(`  scheduledCallAt: ${conv.scheduledCallAt}`);
    console.log(
      `  systemStage: ${conv.systemStage} | step: ${conv.currentScriptStep}`
    );
    console.log(
      `  cdp.capitalThresholdMet: ${cdp?.capitalThresholdMet?.value ?? '-'}`
    );
    console.log(
      `  cdp.verifiedCapitalUsd: ${cdp?.verifiedCapitalUsd?.value ?? '-'}`
    );

    const msgs = await retry(() =>
      p.message.findMany({
        where: { conversationId: conv.id },
        orderBy: { timestamp: 'asc' },
        select: { sender: true, content: true, timestamp: true }
      })
    );
    console.log(`\n  --- FULL CONVERSATION (${msgs.length} messages) ---`);
    msgs.forEach((m) =>
      console.log(`  [${m.timestamp.toISOString()}] ${m.sender}: ${m.content}`)
    );
  }

  await p.$disconnect();
}
main().catch((e) => {
  console.error('FATAL:', e.message);
  p.$disconnect();
});
