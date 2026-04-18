/**
 * backfill-booking-link-leaks.ts
 * ---------------------------------------------------------------------------
 * One-shot remediation for the 2026-04-18 [BOOKING LINK] placeholder leak on
 * daetradez. Takes the 7 known affected conversation IDs, plus a fresh sweep
 * of any daetradez conversation in the last 48h that has an AI message
 * containing a bracketed placeholder, and:
 *
 *   1. Sets `aiActive = false` on any such conversation that is still active
 *      AND had lead activity in the last 24h (highest risk of the bug firing
 *      again before Vercel finishes deploying the fix).
 *   2. Produces a punch list the human operator can work from — one line per
 *      affected conversation with lead name/handle, last lead message time,
 *      the bad AI message excerpt, and the recommended next action.
 *
 * Run: npx tsx scripts/backfill-booking-link-leaks.ts
 * Dry-run: npx tsx scripts/backfill-booking-link-leaks.ts --dry-run
 */
import prisma from '../src/lib/prisma';

const KNOWN_AFFECTED_CONVO_IDS = [
  'cmo3vpv8q0025kv04bwmaxdkj',
  'cmo3uje70000zjr04bgltfc7y',
  'cmo3wibqh005wkv049euq2p3o',
  'cmo40djn60067l204dikpt79o',
  'cmo45edz50002la04yz7mo77p',
  'cmo413zoe000gl2040yibvj2i', // Antipas Kash
  'cmo3kook2000ejr041nqjrret'
];

const BAD_PATTERNS = [
  '[BOOKING LINK]',
  '[APPLICATION LINK]',
  '[HOMEWORK LINK]',
  '[LINK]',
  '[CALENDAR LINK]',
  '[URL]',
  '[RESULTS VIDEO]',
  '[YT VIDEO]',
  '[HOMEWORK PAGE]'
];

interface AffectedRow {
  conversationId: string;
  leadName: string | null;
  leadHandle: string | null;
  leadStage: string | null;
  aiActive: boolean;
  lastMessageAt: Date | null;
  lastLeadMessageAt: Date | null;
  offendingAiMessage: {
    id: string;
    timestamp: Date;
    content: string;
    pattern: string;
  } | null;
  action: 'paused_ai' | 'already_paused' | 'inactive_no_change' | 'no_bad_msg';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const now = Date.now();
  const last24h = new Date(now - 24 * 3600 * 1000);
  const last48h = new Date(now - 48 * 3600 * 1000);

  // 1) Resolve daetradez account
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { name: { contains: 'daetrad', mode: 'insensitive' } },
        { slug: { contains: 'daetrad', mode: 'insensitive' } }
      ]
    },
    select: { id: true, name: true, slug: true }
  });

  if (!account) {
    console.error('Could not find daetradez account.');
    process.exit(1);
  }
  console.log(`Account: ${account.name} (${account.id})`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Cutoff for "still active" pause: ${last24h.toISOString()}\n`);

  // 2) Fresh sweep: any AI message in daetradez with a placeholder in the last 48h
  const sweepConvoIds = new Set<string>();
  for (const pat of BAD_PATTERNS) {
    const hits = await prisma.message.findMany({
      where: {
        conversation: { lead: { accountId: account.id } },
        sender: 'AI',
        timestamp: { gte: last48h },
        content: { contains: pat }
      },
      select: { conversationId: true }
    });
    for (const h of hits) sweepConvoIds.add(h.conversationId);
  }

  const combined = new Set<string>(KNOWN_AFFECTED_CONVO_IDS);
  sweepConvoIds.forEach((id) => combined.add(id));
  const allConvoIds = Array.from(combined);

  console.log(
    `Known affected IDs: ${KNOWN_AFFECTED_CONVO_IDS.length}; sweep found: ${sweepConvoIds.size}; unique total: ${allConvoIds.length}\n`
  );

  const rows: AffectedRow[] = [];

  for (const convoId of allConvoIds) {
    const convo = await prisma.conversation.findUnique({
      where: { id: convoId },
      include: {
        lead: {
          select: {
            name: true,
            handle: true,
            stage: true,
            accountId: true
          }
        }
      }
    });

    if (!convo) {
      console.warn(`  [skip] conversation ${convoId} not found`);
      continue;
    }
    if (convo.lead.accountId !== account.id) {
      console.warn(
        `  [skip] conversation ${convoId} is not on daetradez (account ${convo.lead.accountId})`
      );
      continue;
    }

    // Find the most recent offending AI message (any time, not just 48h —
    // we want to see the actual content even if it happened earlier).
    let offendingAiMessage: AffectedRow['offendingAiMessage'] = null;
    for (const pat of BAD_PATTERNS) {
      const hit = await prisma.message.findFirst({
        where: {
          conversationId: convoId,
          sender: 'AI',
          content: { contains: pat }
        },
        orderBy: { timestamp: 'desc' },
        select: { id: true, timestamp: true, content: true }
      });
      if (
        hit &&
        (!offendingAiMessage || hit.timestamp > offendingAiMessage.timestamp)
      ) {
        offendingAiMessage = {
          id: hit.id,
          timestamp: hit.timestamp,
          content: hit.content,
          pattern: pat
        };
      }
    }

    const lastLeadMsg = await prisma.message.findFirst({
      where: { conversationId: convoId, sender: 'LEAD' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true }
    });

    const lastLeadActive = lastLeadMsg && lastLeadMsg.timestamp >= last24h;

    let action: AffectedRow['action'];
    if (!offendingAiMessage) {
      action = 'no_bad_msg';
    } else if (!convo.aiActive) {
      action = 'already_paused';
    } else if (lastLeadActive) {
      action = 'paused_ai';
      if (!dryRun) {
        await prisma.conversation.update({
          where: { id: convoId },
          data: { aiActive: false }
        });
      }
    } else {
      action = 'inactive_no_change';
    }

    rows.push({
      conversationId: convoId,
      leadName: convo.lead.name,
      leadHandle: convo.lead.handle,
      leadStage: convo.lead.stage,
      aiActive: convo.aiActive,
      lastMessageAt: convo.lastMessageAt,
      lastLeadMessageAt: lastLeadMsg?.timestamp || null,
      offendingAiMessage,
      action
    });
  }

  // 3) Print report
  console.log('=== BACKFILL REPORT ===\n');
  const byAction = rows.reduce(
    (acc, r) => {
      acc[r.action] = (acc[r.action] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  console.log('Actions taken:', byAction);
  console.log('');

  // Sorted: paused_ai first (highest urgency), then inactive, then already
  const actionOrder: Record<AffectedRow['action'], number> = {
    paused_ai: 0,
    inactive_no_change: 1,
    already_paused: 2,
    no_bad_msg: 3
  };
  rows.sort((a, b) => actionOrder[a.action] - actionOrder[b.action]);

  for (const row of rows) {
    const actionLabel = {
      paused_ai: dryRun ? 'WOULD PAUSE (dry-run)' : 'PAUSED AI',
      already_paused: 'already paused (no change)',
      inactive_no_change: 'stale — no lead activity in 24h, left AI on',
      no_bad_msg: 'no placeholder msg found (false positive?)'
    }[row.action];

    console.log(
      `[${actionLabel}] ${row.leadName || '<no name>'} (@${row.leadHandle || 'unknown'}) convo=${row.conversationId} stage=${row.leadStage} aiActive=${row.aiActive}`
    );
    if (row.lastLeadMessageAt) {
      console.log(`  last lead msg: ${row.lastLeadMessageAt.toISOString()}`);
    }
    if (row.offendingAiMessage) {
      console.log(
        `  bad AI msg [${row.offendingAiMessage.timestamp.toISOString()}] (${row.offendingAiMessage.pattern}): ${row.offendingAiMessage.content.slice(0, 200)}`
      );
    }
    console.log('');
  }

  // 4) Human operator punch list
  console.log('=== OPERATOR PUNCH LIST ===');
  const needsIntervention = rows.filter(
    (r) => r.action === 'paused_ai' || r.action === 'inactive_no_change'
  );
  if (needsIntervention.length === 0) {
    console.log('  (none — all affected leads already handled)');
  } else {
    console.log(
      'These leads received a placeholder instead of a real URL. Send a manual follow-up with the correct link:'
    );
    for (const r of needsIntervention) {
      console.log(
        `  - ${r.leadName || '<no name>'} @${r.leadHandle || 'unknown'} | stage=${r.leadStage} | convo=${r.conversationId}`
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
