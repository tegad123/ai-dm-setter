// Full end-to-end test for a single R24 gate case on daetradez prod.
// Cleans up existing test lead, drives funnel to capital Q, sends the
// capital answer, then sends one more message and reports result.
//
// Usage:
//   npx tsx scripts/test-dae-case.ts "500 dollars"          # Case B — below threshold
//   npx tsx scripts/test-dae-case.ts "1000 dollars"         # Case C — exact boundary
//   npx tsx scripts/test-dae-case.ts "900"                  # Case D — post-block loop
//   npx tsx scripts/test-dae-case.ts --evasion              # Case E — dodge twice
//   npx tsx scripts/test-dae-case.ts --propfirm             # Case F — prop firm

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}

const SECRET = process.env.META_APP_SECRET!;
const WEBHOOK = 'https://qualifydms.io/api/webhooks/facebook';
const ENTRY_ID = '708196295710896';
const SENDER_ID = process.env.E2E_SENDER_ID || '27377136925304709'; // Seemal Shazim Khan
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(text: string): Promise<number> {
  const ts = Date.now();
  const payload = JSON.stringify({
    object: 'page',
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
              mid: `pd_${ts}_${Math.random().toString(36).slice(2)}`,
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
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  return res.status;
}

async function getState() {
  const lead = await retry(() =>
    prisma.lead.findFirst({
      where: { platformUserId: SENDER_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stage: true }
    })
  );
  if (!lead) return null;
  const conv = await retry(() =>
    prisma.conversation.findFirst({
      where: { leadId: lead.id },
      select: {
        id: true,
        systemStage: true,
        capitalVerificationStatus: true,
        capturedDataPoints: true
      }
    })
  );
  return { lead, conv };
}

async function getAiMsgCount(): Promise<number> {
  const s = await getState();
  if (!s?.conv) return 0;
  return retry(() =>
    prisma.message.count({
      where: { conversationId: s.conv!.id, sender: 'AI' }
    })
  );
}

async function getLastAiMsg(): Promise<string> {
  const s = await getState();
  if (!s?.conv) return '';
  const msg = await retry(() =>
    prisma.message.findFirst({
      where: { conversationId: s.conv!.id, sender: 'AI' },
      orderBy: { timestamp: 'desc' },
      select: { content: true }
    })
  );
  return msg?.content ?? '';
}

async function waitForAiReply(
  before: number,
  timeoutMs = 180000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const now = await getAiMsgCount();
    if (now > before) {
      await sleep(2000); // brief pause for second bubble
      return true;
    }
  }
  return false; // timed out
}

async function sendAndWait(text: string, label?: string): Promise<boolean> {
  const before = await getAiMsgCount();
  await send(text);
  if (label) process.stdout.write(`  > [${label}] ...`);
  const got = await waitForAiReply(before);
  if (!got) {
    if (label) console.log(` TIMEOUT — no AI reply after 90s`);
    return false;
  }
  if (label) {
    const last = await getLastAiMsg();
    console.log(` AI: "${last.slice(0, 80)}"`);
  }
  return true;
}

async function cleanup() {
  const leads = await prisma.lead.findMany({
    where: { platformUserId: SENDER_ID },
    select: { id: true }
  });
  for (const l of leads) {
    const cs = await prisma.conversation.findMany({
      where: { leadId: l.id },
      select: { id: true }
    });
    for (const c of cs) {
      await prisma.message.deleteMany({ where: { conversationId: c.id } });
      await prisma.scheduledReply.deleteMany({
        where: { conversationId: c.id }
      });
      await (prisma as any).aISuggestion
        ?.deleteMany({ where: { conversationId: c.id } })
        .catch(() => {});
    }
    await prisma.conversation.deleteMany({ where: { leadId: l.id } });
    await prisma.lead.delete({ where: { id: l.id } });
  }
  if (leads.length > 0) console.log(`  cleaned ${leads.length} old lead(s)`);
}

// Fast funnel: drives from opener to the point where capital Q is fired by AI
const FAST_FUNNEL = [
  'hey man, want to learn trading',
  "I'm in Canada",
  'been trading about 3 months',
  'want to make consistent income',
  'losing money, no real system',
  'its urgent, need this now',
  'I work full time',
  'I make 4k a month',
  'want to make 3k a month',
  'for my kids, time freedom',
  'consistency, no strategy',
  'yes I want guidance on a real system',
  'yeah entries trip me up',
  'entries 100%',
  'yes lets book something',
  'yeah that makes total sense',
  'yes I am ready to invest in learning',
  'yes lock me in lets go'
];

const CAP_Q_RE =
  /how much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest)|what.?s your (budget|capital)|set aside.*for (trading|markets|this|education)|capital situation|on the (capital|money|budget) side|what are you working with|what.?ve you got set aside|put toward this|working with (right now|financially)|got set aside/i;

async function driveToCapQ(): Promise<void> {
  console.log('  Driving funnel to capital Q (reactive)...');
  const responseFor = (aiMsg: string): string => {
    const m = aiMsg.toLowerCase();
    if (/where are you|where.*based|location|country/i.test(m))
      return "I'm in Canada";
    if (/new.*market|been.*trad|how long|experience/i.test(m))
      return 'about 3 months';
    if (/markets.*treating|main problem|struggling|going for you/i.test(m))
      return 'losing money, no real system';
    if (/income|make.*month|want.*earn|goal/i.test(m))
      return '3000 dollars a month';
    if (/why.*important|deeper|person|motivat|behind it/i.test(m))
      return 'for my kids, time freedom';
    if (/main.*stop|holding back|obstacle|biggest.*thing/i.test(m))
      return 'no consistency, no solid strategy';
    if (/job|work|employ|9.5|nine|income.*replace|how.*make|pay/i.test(m))
      return 'I work full time, 4k a month';
    if (/urgent|timeline|how soon|when.*ready/i.test(m))
      return 'urgent, need to fix this now';
    if (/what.*problem|entries|risk|overtrading|main issue/i.test(m))
      return 'entries trip me up most';
    if (/priority|guidance|ready|commit|next step/i.test(m))
      return 'yes I am ready, lets go';
    if (
      /book|call|link|lock|set up|hop on|schedule|monday|tuesday|wednesday|thursday|friday|free.*am|free.*pm/i.test(
        m
      )
    )
      return 'yes lets book, send me the link';
    if (/email/i.test(m)) return 'test@example.com';
    return 'yeah for sure, lets keep going';
  };

  for (let turn = 0; turn < 30; turn++) {
    const last = await getLastAiMsg();
    if (CAP_Q_RE.test(last)) {
      console.log(
        `  ✅ Capital Q detected on turn ${turn}: "${last.slice(0, 100)}"`
      );
      return;
    }
    const reply = responseFor(last);
    console.log(
      `  turn ${turn} | AI: "${last.slice(0, 70)}" → sending: "${reply}"`
    );
    const ok = await sendAndWait(reply);
    if (!ok) {
      // AI stopped responding — 24h window likely closed, abort
      throw new Error(
        `No AI reply after 3 minutes on turn ${turn} — AI may be stuck or window closed.`
      );
    }
    const newLast = await getLastAiMsg();
    if (CAP_Q_RE.test(newLast)) {
      console.log(
        `  ✅ Capital Q detected after reply on turn ${turn}: "${newLast.slice(0, 100)}"`
      );
      return;
    }
  }
  console.log('  ⚠ Capital Q not detected after 30 turns — proceeding anyway');
}

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  const arg = process.argv[2] ?? '';

  console.log('\n=== CLEANUP ===');
  await cleanup();

  console.log('\n=== FUNNEL DRIVE ===');
  // Send the opener and wait up to 3 minutes for the very first AI reply
  // (new lead creation + scheduling can take longer than subsequent turns)
  process.stdout.write('  Sending opener, waiting for first AI reply...');
  await send('hey man, want to learn trading');
  const firstOk = await waitForAiReply(0, 180000);
  if (!firstOk)
    throw new Error(
      'No AI reply after 3 minutes — check awayModeFacebook is ON and 24h window is open'
    );
  const firstMsg = await getLastAiMsg();
  console.log(` AI: "${firstMsg.slice(0, 80)}"`);
  await driveToCapQ();

  const s = await getState();
  const convId = s?.conv?.id ?? 'unknown';

  if (arg === '--evasion') {
    // Case E: dodge the capital question twice, evasion guard should fire on 3rd
    console.log('\n=== CASE E — EVASION ===');
    await sendAndWait(
      'why do you need to know how much money I have?',
      'dodge 1'
    );
    await sendAndWait(
      'I just want the link bro, money is not your concern',
      'dodge 2'
    );
    await sendAndWait(
      'stop asking about money, just send me the link',
      'dodge 3'
    );
  } else if (arg === '--propfirm') {
    // Case F: prop firm answer, no personal capital
    console.log('\n=== CASE F — PROP FIRM ===');
    await sendAndWait(
      'I use a 50k takeprofittrader funded account, no personal money set aside',
      'prop firm answer'
    );
    await sendAndWait('yes lets book it', 'booking push after prop firm');
  } else {
    // Cases B/C/D: send the capital amount directly
    const capitalAnswer = arg || '500 dollars';
    console.log(`\n=== CAPITAL ANSWER: "${capitalAnswer}" ===`);
    await sendAndWait(capitalAnswer, 'capital answer');

    if (/^9\d\d/.test(capitalAnswer) || capitalAnswer.includes('900')) {
      // Case D: after downsell fires, send follow-up to verify durable lock
      console.log(
        '\n=== CASE D — POST-BLOCK FOLLOW-UP (durable state test) ==='
      );
      await sleep(2000);
      await sendAndWait(
        'ok tell me more about that course you mentioned',
        'post-downsell 1'
      );
      await sendAndWait(
        'actually can I still get the booking link anyway',
        'post-downsell 2'
      );
    }
  }

  const finalState = await getState();
  const cdp = (finalState?.conv?.capturedDataPoints ?? {}) as Record<
    string,
    unknown
  >;
  const capVal =
    (cdp as any)?.capital?.value ??
    (cdp as any)?.capitalThresholdMet?.value ??
    '-';
  const thresholdMet = (cdp as any)?.capitalThresholdMet?.value ?? '-';
  console.log(`\n=== RESULT ===`);
  console.log(`  convId               = ${convId}`);
  console.log(
    `  capitalStatus        = ${finalState?.conv?.capitalVerificationStatus ?? '-'}`
  );
  console.log(`  capital CDP          = ${capVal}`);
  console.log(`  thresholdMet         = ${thresholdMet}`);
  console.log(
    `  systemStage          = ${finalState?.conv?.systemStage ?? '-'}`
  );
  const last = await getLastAiMsg();
  console.log(`  last AI message      = "${last.slice(0, 160)}"`);

  await prisma.$disconnect();
}
main().catch(async (e) => {
  console.error('ERR', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
