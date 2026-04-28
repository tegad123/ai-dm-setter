/* eslint-disable no-console */
// Phase 1 super-admin dashboard verification suite.
//
//   TEST 1 — Tega is SUPER_ADMIN
//   TEST 2 — runHealthChecks returns 8 results + a rollup
//   TEST 3 — daetradez account count is reachable + maps to a row
//   TEST 4 — AdminLog row was written by the promote script
//   TEST 5 — Schema enums + new fields are present (Prisma client)

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';
import { runHealthChecks, rollupStatus } from '../src/lib/admin-health';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

async function main() {
  // ── TEST 1 ────────────────────────────────────────────────────
  console.log('\n[TEST 1] Tega is SUPER_ADMIN');
  const tega = await prisma.user.findUnique({
    where: { email: 'tegad8@gmail.com' },
    select: { role: true }
  });
  expect('Tega role === SUPER_ADMIN', tega?.role, 'SUPER_ADMIN');

  // ── TEST 2 ────────────────────────────────────────────────────
  console.log('\n[TEST 2] runHealthChecks against daetradez');
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, name: true }
  });
  if (!account) {
    fail++;
    console.log('  ✗ no daetradez account — skipping the rest');
    process.exit(1);
  }
  const checks = await runHealthChecks(account.id);
  expect('returns 8 checks', checks.length, 8);
  const ids = checks.map((c) => c.id).sort();
  expect('check ids cover the spec set', ids, [
    'ai_generation_healthy',
    'credential_facebook',
    'credential_instagram',
    'distress_handled',
    'followup_cascade',
    'no_stuck_leads',
    'upcoming_call_confirmations',
    'webhook_active'
  ]);
  const r = rollupStatus(checks);
  expect(
    'rollup is one of the four states',
    ['HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN'].includes(r),
    true
  );

  // ── TEST 3 ────────────────────────────────────────────────────
  console.log('\n[TEST 3] account count + admin overview field shape');
  const accountCount = await prisma.account.count();
  expect('account count > 0', accountCount > 0, true);
  const acctMeta = await prisma.account.findFirst({
    select: {
      planStatus: true,
      healthStatus: true,
      lastHealthCheck: true,
      monthlyApiCostUsd: true,
      onboardingStep: true
    }
  });
  expect(
    'new account fields exist on selected row',
    acctMeta !== null && 'planStatus' in acctMeta && 'healthStatus' in acctMeta,
    true
  );

  // ── TEST 4 ────────────────────────────────────────────────────
  console.log('\n[TEST 4] AdminLog row from promote script');
  const promoteLog = await prisma.adminLog.findFirst({
    where: {
      adminUserId: tega ? undefined : '__nope__',
      action: 'role.promote_super_admin'
    },
    orderBy: { createdAt: 'desc' }
  });
  expect('promote AdminLog row exists', promoteLog !== null, true);

  // ── TEST 5 ────────────────────────────────────────────────────
  console.log('\n[TEST 5] enums + relations are wired');
  // Round-trip: create a stub AdminLog targeted at the same account,
  // read it back, delete it. Validates the relation + index path
  // without leaving residue.
  const stub = await prisma.adminLog.create({
    data: {
      adminUserId: (tega as any)
        ? (await prisma.user.findUnique({
            where: { email: 'tegad8@gmail.com' },
            select: { id: true }
          }))!.id
        : '',
      targetAccountId: account.id,
      action: 'phase1.smoke_test',
      metadata: { fromTest: 'admin-phase1' }
    }
  });
  const readback = await prisma.adminLog.findUnique({ where: { id: stub.id } });
  expect('AdminLog round-trip read', readback?.action, 'phase1.smoke_test');
  await prisma.adminLog.delete({ where: { id: stub.id } });

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
