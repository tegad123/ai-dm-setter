/* eslint-disable no-console */
// Dani Yung — AI went silent after the lead answered "This coming week"
// to the urgency question. Pull conversation flags + recent state to
// pinpoint which path silenced the AI.
//
// Usage: npx tsx scripts/diag-dani-yung.ts

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

async function main() {
  const lead = await prisma.lead.findFirst({
    where: {
      OR: [
        { name: { contains: 'dani yung', mode: 'insensitive' } },
        { name: { contains: 'daniyung', mode: 'insensitive' } },
        { handle: { contains: 'dani', mode: 'insensitive' } }
      ]
    },
    include: {
      conversation: {
        include: {
          messages: { orderBy: { timestamp: 'asc' } }
        }
      },
      account: {
        select: {
          id: true,
          name: true,
          awayMode: true,
          notificationEmail: true
        }
      }
    }
  });

  if (!lead || !lead.conversation) {
    console.error(
      'No matching Dani Yung lead found. Try widening the name filter.'
    );
    process.exit(1);
  }

  const c = lead.conversation;
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Lead: ${lead.name} (@${lead.handle})`);
  console.log(`  platform=${lead.platform} platformUserId=${lead.platformUserId}`);
  console.log(`  stage=${lead.stage} status=${lead.status}`);
  console.log(`  leadId=${lead.id} accountId=${lead.accountId}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`Account: ${lead.account?.name}`);
  console.log(`  awayMode=${lead.account?.awayMode}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`Conversation: ${c.id}`);
  console.log(`  aiActive=${c.aiActive}`);
  console.log(`  outcome=${c.outcome}`);
  console.log(`  source=${c.source}`);
  console.log(`  autoSendOverride=${c.autoSendOverride}`);
  console.log(`  lastMessageAt=${c.lastMessageAt?.toISOString() ?? '—'}`);
  console.log(`  unreadCount=${c.unreadCount}`);
  console.log('  ── safety flags ──');
  console.log(`  distressDetected=${c.distressDetected} at=${c.distressDetectedAt?.toISOString() ?? '—'} msgId=${c.distressMessageId ?? '—'}`);
  console.log(`  schedulingConflict=${c.schedulingConflict} at=${c.schedulingConflictAt?.toISOString() ?? '—'} pref=${c.schedulingConflictPreference ?? '—'}`);
  console.log(`  typeformFilledNoBooking=${c.typeformFilledNoBooking}`);
  console.log(`  geographyGated=${c.geographyGated} country=${c.geographyCountry ?? '—'}`);
  console.log('───────────────────────────────────────────────────────────');

  console.log(`\n── Last 25 messages (oldest → newest) ──`);
  const recent = c.messages.slice(-25);
  for (const m of recent) {
    console.log(
      `${m.timestamp.toISOString()} ${m.sender.padEnd(6)} ` +
        `humanSrc=${(m.humanSource ?? '—').padEnd(8)} ` +
        `mid=${(m.platformMessageId ?? '—').slice(0, 22).padEnd(22)} ` +
        `"${m.content.slice(0, 90).replace(/\n/g, ' ')}"`
    );
  }

  // ── ScheduledReply rows for this conversation ───────────────────
  const scheduled = await prisma.scheduledReply.findMany({
    where: { conversationId: c.id },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log(`\n── ScheduledReply rows (${scheduled.length}, newest first) ──`);
  for (const s of scheduled) {
    console.log(
      `${s.createdAt.toISOString()} status=${s.status} ` +
        `scheduledFor=${s.scheduledFor.toISOString()} ` +
        `processedAt=${s.processedAt?.toISOString() ?? '—'} ` +
        `attempts=${s.attempts ?? '—'} ` +
        `error="${(s.error ?? '').slice(0, 80)}"`
    );
  }

  // ── ScheduledMessage rows (follow-up sequence uses this) ────────
  try {
    const sm = await prisma.scheduledMessage.findMany({
      where: { conversationId: c.id },
      orderBy: { createdAt: 'desc' },
      take: 10
    });
    console.log(`\n── ScheduledMessage rows (${sm.length}, newest first) ──`);
    for (const s of sm) {
      console.log(
        `${s.createdAt.toISOString()} status=${s.status} ` +
          `scheduledFor=${s.scheduledFor.toISOString()} ` +
          `kind=${(s as any).kind ?? '—'} ` +
          `processedAt=${s.processedAt?.toISOString() ?? '—'}`
      );
    }
  } catch (e) {
    console.log('(ScheduledMessage table not present or shape mismatch)');
  }

  // ── Notifications in the last 7 days ────────────────────────────
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const notifs = await prisma.notification.findMany({
    where: {
      accountId: lead.accountId,
      createdAt: { gte: since },
      OR: [
        { details: { contains: lead.id } },
        { body: { contains: lead.name ?? '' } },
        { title: { contains: lead.name ?? '' } }
      ]
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  console.log(`\n── Notification rows for this lead (last 7d, ${notifs.length}) ──`);
  for (const n of notifs) {
    console.log(
      `${n.createdAt.toISOString()} type=${n.type} title="${(n.title ?? '').slice(0, 70)}"`
    );
  }

  // ── LeadStageTransition rows (audit trail) ──────────────────────
  const transitions = await prisma.leadStageTransition.findMany({
    where: { leadId: lead.id },
    orderBy: { transitionedAt: 'desc' },
    take: 10
  });
  console.log(`\n── LeadStageTransition rows (${transitions.length}, newest first) ──`);
  for (const t of transitions) {
    console.log(
      `${t.transitionedAt.toISOString()} ${t.fromStage ?? '—'} → ${t.toStage} ` +
        `reason="${(t.reason ?? '').slice(0, 60)}" trigger=${t.triggeredBy ?? '—'}`
    );
  }

  // ── AISuggestion rows around the silence ────────────────────────
  const lastLeadMsg = [...c.messages].reverse().find((m) => m.sender === 'LEAD');
  if (lastLeadMsg) {
    const sugs = await prisma.aISuggestion.findMany({
      where: {
        conversationId: c.id,
        generatedAt: { gte: new Date(lastLeadMsg.timestamp.getTime() - 60_000) }
      },
      orderBy: { generatedAt: 'asc' }
    });
    console.log(
      `\n── AISuggestion rows generated AFTER last lead msg (${sugs.length}) ──`
    );
    console.log(`Last lead msg: ${lastLeadMsg.timestamp.toISOString()} "${lastLeadMsg.content.slice(0, 70)}"`);
    for (const s of sugs) {
      const preview = (s.responseText || '').slice(0, 90).replace(/\n/g, ' ');
      console.log(
        `${s.generatedAt.toISOString()} q=${(s.qualityGateScore ?? 0).toFixed(2)} ` +
          `model=${(s.modelUsed ?? '—').padEnd(20)} ` +
          `selected=${s.wasSelected} rejected=${s.wasRejected} ` +
          `"${preview}"`
      );
    }
    if (sugs.length === 0) {
      console.log(
        '⚠️  ZERO AISuggestion rows after the last lead message. ' +
          'AI generation never even started — webhook likely never fired, ' +
          'or aiActive flipped off BEFORE generation.'
      );
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Diagnosis cheat sheet:');
  console.log('  • aiActive=false + distressDetected=true  → distress-detector fired');
  console.log('  • aiActive=false + schedulingConflict=true → scheduling-conflict path');
  console.log('  • aiActive=false + typeformFilledNoBooking=true → typeform soft exit');
  console.log('  • aiActive=false + geographyGated=true    → geo gate fired');
  console.log('  • aiActive=false + outcome=SOFT_EXIT      → soft-exit classifier');
  console.log('  • aiActive=true + 0 AISuggestion + 0 ScheduledReply');
  console.log('      → webhook never fired (check vercel logs for the platform)');
  console.log('  • aiActive=true + ScheduledReply.status=PENDING (older than ~5 min)');
  console.log('      → cron not picking up; check /api/cron/process-scheduled-replies');
  console.log('  • aiActive=true + ScheduledReply.status=FAILED + error message');
  console.log('      → AI generation or send failed; error column has details');
  console.log('═══════════════════════════════════════════════════════════');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
