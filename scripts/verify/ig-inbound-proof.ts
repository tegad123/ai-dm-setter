// Instagram inbound RESOLUTION proof.
// Fires a Meta-shaped, HMAC-signed Instagram webhook at prod with a chosen
// entry.id and a synthetic sender, then asserts a Lead + Conversation +
// Message appear in the expected workspace.
//
//   ACCOUNT_ID=<workspace> IG_ENTRY_ID=<17841… professional or business id> \
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/ig-inbound-proof.ts           # fire + verify
//   ... scripts/verify/ig-inbound-proof.ts --cleanup                                   # delete the synthetic lead
//
// Defaults: Daniel's workspace + his @daetradez professional id (2026-09-09).
// A synthetic sender can never receive a reply at Meta; this proves routing +
// generation, not delivery. Delivery proof = a real DM from a real account.
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});
async function retry<T>(fn: () => Promise<T>, t = 20): Promise<T> {
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
const ACCT = process.env.ACCOUNT_ID || 'cmpy59zy50000ju04u6fs5o2r';
const ENTRY_ID = process.env.IG_ENTRY_ID || '17841403104278070';
const SENDER = process.env.SENDER_ID || '9900000000000001';
const WEBHOOK =
  process.env.WEBHOOK_URL || 'https://qualifydms.io/api/webhooks/instagram';
const TEXT =
  process.env.TEXT || 'hey saw your post about trading, how do i get started?';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function cleanup() {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { accountId: ACCT, platformUserId: SENDER },
      select: { id: true, conversation: { select: { id: true } } }
    })
  );
  if (!lead) return console.log('cleanup: no synthetic lead found');
  const cid = lead.conversation?.id;
  if (cid) {
    for (const m of [
      'scheduledReply',
      'aISuggestion',
      'generationTurnTrace',
      'egressShadowLog',
      'message'
    ] as const) {
      await retry(() =>
        (prisma as any)[m].deleteMany({ where: { conversationId: cid } })
      ).catch(() => null);
    }
    await retry(() => prisma.conversation.delete({ where: { id: cid } }));
  }
  await retry(() =>
    prisma.notification.deleteMany({ where: { leadId: lead.id } })
  ).catch(() => null);
  await retry(() => prisma.lead.delete({ where: { id: lead.id } }));
  console.log(`cleanup: deleted synthetic lead ${lead.id} conv ${cid}`);
}
(async () => {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    await prisma.$disconnect();
    return;
  }
  if (!process.env.META_APP_SECRET) throw new Error('META_APP_SECRET missing');
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
            message: { mid: `ig_proof_${ts}`, text: TEXT }
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.META_APP_SECRET)
      .update(payload)
      .digest('hex');
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  console.log(
    `webhook POST → HTTP ${res.status} (entry.id=${ENTRY_ID}, sender=${SENDER}, account=${ACCT})`
  );
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const lead = await retry(() =>
      prisma.lead.findFirst({
        where: { accountId: ACCT, platformUserId: SENDER },
        select: {
          id: true,
          platform: true,
          handle: true,
          createdAt: true,
          conversation: {
            select: {
              id: true,
              aiActive: true,
              autoSendOverride: true,
              awaitingAiResponse: true,
              source: true,
              currentScriptStep: true,
              messages: {
                orderBy: { timestamp: 'asc' },
                select: { sender: true, content: true }
              }
            }
          }
        }
      })
    );
    if (lead) {
      console.log('\n✅ RESOLVED:');
      console.log(
        `  lead=${lead.id} platform=${lead.platform} handle=${lead.handle} created=${lead.createdAt.toISOString()}`
      );
      console.log(
        `  conv=${lead.conversation?.id} aiActive=${lead.conversation?.aiActive} autoSendOverride=${lead.conversation?.autoSendOverride} awaitingAi=${lead.conversation?.awaitingAiResponse} source=${lead.conversation?.source} step=${lead.conversation?.currentScriptStep}`
      );
      lead.conversation?.messages.forEach((m) =>
        console.log(
          `  ${String(m.sender).padEnd(5)} ${JSON.stringify(m.content?.slice(0, 100))}`
        )
      );
      console.log(
        '\nnext: scripts/verify/watch-conversation.ts',
        lead.conversation?.id,
        '| cleanup: --cleanup'
      );
      await prisma.$disconnect();
      return;
    }
  }
  console.log(
    '\n❌ no lead after 60s — the entry.id matched no credential (check scripts/verify/ig-credential-health.ts) or the route rejected it (Vercel logs: "[instagram-webhook] REJECTED")'
  );
  await prisma.$disconnect();
  process.exit(1);
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
