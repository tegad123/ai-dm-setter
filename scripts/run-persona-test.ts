// Dev-only: drive a full persona conversation through the active DAETRADEZ
// script against the local FB webhook, waiting for each AI reply to actually
// deliver (platformMessageId set) before sending the next turn. Captures clean
// per-turn evidence scoped to the single conversation created for this run.
//
// Usage:  PERSONA=p1_qualified_warm npx tsx scripts/run-persona-test.ts
// Personas: p1_qualified_warm p2_course_fit p3_soft_exit p4_unqualified_country p5_objection_heavy

import crypto from 'crypto';
import { readFileSync } from 'fs';
import prisma from '../src/lib/prisma';

const ROOT = '/Users/apple/Orbiqon/Development/ai-dm-setter';
const PAGE_ID = process.env.PAGE_ID || '1100557749811046';
const SENDER_PSID = process.env.SENDER_PSID || '27262754836683290';
const WEBHOOK = 'http://localhost:3000/api/webhooks/facebook';
const SECRET =
  readFileSync(`${ROOT}/.env`, 'utf-8')
    .split('\n')
    .find((l) => l.startsWith('META_APP_SECRET='))
    ?.split('=')[1]
    ?.replace(/^"|"$/g, '') || '';

interface Persona {
  label: string;
  expected: string;
  leadTurns: string[];
}

const PERSONAS: Record<string, Persona> = {
  p1_qualified_warm: {
    label:
      'P1 Qualified-Warm (US, $5k own capital, motivated, kids+freedom why)',
    expected:
      'Walks full funnel → capital $5k qualifies → BOOKED with real Google Meet link + reminders',
    leadTurns: [
      'hey saw your post about trading mentorship, looking for some help',
      "I'm based out of Texas in the US",
      'been trading futures for about 2 years now, mostly losing more than winning lately',
      "honestly the main problem is i revenge trade after losses, i don't have a real system, just guessing",
      'I work as a software engineer, been doing the 9-5 for 8 years',
      'the job makes around 9k a month right now',
      'I want to replace it fully, looking to do at least 15k a month consistently from trading',
      'honestly bro I want to be present for my kids, my dad worked all the time and missed everything, I dont want that for them',
      "yes bro 100%, that's exactly what I need, a real system instead of guessing would change everything",
      "yes let's do that, I'm ready to take action",
      'I have around 5000 saved up that I can put toward this, its my own money not a prop firm',
      'name is John Test, email john.test@example.com, phone +12025550100, EST timezone, tomorrow 2pm works',
      'yes I got the email thanks'
    ]
  },
  p2_course_fit: {
    label: 'P2 Course-Fit ($800 own capital → Step 24 course pitch)',
    expected:
      'Capital $800 routes to Step 20 → Step 24 ($497 course), NOT the call',
    leadTurns: [
      'hey what is this trading thing about',
      'based in California',
      'yeah been trading for about a year, struggling honestly',
      'i dont have a real strategy, just buying based on news and gut',
      'I work in a warehouse doing retail logistics',
      'make about 3500 a month',
      'want to supplement my income, maybe 2-3k extra a month from trading',
      'honestly i want out of the warehouse grind, my back is shot at 32',
      'yeah a system would help a lot for sure',
      "yes let's hop on a call",
      'i have about 800 saved up i could put toward this, my own money'
    ]
  },
  p3_soft_exit: {
    label: 'P3 Soft-Exit ($200 → Step 26 YouTube redirect, graceful)',
    expected:
      'Capital $200 (under $500) routes to Step 26 soft exit + YouTube link, no shame',
    leadTurns: [
      'hey saw your post bro',
      'based in Florida',
      'im new to trading, been watching videos for a few months',
      'i work part time at starbucks while in college',
      'make about 1800 a month',
      'want to make like 5k a month extra with trading honestly',
      'want to help my mom out, she has been working two jobs since my dad left',
      'yeah getting the right guidance is my number one priority',
      'yes i would love to hop on a call',
      'i have about 200 dollars saved up right now, things are tight'
    ]
  },
  p4_unqualified_country: {
    label: 'P4 Unqualified Country (Bangladesh → silent unqualify at Step 2)',
    expected:
      'Tagged unqualified after location, no YouTube, no goodbye, stops responding',
    leadTurns: ['hi I want to learn trading', 'I am based in Bangladesh']
  },
  p5_objection_heavy: {
    label: 'P5 Objection-Heavy (scam/cost/tried-before objections inline)',
    expected:
      'Handles OBJ-SCAM / OBJ-COST inline (from objection library), returns to flow, $3k qualifies',
    leadTurns: [
      'hey saw your post',
      'based in NYC',
      'been trading 3 years',
      'wait is this a scam? I have been burned before by signal services',
      'ok thanks for being real, i lost 10k last year on a different service',
      'i do construction, make 5k a month',
      "what does it cost? i don't want to waste time if its 10k or something",
      'ok cool. yeah i want to replace my income, maybe 10k a month from trading',
      'i want to retire my mom honestly, she sacrificed everything',
      "yes i'm 100% bought in, this is exactly what i need",
      "yes let's do a call",
      'i have 3000 saved, my own money'
    ]
  }
};

function sign(payload: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  );
}

async function sendWebhook(text: string): Promise<void> {
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
  await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': sign(payload)
    },
    body: payload
  });
}

async function getConvo(accountId: string) {
  return prisma.conversation.findFirst({
    where: { lead: { accountId, platform: 'FACEBOOK' } },
    orderBy: { createdAt: 'desc' },
    include: { lead: { select: { stage: true } } }
  });
}

// Wait for a NEW delivered AI message (platformMessageId set) after `sinceTs`.
async function waitForDeliveredAiReply(
  convoId: string,
  sinceTs: Date,
  timeoutMs = 90000
): Promise<{ delivered: boolean; bubbles: string[]; stage: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const aiMsgs = await prisma.message.findMany({
      where: {
        conversationId: convoId,
        sender: 'AI',
        timestamp: { gt: sinceTs }
      },
      orderBy: { timestamp: 'asc' },
      select: { content: true, platformMessageId: true, stage: true }
    });
    const delivered = aiMsgs.filter((m) => m.platformMessageId);
    if (delivered.length > 0) {
      return {
        delivered: true,
        bubbles: delivered.map((m) => m.content),
        stage: delivered[delivered.length - 1].stage
      };
    }
  }
  return { delivered: false, bubbles: [], stage: null };
}

async function main() {
  const key = process.env.PERSONA || 'p1_qualified_warm';
  const persona = PERSONAS[key];
  if (!persona) {
    console.error(
      'Unknown PERSONA:',
      key,
      '\nAvailable:',
      Object.keys(PERSONAS).join(', ')
    );
    process.exit(1);
  }
  const account = await prisma.account.findFirst({
    where: { slug: 'iamshazimkhan' },
    select: { id: true }
  });
  if (!account) throw new Error('account not found');
  const accountId = account.id;

  // Clean FB side for this persona run
  const leads = await prisma.lead.findMany({
    where: { accountId, platform: 'FACEBOOK' },
    select: { id: true }
  });
  const leadIds = leads.map((l) => l.id);
  const convos = await prisma.conversation.findMany({
    where: { leadId: { in: leadIds } },
    select: { id: true }
  });
  const convoIds = convos.map((c) => c.id);
  await prisma.scheduledMessage.deleteMany({
    where: { conversationId: { in: convoIds } }
  });
  await prisma.aISuggestion.deleteMany({
    where: { conversationId: { in: convoIds } }
  });
  await prisma.message.deleteMany({
    where: { conversationId: { in: convoIds } }
  });
  await prisma.leadStageTransition
    .deleteMany({ where: { leadId: { in: leadIds } } })
    .catch(() => {});
  await prisma.conversation.deleteMany({ where: { id: { in: convoIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });

  console.log(`\n${'='.repeat(70)}`);
  console.log(persona.label);
  console.log('EXPECTED:', persona.expected);
  console.log('='.repeat(70));

  for (let i = 0; i < persona.leadTurns.length; i++) {
    const turnStart = new Date();
    console.log(`\n--- Turn ${i + 1}/${persona.leadTurns.length} ---`);
    console.log('>>> LEAD:', persona.leadTurns[i]);
    await sendWebhook(persona.leadTurns[i]);

    // give the webhook a moment to create the convo on turn 1
    await new Promise((r) => setTimeout(r, 2000));
    const convo = await getConvo(accountId);
    if (!convo) {
      console.log('    (no convo created yet — webhook may have rejected)');
      continue;
    }

    const res = await waitForDeliveredAiReply(convo.id, turnStart);
    if (res.delivered) {
      for (const b of res.bubbles) console.log('<<< AI:', b);
    } else {
      console.log('    (no DELIVERED AI reply within 90s)');
    }

    const after = await getConvo(accountId);
    console.log(
      `    STATE | lead.stage=${after?.lead.stage} | capital=${after?.capitalVerificationStatus}/$${after?.capitalVerifiedAmount ?? '-'} | scheduledCallAt=${after?.scheduledCallAt?.toISOString() ?? '-'} | aiStage=${res.stage ?? '-'}`
    );
  }

  // Final evidence
  const convo = await getConvo(accountId);
  console.log(`\n${'='.repeat(70)}\nFINAL STATE — ${persona.label}`);
  console.log('  lead.stage:', convo?.lead.stage);
  console.log('  capitalVerificationStatus:', convo?.capitalVerificationStatus);
  console.log(
    '  capitalVerifiedAmount: $' + (convo?.capitalVerifiedAmount ?? 'null')
  );
  console.log(
    '  scheduledCallAt:',
    convo?.scheduledCallAt?.toISOString() ?? 'none'
  );
  console.log('  scheduledCallSource:', convo?.scheduledCallSource ?? '-');
  console.log(
    '  leadEmail:',
    convo?.leadEmail ?? '-',
    '| leadTimezone:',
    convo?.leadTimezone ?? '-'
  );
  if (convo) {
    const reminders = await prisma.scheduledMessage.findMany({
      where: { conversationId: convo.id, status: 'PENDING' },
      select: { messageType: true, scheduledFor: true }
    });
    console.log(
      '  pending reminders:',
      reminders.map((r) => r.messageType).join(', ') || 'none'
    );
    const aiCount = await prisma.message.count({
      where: {
        conversationId: convo.id,
        sender: 'AI',
        platformMessageId: { not: null }
      }
    });
    console.log('  delivered AI messages:', aiCount);
  }
  console.log('='.repeat(70));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED:', e);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
