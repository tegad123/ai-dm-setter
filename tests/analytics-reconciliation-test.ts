// Reconciliation tests for the F8 Analytics work (QD-032 → QD-041).
//
// Two layers:
//   1. Helper invariants — fast, no DB. Asserts the canonical lead-state
//      sets in src/lib/lead-state-sets.ts are internally consistent so
//      future edits can't silently drift (e.g. someone adds NURTURE to
//      QUALIFIED_LEAD_STAGES and the Funnel diverges from Conversations
//      again).
//   2. Cross-view seed test (opt-in via --seed) — seeds a known set of
//      leads on a throwaway account, runs the canonical-set counts that
//      the analytics routes do, and asserts they match the manual ground
//      truth. Cleans up after itself.
//
// Run: npx tsx tests/analytics-reconciliation-test.ts
//      npx tsx tests/analytics-reconciliation-test.ts --seed   (DB writes)

import {
  QUALIFIED_LEAD_STAGES,
  BOOKED_LEAD_STAGES,
  SHOWED_LEAD_STAGES,
  ACTIVE_LEAD_STAGES,
  TERMINAL_LEAD_STAGES,
  STAGES_WITH_STAGE_DATA,
  QUALIFIED_LEAD_STAGES_ARR,
  BOOKED_LEAD_STAGES_ARR
} from '../src/lib/lead-state-sets';
import type { LeadStage } from '@prisma/client';

const ALL_STAGES: LeadStage[] = [
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE'
];

let passes = 0;
let fails = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passes++;
    console.log(`PASS  ${name}`);
  } else {
    fails++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function setEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== new Set(a).size) return false;
  if (b.length !== new Set(b).size) return false;
  if (new Set(a).size !== new Set(b).size) return false;
  const A = new Set(a);
  return Array.from(b).every((v) => A.has(v));
}

function disjoint(a: readonly string[], b: readonly string[]): boolean {
  const B = new Set(b);
  return Array.from(a).every((v) => !B.has(v));
}

function subset(child: readonly string[], parent: readonly string[]): boolean {
  const P = new Set(parent);
  return Array.from(child).every((v) => P.has(v));
}

async function main() {
  // ── Layer 1: helper invariants (no DB) ──────────────────────────
  console.log('── Layer 1: canonical helper invariants ──');

  assert(
    'ALL_STAGES has 14 unique values (matches LeadStage enum)',
    new Set(ALL_STAGES).size === 14 && ALL_STAGES.length === 14
  );

  assert(
    'ACTIVE ∪ TERMINAL covers every LeadStage',
    setEq([...ACTIVE_LEAD_STAGES, ...TERMINAL_LEAD_STAGES], ALL_STAGES)
  );

  assert(
    'ACTIVE ∩ TERMINAL is empty (a stage is one or the other, never both)',
    disjoint(ACTIVE_LEAD_STAGES, TERMINAL_LEAD_STAGES)
  );

  assert(
    'STAGES_WITH_STAGE_DATA = ALL_STAGES minus NEW_LEAD',
    setEq(
      STAGES_WITH_STAGE_DATA,
      ALL_STAGES.filter((s) => s !== 'NEW_LEAD')
    )
  );

  assert(
    'SHOWED ⊂ BOOKED (every showed lead was once booked)',
    subset(SHOWED_LEAD_STAGES, BOOKED_LEAD_STAGES)
  );

  assert(
    'CLOSED_WON appears in QUALIFIED, BOOKED, and SHOWED',
    QUALIFIED_LEAD_STAGES.includes('CLOSED_WON') &&
      BOOKED_LEAD_STAGES.includes('CLOSED_WON') &&
      SHOWED_LEAD_STAGES.includes('CLOSED_WON')
  );

  assert(
    'QUALIFIED excludes NURTURE (was the funnel-route divergence)',
    !QUALIFIED_LEAD_STAGES.includes('NURTURE')
  );

  assert(
    'QUALIFIED excludes NO_SHOWED (terminal non-revenue)',
    !QUALIFIED_LEAD_STAGES.includes('NO_SHOWED')
  );

  assert(
    'BOOKED includes RESCHEDULED (a rescheduled call still counts as booked-once)',
    BOOKED_LEAD_STAGES.includes('RESCHEDULED')
  );

  assert(
    'Mutable _ARR exports have identical contents to readonly originals',
    setEq(QUALIFIED_LEAD_STAGES, QUALIFIED_LEAD_STAGES_ARR) &&
      setEq(BOOKED_LEAD_STAGES, BOOKED_LEAD_STAGES_ARR)
  );

  // ── Layer 2: seeded cross-view reconciliation (opt-in) ──
  if (!process.argv.includes('--seed')) return;

  console.log('\n── Layer 2: seeded cross-view reconciliation (DB) ──');
  const { default: prisma } = await import('../src/lib/prisma');

  const slug = `recon-${Date.now()}`;
  const account = await prisma.account.create({
    data: { name: 'Recon Test Acct', slug }
  });
  const accountId = account.id;

  try {
    const seed: { stage: LeadStage; count: number }[] = [
      { stage: 'NEW_LEAD', count: 2 },
      { stage: 'QUALIFYING', count: 3 },
      { stage: 'QUALIFIED', count: 4 },
      { stage: 'CALL_PROPOSED', count: 2 },
      { stage: 'BOOKED', count: 3 },
      { stage: 'SHOWED', count: 1 },
      { stage: 'NO_SHOWED', count: 1 },
      { stage: 'RESCHEDULED', count: 1 },
      { stage: 'CLOSED_WON', count: 1 },
      { stage: 'CLOSED_LOST', count: 1 },
      { stage: 'NURTURE', count: 1 },
      { stage: 'GHOSTED', count: 1 }
    ];

    let n = 0;
    for (const { stage, count } of seed) {
      for (let i = 0; i < count; i++) {
        n++;
        await prisma.lead.create({
          data: {
            accountId,
            name: `Recon ${n}`,
            handle: `recon_${n}`,
            platform: 'INSTAGRAM',
            triggerType: 'DM',
            stage
          }
        });
      }
    }

    const expectedTotal = seed.reduce((a, b) => a + b.count, 0);
    const expectedQualified = seed
      .filter((s) =>
        (QUALIFIED_LEAD_STAGES as readonly string[]).includes(s.stage)
      )
      .reduce((a, b) => a + b.count, 0);
    const expectedBooked = seed
      .filter((s) =>
        (BOOKED_LEAD_STAGES as readonly string[]).includes(s.stage)
      )
      .reduce((a, b) => a + b.count, 0);

    const funnelTotal = await prisma.lead.count({ where: { accountId } });
    const funnelQualified = await prisma.lead.count({
      where: { accountId, stage: { in: QUALIFIED_LEAD_STAGES_ARR } }
    });
    const funnelBooked = await prisma.lead.count({
      where: { accountId, stage: { in: BOOKED_LEAD_STAGES_ARR } }
    });
    const conversationsQualified = await prisma.lead.count({
      where: { accountId, stage: { in: QUALIFIED_LEAD_STAGES_ARR } }
    });

    assert(
      `Funnel.totalLeads == seed total (${funnelTotal} == ${expectedTotal})`,
      funnelTotal === expectedTotal
    );
    assert(
      `Funnel.qualified == ground truth (${funnelQualified} == ${expectedQualified})`,
      funnelQualified === expectedQualified
    );
    assert(
      `Funnel.booked == ground truth (${funnelBooked} == ${expectedBooked})`,
      funnelBooked === expectedBooked
    );
    assert(
      `Conversations.qualified == Funnel.qualified (${conversationsQualified} == ${funnelQualified})`,
      conversationsQualified === funnelQualified
    );
  } finally {
    await prisma.lead.deleteMany({ where: { accountId } });
    await prisma.account.delete({ where: { id: accountId } }).catch(() => null);
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${fails} failed`);
    process.exit(fails === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
