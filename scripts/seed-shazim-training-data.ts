/**
 * One-off dev seed: populates synthetic-but-plausible training data
 * (TrainingUpload + TrainingConversations + TrainingMessages) for the
 * "shazim's Workspace" local dev account, so the ai-engine no-training
 * suppression guard passes and the AI pipeline can run end-to-end.
 *
 * Run: bun tsx scripts/seed-shazim-training-data.ts
 *
 * Idempotent — uses (accountId, fileHash) / (accountId, contentHash)
 * unique constraints to skip re-creation on re-run.
 *
 * Content is original synthetic high-ticket coaching DMs. Structural
 * shape (sender ratio, avg lengths, stage labels, outcome labels)
 * mirrors the production daetradez account observed via read-only
 * inspection on 2026-05-18 — content does not.
 */

import { createHash } from 'node:crypto';
import prisma from '../src/lib/prisma';

const ACCOUNT_ID = 'cmpa60h9c0000gs4l85idlaby';
const PERSONA_ID = 'cmpa60h9g0002gs4lh5p92sh7';

type SeedMsg = {
  sender: 'LEAD' | 'CLOSER';
  text: string;
  stage: string | null;
  messageType?: string;
};

type SeedConversation = {
  leadIdentifier: string;
  outcomeLabel:
    | 'UNKNOWN'
    | 'HARD_NO'
    | 'GHOSTED'
    | 'OBJECTION_LOST'
    | 'BOOKED_NO_SHOW';
  messages: SeedMsg[];
};

// ─────────────────────────────────────────────────────────────────────
// Conversation 1 — Full qualification → booked (UNKNOWN, the most
// common outcome label in production: lead completes flow, outcome
// of the actual call is unknown to the AI).
// ─────────────────────────────────────────────────────────────────────
const convo1: SeedConversation = {
  leadIdentifier: 'synthetic_lead_ricky_001',
  outcomeLabel: 'UNKNOWN',
  messages: [
    {
      sender: 'LEAD',
      text: 'hey saw your reel about scaling past 50k, that one hit home',
      stage: 'intro'
    },
    {
      sender: 'CLOSER',
      text: 'yeah man, that one resonated. what are you working on rn?',
      stage: 'intro'
    },
    {
      sender: 'LEAD',
      text: 'fitness coaching, doing about 12k/mo. feel stuck',
      stage: 'qualification'
    },
    {
      sender: 'CLOSER',
      text: 'stuck how — content side or offer side?',
      stage: 'qualification'
    },
    {
      sender: 'LEAD',
      text: 'honestly both. content gets views but no DMs. clients come from referrals only',
      stage: 'qualification'
    },
    {
      sender: 'CLOSER',
      text: 'got it, so the gap is converting attention into actual conversations. what would 50k/mo look like for your life?',
      stage: 'education'
    },
    {
      sender: 'LEAD',
      text: 'honestly? buying my mom a house this year',
      stage: 'education'
    },
    {
      sender: 'CLOSER',
      text: "that's a real why. quick question — if i told you most of our clients double in 90 days, would the holdup be money, time, or skepticism?",
      stage: 'qualification'
    },
    {
      sender: 'LEAD',
      text: "probably skepticism plus i wanna know what's actually involved",
      stage: 'objection_handling'
    },
    {
      sender: 'CLOSER',
      text: 'fair. we run a 12 week 1on1 program — 2 calls a week, content engine, offer breakdown. 8.5k full pay or 3 payments. easier to walk you through it on a quick call. wednesday afternoon work?',
      stage: 'call_proposal'
    },
    {
      sender: 'LEAD',
      text: "yeah let's do it. wednesday wfm",
      stage: 'booking'
    },
    {
      sender: 'CLOSER',
      text: "perfect — drop me your best email and i'll send the calendar invite",
      stage: 'booking'
    },
    {
      sender: 'LEAD',
      text: 'ricky.synth@example.com',
      stage: 'booking'
    },
    {
      sender: 'CLOSER',
      text: 'sent. see you wed at 2pm EST 🤝',
      stage: 'post_booking_confirmation'
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────
// Conversation 2 — Price objection, lead can't justify investment
// ─────────────────────────────────────────────────────────────────────
const convo2: SeedConversation = {
  leadIdentifier: 'synthetic_lead_jamie_002',
  outcomeLabel: 'OBJECTION_LOST',
  messages: [
    {
      sender: 'LEAD',
      text: 'hey, been watching your content. interested in the program',
      stage: 'intro'
    },
    {
      sender: 'CLOSER',
      text: "appreciate it. what's your business doing right now?",
      stage: 'qualification'
    },
    {
      sender: 'LEAD',
      text: 'i sell digital products, ~5k/mo, want to scale',
      stage: 'qualification'
    },
    {
      sender: 'CLOSER',
      text: "got it. what's the bottleneck — traffic, conversion, or pricing?",
      stage: 'qualification'
    },
    {
      sender: 'LEAD',
      text: 'conversion mostly. people add to cart and bail',
      stage: 'qualification'
    },
    {
      sender: 'CLOSER',
      text: "yeah classic 5k stuck point. we'd unblock that in week 1-2. program is 8.5k for 12 weeks 1on1",
      stage: 'call_proposal'
    },
    {
      sender: 'LEAD',
      text: "yeah that's way out of my budget right now",
      stage: 'objection_handling'
    },
    {
      sender: 'CLOSER',
      text: 'i hear you. we also have a group format at 3.5k. would that be more workable?',
      stage: 'objection_handling'
    },
    {
      sender: 'LEAD',
      text: 'honestly still a stretch. need to think on it',
      stage: 'objection_handling'
    },
    {
      sender: 'CLOSER',
      text: "totally fair — no rush. happy to keep in touch when timing's right",
      stage: 'objection_handling'
    }
  ]
};

// ─────────────────────────────────────────────────────────────────────
// Conversation 3 — Ghosted after soft pitch
// ─────────────────────────────────────────────────────────────────────
const convo3: SeedConversation = {
  leadIdentifier: 'synthetic_lead_alex_003',
  outcomeLabel: 'GHOSTED',
  messages: [
    {
      sender: 'LEAD',
      text: 'hey, you taking new clients?',
      stage: 'intro'
    },
    {
      sender: 'CLOSER',
      text: "yeah — what's your business doing now?",
      stage: 'qualification'
    },
    {
      sender: 'LEAD',
      text: 'running an agency, 18k/mo',
      stage: 'qualification'
    },
    {
      sender: 'CLOSER',
      text: 'nice. what would 50k/mo look like for you?',
      stage: 'education'
    },
    {
      sender: 'LEAD',
      text: 'freedom from delivery basically',
      stage: 'education'
    },
    {
      sender: 'CLOSER',
      text: "got it. our program's built around exactly that. wanna jump on a 20 min call to map it out?",
      stage: 'call_proposal'
    }
    // (no further response — lead ghosted)
  ]
};

const CONVERSATIONS: SeedConversation[] = [convo1, convo2, convo3];

function hashOf(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildConversationContentHash(c: SeedConversation): string {
  const concat = c.messages.map((m) => `${m.sender}:${m.text}`).join('\n');
  return hashOf(`${c.leadIdentifier}|${c.outcomeLabel}|${concat}`);
}

async function main() {
  console.log('[seed-training] Starting…');

  const account = await prisma.account.findUnique({
    where: { id: ACCOUNT_ID },
    select: { id: true, name: true }
  });
  if (!account) throw new Error(`Account ${ACCOUNT_ID} not found`);

  const persona = await prisma.aIPersona.findUnique({
    where: { id: PERSONA_ID },
    select: { id: true, accountId: true, isActive: true }
  });
  if (!persona) throw new Error(`Persona ${PERSONA_ID} not found`);
  if (persona.accountId !== ACCOUNT_ID) {
    throw new Error(`Persona ${PERSONA_ID} does not belong to ${ACCOUNT_ID}`);
  }

  console.log(
    `[seed-training] Account: ${account.name} (${account.id})  Persona: ${persona.id} active=${persona.isActive}`
  );

  // ── TrainingUpload (idempotent via accountId+fileHash unique) ──
  const fileName = 'dev-seed-shazim-training-2026-05-18.json';
  const fileHash = hashOf(
    `${ACCOUNT_ID}|${fileName}|${CONVERSATIONS.length}|v1`
  );

  let upload = await prisma.trainingUpload.findUnique({
    where: { accountId_fileHash: { accountId: ACCOUNT_ID, fileHash } }
  });
  if (!upload) {
    upload = await prisma.trainingUpload.create({
      data: {
        accountId: ACCOUNT_ID,
        personaId: PERSONA_ID,
        fileName,
        fileHash,
        blobUrl: 'dev://seed-shazim-training-data.ts',
        status: 'COMPLETE',
        conversationCount: CONVERSATIONS.length
      }
    });
    console.log(`[seed-training] Created TrainingUpload ${upload.id}`);
  } else {
    console.log(`[seed-training] Reusing TrainingUpload ${upload.id}`);
  }

  // ── TrainingConversations + TrainingMessages ──
  let createdConvos = 0;
  let createdMsgs = 0;

  for (const c of CONVERSATIONS) {
    const contentHash = buildConversationContentHash(c);
    const existing = await prisma.trainingConversation.findUnique({
      where: {
        accountId_contentHash: { accountId: ACCOUNT_ID, contentHash }
      }
    });
    if (existing) {
      console.log(
        `[seed-training] Skipping ${c.leadIdentifier} (already seeded as ${existing.id})`
      );
      continue;
    }

    const leadMsgCount = c.messages.filter((m) => m.sender === 'LEAD').length;
    const closerMsgCount = c.messages.filter(
      (m) => m.sender === 'CLOSER'
    ).length;

    const now = new Date();
    const created = await prisma.trainingConversation.create({
      data: {
        uploadId: upload.id,
        accountId: ACCOUNT_ID,
        personaId: PERSONA_ID,
        leadIdentifier: c.leadIdentifier,
        outcomeLabel: c.outcomeLabel,
        contentHash,
        messageCount: c.messages.length,
        closerMessageCount: closerMsgCount,
        leadMessageCount: leadMsgCount,
        voiceNoteCount: 0,
        startedAt: now,
        endedAt: now,
        messages: {
          createMany: {
            data: c.messages.map((m, idx) => ({
              sender: m.sender,
              text: m.text,
              messageType: m.messageType ?? 'TEXT',
              stage: m.stage,
              orderIndex: idx,
              timestamp: new Date(now.getTime() + idx * 60 * 1000)
            }))
          }
        }
      },
      select: { id: true }
    });

    createdConvos++;
    createdMsgs += c.messages.length;
    console.log(
      `[seed-training] Created TrainingConversation ${created.id} (${c.outcomeLabel}, ${c.messages.length} msgs)`
    );
  }

  // ── Summary ──
  const totalConvos = await prisma.trainingConversation.count({
    where: { accountId: ACCOUNT_ID }
  });
  const totalMsgs = await prisma.trainingMessage.count({
    where: { conversation: { accountId: ACCOUNT_ID } }
  });

  console.log(
    `\n[seed-training] DONE. Newly created: ${createdConvos} convos / ${createdMsgs} msgs.  Total now on account: ${totalConvos} convos / ${totalMsgs} msgs.`
  );
}

main()
  .catch((err) => {
    console.error('[seed-training] FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
