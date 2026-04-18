/**
 * Diagnostic: Phase 1 training signal accumulation on daetradez
 * Run: npx tsx scripts/diag-training-signal.ts
 *
 * Answers the 10 questions about AISuggestion / Message training fields.
 * Schema note: the AISuggestion model field is `generatedDuringTrainingPhase`
 * (not `loggedDuringTrainingPhase`). Message has `loggedDuringTrainingPhase`.
 * Both are reported for Q5.
 */
import prisma from '../src/lib/prisma';

async function main() {
  const now = Date.now();
  const last24h = new Date(now - 24 * 3600 * 1000);

  // Resolve daetradez account
  const account = await prisma.account.findFirst({
    where: {
      OR: [
        { name: { contains: 'daetrad', mode: 'insensitive' } },
        { slug: { contains: 'daetrad', mode: 'insensitive' } }
      ]
    },
    select: {
      id: true,
      name: true,
      slug: true,
      trainingPhase: true,
      trainingPhaseStartedAt: true,
      trainingPhaseCompletedAt: true,
      trainingOverrideCount: true,
      trainingTargetOverrideCount: true
    }
  });
  if (!account) {
    console.error('Could not find daetradez account.');
    process.exit(1);
  }
  console.log(`Account: ${account.name} (${account.id})`);
  console.log(`Cutoff for "last 24h": ${last24h.toISOString()}\n`);

  const accountId = account.id;
  const inLast24h = { gte: last24h };

  // ── Q1–Q4: AISuggestion counts, last 24h ─────────────────────────
  const [
    q1TotalSuggestions,
    q2Selected,
    q3Rejected,
    q4Edited,
    q5GeneratedDuringTraining24h,
    q5GeneratedDuringTrainingAllTime
  ] = await Promise.all([
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: inLast24h }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: inLast24h, wasSelected: true }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: inLast24h, wasRejected: true }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedAt: inLast24h, wasEdited: true }
    }),
    prisma.aISuggestion.count({
      where: {
        accountId,
        generatedAt: inLast24h,
        generatedDuringTrainingPhase: true
      }
    }),
    prisma.aISuggestion.count({
      where: { accountId, generatedDuringTrainingPhase: true }
    })
  ]);

  // Q5 also applies to Messages (the field name there is
  // loggedDuringTrainingPhase). Surface both for completeness.
  const [q5MsgLogged24h, q5MsgLoggedAllTime] = await Promise.all([
    prisma.message.count({
      where: {
        conversation: { lead: { accountId } },
        timestamp: inLast24h,
        loggedDuringTrainingPhase: true
      }
    }),
    prisma.message.count({
      where: {
        conversation: { lead: { accountId } },
        loggedDuringTrainingPhase: true
      }
    })
  ]);

  // ── Q6: Messages with humanOverrideNote populated ────────────────
  const [q6With24h, q6WithAllTime] = await Promise.all([
    prisma.message.count({
      where: {
        conversation: { lead: { accountId } },
        timestamp: inLast24h,
        humanOverrideNote: { not: null }
      }
    }),
    prisma.message.count({
      where: {
        conversation: { lead: { accountId } },
        humanOverrideNote: { not: null }
      }
    })
  ]);

  // ── Q9: Rejected suggestions linked to isHumanOverride=true Message
  const rejectedSuggestions = await prisma.aISuggestion.findMany({
    where: { accountId, generatedAt: inLast24h, wasRejected: true },
    select: {
      id: true,
      generatedAt: true,
      rejectedByMessages: {
        select: { id: true, isHumanOverride: true, timestamp: true }
      }
    }
  });
  const q9TotalRejected = rejectedSuggestions.length;
  const q9WithHumanOverrideMsg = rejectedSuggestions.filter((s) =>
    s.rejectedByMessages.some((m) => m.isHumanOverride === true)
  ).length;
  const q9MissingLink = rejectedSuggestions.filter(
    (s) => s.rejectedByMessages.length === 0
  ).length;

  // ── Q10: Median time-to-rejection (generatedAt → override Message.timestamp)
  const deltasMs: number[] = [];
  for (const s of rejectedSuggestions) {
    // Pair with the earliest human-override message for this suggestion.
    const firstOverride = s.rejectedByMessages
      .filter((m) => m.isHumanOverride && m.timestamp)
      .sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime())[0];
    if (firstOverride?.timestamp) {
      deltasMs.push(
        firstOverride.timestamp.getTime() - s.generatedAt.getTime()
      );
    }
  }
  deltasMs.sort((a, b) => a - b);
  const medianMs =
    deltasMs.length === 0
      ? null
      : deltasMs.length % 2 === 1
        ? deltasMs[(deltasMs.length - 1) / 2]
        : (deltasMs[deltasMs.length / 2 - 1] + deltasMs[deltasMs.length / 2]) /
          2;
  const minMs = deltasMs[0] ?? null;
  const maxMs = deltasMs[deltasMs.length - 1] ?? null;
  const fmt = (ms: number | null) =>
    ms === null
      ? 'n/a'
      : ms < 60_000
        ? `${Math.round(ms / 1000)}s`
        : ms < 3_600_000
          ? `${(ms / 60_000).toFixed(1)}m`
          : `${(ms / 3_600_000).toFixed(2)}h`;

  // ── Report ───────────────────────────────────────────────────────
  console.log('=== PHASE 1 TRAINING SIGNAL (daetradez, last 24h) ===\n');
  console.log(
    `Q1. AISuggestion rows created (last 24h):           ${q1TotalSuggestions}`
  );
  console.log(
    `Q2.   wasSelected=true  (AI auto-sent):             ${q2Selected}`
  );
  console.log(
    `Q3.   wasRejected=true  (human overrode):           ${q3Rejected}`
  );
  console.log(
    `Q4.   wasEdited=true    (human took draft + edit):  ${q4Edited}`
  );
  const q1Other = q1TotalSuggestions - q2Selected - q3Rejected - q4Edited;
  console.log(`      (pending / no outcome yet):                   ${q1Other}`);
  console.log('');
  console.log(
    `Q5a. AISuggestion generatedDuringTrainingPhase=true (24h): ${q5GeneratedDuringTraining24h}`
  );
  console.log(
    `Q5b. AISuggestion generatedDuringTrainingPhase=true (all): ${q5GeneratedDuringTrainingAllTime}`
  );
  console.log(
    `Q5c. Message.loggedDuringTrainingPhase=true (24h):         ${q5MsgLogged24h}`
  );
  console.log(
    `Q5d. Message.loggedDuringTrainingPhase=true (all):         ${q5MsgLoggedAllTime}`
  );
  console.log('');
  console.log(
    `Q6a. Messages w/ humanOverrideNote populated (24h): ${q6With24h}`
  );
  console.log(
    `Q6b. Messages w/ humanOverrideNote populated (all): ${q6WithAllTime}`
  );
  console.log('');
  console.log(
    `Q7.  Account.trainingOverrideCount:         ${account.trainingOverrideCount} / ${account.trainingTargetOverrideCount}`
  );
  console.log(
    `Q8.  Account.trainingPhase:                 ${account.trainingPhase}`
  );
  console.log(
    `     trainingPhaseStartedAt:                ${account.trainingPhaseStartedAt?.toISOString()}`
  );
  console.log(
    `     trainingPhaseCompletedAt:              ${account.trainingPhaseCompletedAt?.toISOString() ?? '(not completed)'}`
  );
  console.log('');
  console.log('=== SANITY CHECK (Q9) ===');
  console.log(
    `Q9a. wasRejected=true AISuggestions (24h):                        ${q9TotalRejected}`
  );
  console.log(
    `Q9b.   ...linked to a Message with isHumanOverride=true:          ${q9WithHumanOverrideMsg}`
  );
  console.log(
    `Q9c.   ...with NO rejectedByMessages link at all:                 ${q9MissingLink}`
  );
  console.log(
    `Q9d.   ...linked but NOT flagged isHumanOverride=true (leak):     ${q9TotalRejected - q9WithHumanOverrideMsg - q9MissingLink}`
  );
  console.log('');
  console.log('=== TIME-TO-REJECTION (Q10) ===');
  console.log(
    `Q10a. Samples (rejected with override msg):  ${deltasMs.length}`
  );
  console.log(`Q10b. Median time-to-rejection:              ${fmt(medianMs)}`);
  console.log(`      Min:                                   ${fmt(minMs)}`);
  console.log(`      Max:                                   ${fmt(maxMs)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
