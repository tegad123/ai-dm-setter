// IG parity day-1 proof: an Instagram webhook whose entry.id resolves to a
// workspace that has a META credential but NO INSTAGRAM credential must raise
// the operator notification and create no lead.
//   ACCOUNT_ID=<meta-only workspace> META_PAGE_ID=<its pageId> \
//   NODE_PATH=$PWD/node_modules npx tsx scripts/verify/not-connected-proof.ts [--cleanup]
// Defaults: Tega's own workspace (tegad8, ScaleVault page).
import crypto from 'crypto';
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
const ACCT = process.env.ACCOUNT_ID || 'cmod688i00000oa84aolhuk0j';
const ENTRY_ID = process.env.META_PAGE_ID || '1006770499175916';
const SENDER = process.env.SENDER_ID || '9900000000000002';
const TITLE = 'Instagram DMs are arriving but Instagram is not connected';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (process.argv.includes('--cleanup')) {
    const d = await retry(() =>
      prisma.notification.deleteMany({
        where: { accountId: ACCT, title: TITLE }
      })
    );
    console.log('cleanup: deleted', d.count, 'proof notification(s)');
    await prisma.$disconnect();
    return;
  }
  const before = await retry(() =>
    prisma.notification.count({ where: { accountId: ACCT, title: TITLE } })
  );
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
            message: { mid: `ig_nc_${ts}`, text: 'hey' }
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
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  console.log(
    `webhook POST → HTTP ${res.status} (entry.id=${ENTRY_ID} → META-only workspace ${ACCT})`
  );
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const after = await retry(() =>
      prisma.notification.count({ where: { accountId: ACCT, title: TITLE } })
    );
    if (after > before) {
      const leads = await retry(() =>
        prisma.lead.count({
          where: { accountId: ACCT, platformUserId: SENDER }
        })
      );
      console.log(
        `✅ notification created | leads created: ${leads} (expect 0)`
      );
      await prisma.$disconnect();
      return;
    }
  }
  console.log('❌ no notification after 30s');
  await prisma.$disconnect();
  process.exit(1);
})().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
