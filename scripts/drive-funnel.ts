// Drive a full multi-turn funnel conversation against the local pipeline and
// print the transcript + final stage. Used to test autonomous funnel
// completion (e.g. Haiku vs Sonnet) and to capture proof transcripts.
//
// Reads PLATFORM env (IG default — backfill-free). Sends a fixed sequence of
// lead messages that answer the DAE funnel, waiting for each AI reply.
//
// Usage: PLATFORM=IG npx tsx scripts/drive-funnel.ts

import crypto from 'crypto';
import prisma from '../src/lib/prisma';

const PLATFORM = (process.env.PLATFORM || 'IG').toUpperCase();
const SECRET = process.env.META_APP_SECRET;
const isIG = PLATFORM === 'IG';
const ENTRY_ID = isIG ? '17841445698923309' : '1100557749811046';
const SENDER_ID = isIG ? '1474847644133208' : '27262754836683290';
const WEBHOOK = `http://localhost:3000/api/webhooks/${isIG ? 'instagram' : 'facebook'}`;
const OBJECT = isIG ? 'instagram' : 'page';

const LEAD_TURNS = [
  'hey man saw your content, im a software dev but trading on the side and keep blowing accounts',
  'yeah man i really need help, i keep revenge trading after losses and blowing my prop accounts',
  'been trading like 2 years now but never really consistent, always give back my profits',
  'honestly the main problem is my psychology, i have a decent strategy but i abandon it and revenge trade after 2 losses',
  'when a trade goes against me i panic, add to the losing position, then open revenge trades to win it back fast',
  'im a software engineer at a tech company, been there 4 years now',
  'i make about 7k a month from my dev job but i want trading to replace it eventually',
  'i want trading to fully replace my job so i can get out of the 9 to 5 and have freedom',
  'honestly id want to make at least 15k a month from trading consistently',
  'i want to be there for my kids and not miss them growing up, and have real financial security',
  'honestly i grew up watching my dad stressed about money my whole childhood, i never want my kids to feel that fear',
  'the main thing holding me back is my discipline and not having a real system to follow',
  'yeah man im fully committed to fixing this, ready to invest in myself',
  'yeah i have about 5k saved up i can put toward this',
  'yeah lets do it man, when can we hop on a call?',
  'tomorrow afternoon works for me, my email is shazimtest@gmail.com'
];

async function aiContents(): Promise<Set<string>> {
  const rows = await prisma.message.findMany({
    where: { sender: 'AI' },
    select: { content: true }
  });
  return new Set(rows.map((r) => r.content));
}

async function stageInfo(): Promise<string> {
  const c = await prisma.conversation.findFirst({
    where: { lead: { platform: isIG ? 'INSTAGRAM' : 'FACEBOOK' } },
    orderBy: { createdAt: 'desc' },
    select: { systemStage: true, lead: { select: { stage: true } } }
  });
  return `${c?.lead?.stage ?? '?'} / systemStage=${c?.systemStage ?? '?'}`;
}

async function send(text: string) {
  const ts = Date.now();
  const payload = JSON.stringify({
    object: OBJECT,
    entry: [
      {
        id: ENTRY_ID,
        time: ts,
        messaging: [
          {
            sender: { id: SENDER_ID },
            recipient: { id: ENTRY_ID },
            timestamp: ts,
            message: {
              mid: `f_${ts}_${Math.random().toString(36).slice(2)}`,
              text
            }
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', SECRET!).update(payload).digest('hex');
  await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
}

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  console.log(`=== FUNNEL RUN (${PLATFORM}) ===`);
  for (let t = 0; t < LEAD_TURNS.length; t++) {
    const before = await aiContents();
    await send(LEAD_TURNS[t]);
    console.log(`\n[T${t + 1}] LEAD: ${LEAD_TURNS[t]}`);
    let got = false;
    for (let i = 0; i < 22; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const now = await aiContents();
      const fresh = Array.from(now).filter((c) => !before.has(c));
      if (fresh.length > 0) {
        for (const f of fresh) console.log(`     AI: ${f}`);
        console.log(`     [stage: ${await stageInfo()}]`);
        got = true;
        break;
      }
    }
    if (!got) {
      const sr = await prisma.scheduledReply.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { status: true }
      });
      console.log(`     >>> NO REPLY — status=${sr?.status}. Stopping funnel.`);
      break;
    }
  }
  console.log(`\n=== END (final stage: ${await stageInfo()}) ===`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
