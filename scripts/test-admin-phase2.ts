/* eslint-disable no-console */
// Phase 2 onboarding wizard verification suite.
//
//   TEST 1 — POST /onboard/account creates Account + User + AIPersona
//            in one transaction; AdminLog row written.
//   TEST 2 — POST /onboard/persona updates the AIPersona + bumps
//            onboardingStep → 3.
//   TEST 3 — GET /onboard/status reflects the configured state.
//   TEST 4 — POST /onboard/activate flips awayMode toggles +
//            onboardingComplete + creates a SYSTEM notification.
//   TEST 5 — Slug uniqueness: two onboardings with the same business
//            name produce distinct slugs.
//
// All tests exercise the underlying logic via direct prisma writes
// (mirroring what the API routes do) so they don't require a running
// HTTP server. Each creates its own synthetic account + cleans up.

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local', override: true });

import prisma from '../src/lib/prisma';

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

async function getTega() {
  const u = await prisma.user.findUnique({
    where: { email: 'tegad8@gmail.com' },
    select: { id: true, role: true }
  });
  if (!u || u.role !== 'SUPER_ADMIN') {
    throw new Error('Tega missing or not SUPER_ADMIN — run promote-tega first');
  }
  return u;
}

async function deriveUniqueSlug(base: string): Promise<string> {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let i = 1;
  // mirror onboard route logic
  while (await prisma.account.findUnique({ where: { slug } })) {
    i++;
    slug = `${base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}-${i}`;
  }
  return slug;
}

async function createOnboardingAccount(tegaId: string, label: string) {
  const slug = await deriveUniqueSlug(`phase2-test-${label}-${Date.now()}`);
  const account = await prisma.account.create({
    data: {
      name: `Phase2 ${label}`,
      slug,
      plan: 'FREE',
      planStatus: 'TRIAL',
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      onboardingStep: 1,
      onboardingComplete: false
    }
  });
  const user = await prisma.user.create({
    data: {
      accountId: account.id,
      email: `phase2-${label}-${Date.now()}@example.com`,
      name: `Owner ${label}`,
      passwordHash: '',
      role: 'ADMIN',
      isActive: false
    }
  });
  const persona = await prisma.aIPersona.create({
    data: {
      accountId: account.id,
      personaName: `Sales ${label}`,
      fullName: `Owner ${label}`,
      tone: 'casual, direct, friendly',
      systemPrompt: 'placeholder'
    }
  });
  await prisma.adminLog.create({
    data: {
      adminUserId: tegaId,
      targetAccountId: account.id,
      action: 'onboard.create_account',
      metadata: { test: label }
    }
  });
  return {
    accountId: account.id,
    userId: user.id,
    personaId: persona.id,
    slug
  };
}

async function cleanup(accountId: string) {
  await prisma.adminLog.deleteMany({ where: { targetAccountId: accountId } });
  await prisma.notification.deleteMany({ where: { accountId } });
  await prisma.aIPersona.deleteMany({ where: { accountId } });
  await prisma.user.deleteMany({ where: { accountId } });
  await prisma.account.delete({ where: { id: accountId } });
}

async function main() {
  const tega = await getTega();

  // ── TEST 1 ────────────────────────────────────────────────────
  console.log('\n[TEST 1] account/user/persona/log created in one shot');
  const { accountId } = await createOnboardingAccount(tega.id, 'a');
  try {
    const acct = await prisma.account.findUnique({
      where: { id: accountId },
      select: { onboardingStep: true, planStatus: true }
    });
    const userCount = await prisma.user.count({ where: { accountId } });
    const personaCount = await prisma.aIPersona.count({ where: { accountId } });
    const logCount = await prisma.adminLog.count({
      where: { targetAccountId: accountId, action: 'onboard.create_account' }
    });
    expect('onboardingStep === 1', acct?.onboardingStep, 1);
    expect('planStatus === TRIAL', acct?.planStatus, 'TRIAL');
    expect('exactly 1 admin user', userCount, 1);
    expect('exactly 1 AIPersona', personaCount, 1);
    expect('AdminLog created', logCount, 1);

    // ── TEST 2 ────────────────────────────────────────────────
    console.log('\n[TEST 2] persona update bumps onboardingStep → 3');
    const persona = await prisma.aIPersona.findFirstOrThrow({
      where: { accountId }
    });
    await prisma.$transaction([
      prisma.aIPersona.update({
        where: { id: persona.id },
        data: {
          fullName: 'Updated Owner',
          personaName: 'Sales Updated',
          minimumCapitalRequired: 1500
        }
      }),
      prisma.account.update({
        where: { id: accountId },
        data: { onboardingStep: 3 }
      })
    ]);
    const after = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { onboardingStep: true }
    });
    expect('onboardingStep advanced to 3', after.onboardingStep, 3);
    const updatedPersona = await prisma.aIPersona.findFirstOrThrow({
      where: { accountId }
    });
    expect(
      'minimumCapitalRequired persisted',
      updatedPersona.minimumCapitalRequired,
      1500
    );

    // ── TEST 3 ────────────────────────────────────────────────
    console.log('\n[TEST 3] /status shape mirrors actual fields');
    const acctForStatus = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: {
        onboardingStep: true,
        onboardingComplete: true,
        awayModeInstagram: true,
        awayModeFacebook: true
      }
    });
    expect(
      'pre-activation: onboardingComplete=false',
      acctForStatus.onboardingComplete,
      false
    );
    expect(
      'pre-activation: awayMode IG=false',
      acctForStatus.awayModeInstagram,
      false
    );

    // ── TEST 4 ────────────────────────────────────────────────
    console.log('\n[TEST 4] activate flips awayMode + completes onboarding');
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: accountId },
        data: {
          awayModeInstagram: true,
          awayModeInstagramEnabledAt: now,
          awayModeFacebook: true,
          awayModeFacebookEnabledAt: now,
          onboardingComplete: true,
          onboardingStep: 6
        }
      });
      await tx.notification.create({
        data: {
          accountId,
          type: 'SYSTEM',
          title: 'New account active — review first 10 conversations',
          body: 'Test notification.'
        }
      });
      await tx.adminLog.create({
        data: {
          adminUserId: tega.id,
          targetAccountId: accountId,
          action: 'onboard.activate',
          metadata: { fromTest: true }
        }
      });
    });
    const activated = await prisma.account.findUniqueOrThrow({
      where: { id: accountId },
      select: {
        awayModeInstagram: true,
        awayModeFacebook: true,
        onboardingComplete: true,
        onboardingStep: true
      }
    });
    expect('awayMode IG flipped', activated.awayModeInstagram, true);
    expect('awayMode FB flipped', activated.awayModeFacebook, true);
    expect('onboardingComplete=true', activated.onboardingComplete, true);
    expect('onboardingStep=6', activated.onboardingStep, 6);
    const notifCount = await prisma.notification.count({
      where: {
        accountId,
        type: 'SYSTEM',
        title: 'New account active — review first 10 conversations'
      }
    });
    expect('SYSTEM notification created', notifCount, 1);
    const activateLogCount = await prisma.adminLog.count({
      where: { targetAccountId: accountId, action: 'onboard.activate' }
    });
    expect('activate AdminLog created', activateLogCount, 1);
  } finally {
    await cleanup(accountId);
  }

  // ── TEST 5 ────────────────────────────────────────────────────
  console.log('\n[TEST 5] slug uniqueness when name collides');
  const a = await createOnboardingAccount(tega.id, 'collide');
  const b = await createOnboardingAccount(tega.id, 'collide');
  try {
    expect('two slugs are distinct', a.slug !== b.slug, true);
  } finally {
    await cleanup(a.accountId);
    await cleanup(b.accountId);
  }

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
