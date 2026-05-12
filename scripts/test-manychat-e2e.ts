/* eslint-disable no-console */
// Synthetic end-to-end test of all 4 ManyChat webhooks. Fires the
// sequence ManyChat would fire on a real outbound flow against the
// production endpoints, against a fresh synthetic IG handle so nothing
// real is touched. Verifies DB state at the end.

import prisma from '../src/lib/prisma';

const ACCOUNT_SLUG = 'daetradez2003';
const TEST_HANDLE = `qdms_e2e_test_${Math.floor(Date.now() / 1000)}`;
// Synthetic 17-digit IG numeric ID — not a real IG account, so any
// AI-side IG Send attempt will fail at Meta. That's fine for testing
// the WEBHOOK plumbing; real-traffic delivery is option A (the user
// follows daetradez from a real test account).
const TEST_NUMERIC_ID = '99999999999999900';
const TEST_MC_SUB = `999999${Math.floor(Date.now() / 1000)}`;

const BASE = 'https://qualifydms.io/api/webhooks';

async function fire(
  path: string,
  body: Record<string, unknown>,
  key: string
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${BASE}/${path}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: ACCOUNT_SLUG },
    select: { id: true, manyChatWebhookKey: true }
  });
  if (!account) throw new Error(`account ${ACCOUNT_SLUG} not found`);

  console.log(`Test handle: @${TEST_HANDLE}`);
  console.log(`Test IG ID:  ${TEST_NUMERIC_ID}`);
  console.log(`Account:     ${account.id}`);
  console.log('');

  // 1. manychat-handoff — opener + button click
  console.log('─── 1. manychat-handoff (opener + "Yes, send it over!") ───');
  const r1 = await fire(
    'manychat-handoff',
    {
      instagramUserId: TEST_NUMERIC_ID,
      instagramUsername: TEST_HANDLE,
      openerMessage:
        'My man, thank you for the follow! 🫶 Always love to give value. Are you familiar with the Session Liquidity Model? If not, I can send it over.',
      triggerType: 'new_follower',
      manyChatSubscriberId: TEST_MC_SUB,
      leadResponseText: 'Yes, send it over!'
    },
    account.manyChatWebhookKey
  );
  console.log(`  HTTP ${r1.status}: ${r1.text}`);

  // 2. manychat-message — "Perfect…" + 6 minutes of sauce
  console.log('');
  console.log('─── 2. manychat-message ("Perfect…6 minutes of sauce") ───');
  const r2 = await fire(
    'manychat-message',
    {
      instagramUserId: TEST_NUMERIC_ID,
      instagramUsername: TEST_HANDLE,
      messageText:
        'Perfect, this is gonna make you dangerous on the markets 😂\n\n→ 6 minutes of sauce: https://youtu.be/EXAMPLE_VIDEO'
    },
    account.manyChatWebhookKey
  );
  console.log(`  HTTP ${r2.status}: ${r2.text}`);

  // 3. manychat-message — "Did You Give it a watch?"
  console.log('');
  console.log('─── 3. manychat-message ("Did You Give it a watch?") ───');
  const r3 = await fire(
    'manychat-message',
    {
      instagramUserId: TEST_NUMERIC_ID,
      instagramUsername: TEST_HANDLE,
      messageText: 'Did You Give it a watch?'
    },
    account.manyChatWebhookKey
  );
  console.log(`  HTTP ${r3.status}: ${r3.text}`);

  // 4. manychat-complete — final action, signals AI to take over
  console.log('');
  console.log('─── 4. manychat-complete (final action) ───');
  const r4 = await fire(
    'manychat-complete',
    {
      instagramUserId: TEST_NUMERIC_ID,
      instagramUsername: TEST_HANDLE
    },
    account.manyChatWebhookKey
  );
  console.log(`  HTTP ${r4.status}: ${r4.text}`);

  // Verify DB state
  console.log('');
  console.log('─── DB verification ───');
  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      OR: [
        { platformUserId: TEST_NUMERIC_ID },
        { handle: { equals: TEST_HANDLE, mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { timestamp: 'asc' } }
        }
      }
    }
  });
  if (!lead || !lead.conversation) {
    console.log('  ✗ Lead/Conversation not found');
    process.exitCode = 1;
  } else {
    const c = lead.conversation;
    console.log(
      `  Lead:         ${lead.id} @${lead.handle} platformUserId=${lead.platformUserId}`
    );
    console.log(
      `  Conversation: ${c.id} source=${c.source} aiActive=${c.aiActive} awaitingAiResponse=${c.awaitingAiResponse} awaitingSince=${c.awaitingSince?.toISOString() ?? 'null'}`
    );
    console.log(`  Messages (${c.messages.length}):`);
    for (const m of c.messages) {
      const t = m.timestamp.toISOString().slice(11, 19);
      console.log(
        `    [${m.sender.padEnd(8)}] ${t}  ${m.content.slice(0, 70)}`
      );
    }

    // Pass/fail summary
    console.log('');
    console.log('─── checks ───');
    const expectedSenders = ['AI', 'LEAD', 'MANYCHAT', 'MANYCHAT'];
    const actualSenders = c.messages.map((m) => m.sender);
    const sendersOK =
      JSON.stringify(actualSenders) === JSON.stringify(expectedSenders);
    console.log(
      `  ${sendersOK ? '✓' : '✗'} Senders: expected ${expectedSenders.join(',')}, got ${actualSenders.join(',')}`
    );
    console.log(`  ${c.source === 'MANYCHAT' ? '✓' : '✗'} source=MANYCHAT`);
    console.log(`  ${c.aiActive ? '✓' : '✗'} aiActive=true`);
    console.log(
      `  ${c.awaitingAiResponse ? '✓' : '✗'} awaitingAiResponse=true (set by manychat-complete)`
    );
    console.log(
      `  ${lead.platformUserId === TEST_NUMERIC_ID ? '✓' : '✗'} platformUserId upgraded to numeric (${lead.platformUserId})`
    );
  }

  console.log('');
  console.log(`Cleanup: when you want to remove this test data, run:`);
  console.log(
    `  set -a && source .env && set +a && npx tsx -e "import prisma from './src/lib/prisma'; (async()=>{const l=await prisma.lead.findFirst({where:{handle:'${TEST_HANDLE}'}}); if(l){await prisma.message.deleteMany({where:{conversation:{leadId:l.id}}}); await prisma.conversation.deleteMany({where:{leadId:l.id}}); await prisma.lead.delete({where:{id:l.id}}); console.log('deleted');} await prisma.\\\$disconnect();})()"`
  );
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
