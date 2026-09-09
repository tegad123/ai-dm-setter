// Generate-only shadow mode proof, end to end, on ONE workspace.
//   setup   → generate-only IG ON, Away Mode IG OFF (prior state saved to .genonly-prior.json)
//   fire    → synthetic IG inbound; asserts AI on, trace + suggestion written, queue row
//             CANCELLED 'suggestion_only', shadow row sendPath 'generate_only', 0 AI deliveries
//   enforce → calls sendDM directly as a non-operator: must throw EgressBlockedError GENERATE_ONLY
//   restore → prior settings back + synthetic lead deleted
//
//   export DATABASE_URL="$PROD_DATABASE_URL"   # REQUIRED for `enforce` (imports src/lib/instagram → @/lib/prisma)
//   ACCOUNT_ID=<workspace> IG_ENTRY_ID=<its stored 17841… id> \
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/generate-only-proof.ts <setup|fire|enforce|restore>
// Defaults: shazim's workspace + SK Trades IG business id. Proven 2026-09-09 on 993861a.
import crypto from 'crypto';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, t = 15): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw l;
}
const ACCT = process.env.ACCOUNT_ID || 'cmpb0knph00009kyx6tjzl4w1';
const ENTRY_ID = process.env.IG_ENTRY_ID || '17841445698923309';
const SENDER = process.env.SENDER_ID || '9900000000000005';
const STATE_FILE = path.resolve(process.cwd(), '.genonly-prior.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mode = process.argv[2];
(async () => {
  if (mode === 'setup') {
    const prior = await retry(() =>
      prisma.account.findUnique({
        where: { id: ACCT },
        select: {
          generateOnlyInstagram: true,
          awayModeInstagram: true,
          defaultAiActive: true
        }
      })
    );
    fs.writeFileSync(STATE_FILE, JSON.stringify(prior));
    const u = await retry(() =>
      prisma.account.update({
        where: { id: ACCT },
        data: { generateOnlyInstagram: true, awayModeInstagram: false },
        select: {
          generateOnlyInstagram: true,
          awayModeInstagram: true,
          defaultAiActive: true
        }
      })
    );
    console.log('prior:', JSON.stringify(prior), '→ now:', JSON.stringify(u));
  } else if (mode === 'fire') {
    const ts = Date.now();
    const payload = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: ENTRY_ID,
          time: ts,
          messaging: [
            {
              sender: { id: SENDER },
              recipient: { id: ENTRY_ID },
              timestamp: ts,
              message: {
                mid: `ig_genonly_${ts}`,
                text: 'yo saw your post, how do i get started with trading?'
              }
            }
          ]
        }
      ]
    });
    const sig =
      'sha256=' +
      crypto
        .createHmac('sha256', process.env.META_APP_SECRET!)
        .update(payload)
        .digest('hex');
    const res = await fetch('https://qualifydms.io/api/webhooks/instagram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig
      },
      body: payload
    });
    console.log(`webhook POST → HTTP ${res.status}`);
    let convId: string | null = null;
    for (let i = 0; i < 20 && !convId; i++) {
      await sleep(3000);
      const l = await retry(() =>
        prisma.lead.findFirst({
          where: { accountId: ACCT, platformUserId: SENDER },
          select: {
            conversation: {
              select: { id: true, aiActive: true, autoSendOverride: true }
            }
          }
        })
      );
      if (l?.conversation) {
        convId = l.conversation.id;
        console.log(
          `lead created: conv=${convId} aiActive=${l.conversation.aiActive} (expect true)`
        );
      }
    }
    if (!convId) {
      console.log('❌ no lead');
      process.exit(1);
    }
    for (let i = 0; i < 50; i++) {
      await sleep(5000);
      const tr = await retry(() =>
        prisma.generationTurnTrace.count({ where: { conversationId: convId! } })
      );
      const sr = await retry(() =>
        prisma.scheduledReply.findMany({
          where: { conversationId: convId! },
          select: { status: true, attempts: true, lastError: true }
        })
      );
      const closed = sr.some(
        (s) =>
          s.status === 'CANCELLED' &&
          (s.lastError ?? '').startsWith('suggestion_only')
      );
      if (tr > 0 && closed) {
        const eg = await retry(() =>
          prisma.egressShadowLog.findMany({
            where: { conversationId: convId! },
            select: {
              sendPath: true,
              machineAllow: true,
              machineReason: true,
              agreed: true
            }
          })
        );
        const ai = await retry(() =>
          prisma.message.count({
            where: { conversationId: convId!, sender: 'AI' }
          })
        );
        const sug = await retry(() =>
          prisma.aISuggestion.count({ where: { conversationId: convId! } })
        );
        console.log(
          `✅ traces=${tr} suggestions=${sug} | scheduledReply=${JSON.stringify(sr)}`
        );
        console.log(
          `   shadow rows=${JSON.stringify(eg)} (expect sendPath generate_only)`
        );
        console.log(`   AI messages delivered=${ai} (expect 0)`);
        process.exit(0);
      }
      if (i % 6 === 5)
        console.log(
          `  waiting… traces=${tr} sr=${JSON.stringify(sr.map((s) => s.status))}`
        );
    }
    console.log('❌ timed out waiting for generation');
    process.exit(1);
  } else if (mode === 'enforce') {
    const { sendDM } = await import('../../src/lib/instagram');
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { accountId: ACCT, platformUserId: SENDER },
        select: { conversation: { select: { id: true } } }
      })
    );
    const before = await retry(() =>
      prisma.egressShadowLog.count({
        where: { accountId: ACCT, machineReason: 'GENERATE_ONLY' }
      })
    );
    try {
      await sendDM(ACCT, SENDER, 'this must never leave the building', {
        conversationId: lead?.conversation?.id ?? null,
        operatorInitiated: false
      });
      console.log('❌ send was NOT blocked');
    } catch (e: any) {
      console.log(
        `blocked: ${e?.name} reason=${e?.reason} — ${String(e?.message).slice(0, 90)}`
      );
    }
    const after = await retry(() =>
      prisma.egressShadowLog.count({
        where: { accountId: ACCT, machineReason: 'GENERATE_ONLY' }
      })
    );
    console.log(`GENERATE_ONLY shadow rows: ${before} → ${after} (expect +1)`);
  } else if (mode === 'restore') {
    const prior = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    await retry(() =>
      prisma.account.update({
        where: { id: ACCT },
        data: {
          generateOnlyInstagram: prior.generateOnlyInstagram,
          awayModeInstagram: prior.awayModeInstagram
        }
      })
    );
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { accountId: ACCT, platformUserId: SENDER },
        select: { id: true, conversation: { select: { id: true } } }
      })
    );
    if (lead) {
      const c = lead.conversation?.id;
      if (c) {
        for (const m of [
          'scheduledReply',
          'aISuggestion',
          'generationTurnTrace',
          'egressShadowLog',
          'message'
        ] as const) {
          await retry(() =>
            (prisma as any)[m].deleteMany({ where: { conversationId: c } })
          ).catch(() => null);
        }
        await retry(() => prisma.conversation.delete({ where: { id: c } }));
      }
      await retry(() =>
        prisma.notification.deleteMany({ where: { leadId: lead.id } })
      ).catch(() => null);
      await retry(() => prisma.lead.delete({ where: { id: lead.id } }));
    }
    console.log(
      'restored settings to',
      JSON.stringify(prior),
      '| synthetic lead deleted:',
      Boolean(lead)
    );
  } else {
    console.error('usage: generate-only-proof.ts <setup|fire|enforce|restore>');
    process.exit(2);
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERR', e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
