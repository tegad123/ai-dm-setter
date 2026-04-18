/**
 * Diagnostic: What is Daniel actually DOING with his AI (last 7 days)?
 *
 * Fixes 1–3 unlocked the pipeline (reset to ONBOARDING, counter always
 * increments, note UX is inline). But we still don't know WHY the
 * override rate is so low. Three hypotheses:
 *
 *   (A) Delegated: AI sends most messages; Daniel rarely intervenes.
 *       → More training data isn't the answer — AI is already trusted.
 *
 *   (B) Unaware: Daniel messages a lot, but NOT through the override
 *       flow. Typically this means aiActive is off, OR he sends before
 *       an AISuggestion gets generated. Either way, the 2-hour-link
 *       logic in webhook-processor.ts never fires → no signal.
 *
 *   (C) Babysitting: Lots of aiActive=false conversations. Daniel
 *       doesn't trust AI → takes over before it can suggest anything.
 *       Same result as (B) — no AISuggestion to link to — but a
 *       different product fix (trust / quality, not UX).
 *
 * Also reports: first-intervention index (how many AI messages before
 * human jumps in), linked vs unlinked override ratio, and which users
 * are sending HUMAN messages (Daniel himself vs team members).
 *
 * Run: npx tsx scripts/diag-daniel-behavior.ts
 */
import prisma from '../src/lib/prisma';

async function main() {
  const now = Date.now();
  const last7d = new Date(now - 7 * 24 * 3600 * 1000);

  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { name: { contains: 'daetrad', mode: 'insensitive' } },
        { slug: { contains: 'daetrad', mode: 'insensitive' } }
      ]
    },
    select: { id: true, name: true, trainingPhase: true }
  });
  if (!account) {
    console.error('Could not find daetradez account.');
    process.exit(1);
  }
  const accountId = account.id;
  console.log(`Account: ${account.name} (${accountId})`);
  console.log(`Phase:   ${account.trainingPhase}`);
  console.log(`Window:  last 7 days (>= ${last7d.toISOString()})\n`);

  const window = { gte: last7d };
  const convoScope = { lead: { accountId } };

  // ── 1. Message volume by sender ─────────────────────────────────
  const [aiCount, humanCount, leadCount] = await Promise.all([
    prisma.message.count({
      where: { conversation: convoScope, sender: 'AI', timestamp: window }
    }),
    prisma.message.count({
      where: { conversation: convoScope, sender: 'HUMAN', timestamp: window }
    }),
    prisma.message.count({
      where: { conversation: convoScope, sender: 'LEAD', timestamp: window }
    })
  ]);
  const totalMsgs = aiCount + humanCount + leadCount;
  const pct = (n: number) =>
    totalMsgs === 0 ? '0.0%' : `${((n / totalMsgs) * 100).toFixed(1)}%`;

  // ── 2. Conversation-level aiActive state ────────────────────────
  const allConvos = await prisma.conversation.findMany({
    where: {
      ...convoScope,
      lastMessageAt: window
    },
    select: {
      id: true,
      aiActive: true,
      lastMessageAt: true,
      messages: {
        where: { timestamp: window },
        select: {
          sender: true,
          timestamp: true,
          isHumanOverride: true,
          rejectedAISuggestionId: true,
          sentByUserId: true
        },
        orderBy: { timestamp: 'asc' }
      }
    }
  });

  const activeCount = allConvos.length;
  const aiActiveOn = allConvos.filter((c) => c.aiActive).length;
  const aiActiveOff = allConvos.filter((c) => !c.aiActive).length;

  // ── 3. Per-conversation classification ──────────────────────────
  // AI-only:        only AI + LEAD msgs, no HUMAN
  // Human-only:     only HUMAN + LEAD msgs, no AI (aiActive was off)
  // Mixed-early:    HUMAN stepped in before AI sent 3+ msgs
  // Mixed-late:     HUMAN stepped in after AI sent 3+ msgs
  let aiOnly = 0;
  let humanOnly = 0;
  let mixedEarly = 0;
  let mixedLate = 0;
  const firstInterventionIndexes: number[] = [];

  for (const c of allConvos) {
    const hasAI = c.messages.some((m) => m.sender === 'AI');
    const hasHuman = c.messages.some((m) => m.sender === 'HUMAN');
    if (hasAI && !hasHuman) aiOnly++;
    else if (!hasAI && hasHuman) humanOnly++;
    else if (hasAI && hasHuman) {
      // How many AI msgs preceded the first HUMAN msg?
      let aiSoFar = 0;
      let idx = 0;
      for (const m of c.messages) {
        if (m.sender === 'AI') aiSoFar++;
        if (m.sender === 'HUMAN') {
          firstInterventionIndexes.push(aiSoFar);
          idx = aiSoFar;
          break;
        }
      }
      if (idx < 3) mixedEarly++;
      else mixedLate++;
    }
  }

  const sortedIdx = [...firstInterventionIndexes].sort((a, b) => a - b);
  const median = sortedIdx.length
    ? sortedIdx[Math.floor(sortedIdx.length / 2)]
    : null;

  // ── 4. Override linkage ─────────────────────────────────────────
  // HUMAN messages with rejectedAISuggestionId = linked (signal captured)
  // HUMAN messages without = unlinked (no AISuggestion within 2h → no signal)
  const [linkedOverrides, unlinkedHumanMsgs] = await Promise.all([
    prisma.message.count({
      where: {
        conversation: convoScope,
        sender: 'HUMAN',
        timestamp: window,
        isHumanOverride: true
      }
    }),
    prisma.message.count({
      where: {
        conversation: convoScope,
        sender: 'HUMAN',
        timestamp: window,
        isHumanOverride: false
      }
    })
  ]);

  // ── 5. AISuggestion funnel ──────────────────────────────────────
  const [sugTotal, sugSelected, sugRejected, sugPending] = await Promise.all([
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: window }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: window, wasSelected: true }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: window, wasRejected: true }
    }),
    prisma.aISuggestion.count({
      where: {
        accountId,
        generatedAt: window,
        wasSelected: false,
        wasRejected: false
      }
    })
  ]);

  // ── 6. Who is sending HUMAN messages? (Daniel or team?) ─────────
  const senders = await prisma.message.groupBy({
    by: ['sentByUserId'],
    where: {
      conversation: convoScope,
      sender: 'HUMAN',
      timestamp: window
    },
    _count: { _all: true }
  });
  const senderIds = senders
    .map((s) => s.sentByUserId)
    .filter(Boolean) as string[];
  const senderUsers =
    senderIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: { id: true, email: true, name: true, role: true }
        })
      : [];
  const userById = new Map(senderUsers.map((u) => [u.id, u]));

  // ── Report ──────────────────────────────────────────────────────
  console.log('=== MESSAGE VOLUME (last 7d) ===');
  console.log(`  AI:     ${aiCount.toString().padStart(5)} (${pct(aiCount)})`);
  console.log(
    `  HUMAN:  ${humanCount.toString().padStart(5)} (${pct(humanCount)})`
  );
  console.log(
    `  LEAD:   ${leadCount.toString().padStart(5)} (${pct(leadCount)})`
  );
  console.log(`  Total:  ${totalMsgs}`);
  console.log('');
  console.log('=== CONVERSATION STATE (active in last 7d) ===');
  console.log(`  Total active:           ${activeCount}`);
  console.log(`  aiActive=true:          ${aiActiveOn}`);
  console.log(`  aiActive=false:         ${aiActiveOff}  ← human took over`);
  console.log('');
  console.log('=== CONVERSATION PATTERN ===');
  console.log(`  AI-only (no human):     ${aiOnly}`);
  console.log(
    `  Human-only (no AI):     ${humanOnly}  ← AI never got a chance`
  );
  console.log(
    `  Mixed, early takeover:  ${mixedEarly}  (<3 AI msgs before human)`
  );
  console.log(
    `  Mixed, late takeover:   ${mixedLate}  (3+ AI msgs before human)`
  );
  console.log(
    `  Median AI msgs before human intervenes: ${median ?? 'n/a'} (${firstInterventionIndexes.length} samples)`
  );
  console.log('');
  console.log('=== OVERRIDE LINKAGE ===');
  console.log(`  HUMAN msgs total:                 ${humanCount}`);
  console.log(
    `    ├─ linked to AISuggestion:      ${linkedOverrides}  (captured as training signal)`
  );
  console.log(
    `    └─ unlinked (no suggestion):    ${unlinkedHumanMsgs}  ← lost signal`
  );
  const linkedPct =
    humanCount === 0
      ? '0.0%'
      : `${((linkedOverrides / humanCount) * 100).toFixed(1)}%`;
  console.log(`  Linkage rate: ${linkedPct}`);
  console.log('');
  console.log('=== AI SUGGESTION FUNNEL ===');
  console.log(`  Generated:       ${sugTotal}`);
  console.log(`    wasSelected:   ${sugSelected}  (AI auto-sent)`);
  console.log(`    wasRejected:   ${sugRejected}  (human overrode)`);
  console.log(
    `    pending:       ${sugPending}  (neither flag — lead hasn't replied yet, or signal lost)`
  );
  console.log('');
  console.log('=== HUMAN SENDERS ===');
  if (senders.length === 0) {
    console.log('  (no HUMAN messages in window)');
  } else {
    for (const s of senders) {
      const u = s.sentByUserId ? userById.get(s.sentByUserId) : null;
      const label = u
        ? `${u.name || u.email} (${u.role})`
        : '(no sentByUserId)';
      console.log(`  ${label}: ${s._count._all}`);
    }
  }
  console.log('');

  // ── Diagnosis ───────────────────────────────────────────────────
  console.log('=== DIAGNOSIS ===');
  const humanPct = totalMsgs === 0 ? 0 : humanCount / totalMsgs;
  const linkedRate = humanCount === 0 ? 0 : linkedOverrides / humanCount;
  const aiOffPct = activeCount === 0 ? 0 : aiActiveOff / activeCount;
  const humanWithoutUserId =
    senders.find((s) => s.sentByUserId === null)?._count._all ?? 0;
  const viaWebhookPct = humanCount === 0 ? 0 : humanWithoutUserId / humanCount;

  const hypotheses: string[] = [];

  // (D) — new hypothesis prompted by the daetradez finding: all HUMAN
  // msgs have no sentByUserId, meaning they came through the Instagram
  // webhook (Daniel typing on the IG app), not through the dashboard
  // send flow. Dashboard UX fixes can't reach him in that mode. This
  // is the dominant failure mode in practice and belongs first.
  if (viaWebhookPct > 0.8 && humanCount > 20) {
    hypotheses.push(
      '(D) OFF-PLATFORM: ' +
        `${humanWithoutUserId}/${humanCount} HUMAN msgs (${(viaWebhookPct * 100).toFixed(0)}%) ` +
        'have no sentByUserId — they arrived via the Instagram/Facebook ' +
        'webhook, not the dashboard. Daniel is replying from the IG/FB app ' +
        "on his phone. Dashboard UX fixes (Fix 3) don't reach him. Options: " +
        '(1) talk to Daniel about why he bypasses the dashboard, ' +
        '(2) retroactively generate a shadow AISuggestion for webhook HUMAN ' +
        'messages in AI-on threads so the compare-and-learn loop still runs.'
    );
  }
  if (humanPct < 0.05 && aiOffPct < 0.1) {
    hypotheses.push(
      '(A) DELEGATED: AI sends almost everything, few aiActive=off conversations. ' +
        'Daniel trusts the AI — training signal is low because he rarely overrides. ' +
        "Fix: none needed on UX side; training can't be accelerated without more overrides."
    );
  }
  if (humanPct > 0.1 && linkedRate < 0.3) {
    hypotheses.push(
      '(B) UNAWARE: Lots of HUMAN messages but most are NOT linked to a recent ' +
        'AISuggestion. Daniel is messaging directly, bypassing the AI (no ' +
        'suggestion to reject). Fix: widen the 2h window, or auto-generate an ' +
        'AISuggestion retroactively when Daniel types into an active thread.'
    );
  }
  if (aiOffPct > 0.25) {
    hypotheses.push(
      '(C) BABYSITTING: 25%+ of active conversations have aiActive=false. Daniel ' +
        'toggles AI off and handles leads manually. Overrides never happen because ' +
        "there's no AI message to override. Fix: trust / quality problem. Find out " +
        'why he flips AI off and address the root cause.'
    );
  }
  if (hypotheses.length === 0) {
    hypotheses.push(
      'No dominant pattern — numbers in a gray zone. Suggest manual review of a ' +
        'handful of recent conversations to see the qualitative story.'
    );
  }
  for (const h of hypotheses) console.log(`  - ${h}`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
