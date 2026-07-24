// Drive ONE turn of an FB conversation against the local webhook and report
// the new AI reply bubbles + stage. Used to run deep multi-turn conversations
// for looping / stage-stagnation analysis. Dev-only.
//
// Usage: npx tsx scripts/drive-fb-turn.ts "lead message text"

import crypto from 'crypto';
import prisma from '../src/lib/prisma';

const PAGE_ID = process.env.PAGE_ID || '1100557749811046';
const SENDER_PSID = process.env.SENDER_PSID || '27262754836683290';
const WEBHOOK = 'http://localhost:3000/api/webhooks/facebook';
const SECRET = process.env.META_APP_SECRET;

async function aiMessageContents(): Promise<Set<string>> {
  const rows = await prisma.message.findMany({
    where: { sender: 'AI' },
    select: { content: true }
  });
  return new Set(rows.map((r) => r.content));
}

async function leadStage(): Promise<string> {
  const convo = await prisma.conversation.findFirst({
    where: { lead: { platform: 'FACEBOOK' } },
    orderBy: { createdAt: 'desc' },
    select: {
      systemStage: true,
      llmEmittedStage: true,
      stageMismatchCount: true,
      lead: { select: { stage: true } }
    }
  });
  return `leadStage=${convo?.lead?.stage ?? '?'} systemStage=${convo?.systemStage ?? '?'} llmEmitted=${convo?.llmEmittedStage ?? '?'} mismatchCount=${convo?.stageMismatchCount ?? 0}`;
}

async function main() {
  const text = process.argv[2];
  if (!text) throw new Error('provide a lead message');
  if (!SECRET) throw new Error('META_APP_SECRET not set');

  const before = await aiMessageContents();

  const ts = Date.now();
  const payload = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: ts,
        messaging: [
          {
            sender: { id: SENDER_PSID },
            recipient: { id: PAGE_ID },
            timestamp: ts,
            message: {
              mid: `drive_${ts}_${Math.random().toString(36).slice(2)}`,
              text
            }
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

  await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });

  console.log(`\n>>> LEAD: ${text}`);

  // Poll up to 75s for new AI bubble(s).
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const now = await aiMessageContents();
    const fresh = Array.from(now).filter((c) => !before.has(c));
    if (fresh.length > 0) {
      for (const f of fresh) console.log(`<<< AI:   ${f}`);
      console.log(`    [${await leadStage()}]`);
      await prisma.$disconnect();
      return;
    }
  }
  const sr = await prisma.scheduledReply.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { status: true, lastError: true }
  });
  console.log(
    `    (no AI reply after 75s; lastScheduledReply=${JSON.stringify(sr)})`
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
