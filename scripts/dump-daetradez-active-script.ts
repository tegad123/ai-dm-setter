/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// dump-daetradez-active-script.ts
// ---------------------------------------------------------------------------
// Dumps the entire active relational Script for the account owned by
// daetradez2003@gmail.com — exactly what the AI currently reads via
// serializeScriptForPrompt(). Read-only.
//
// Run:
//   npx tsx scripts/dump-daetradez-active-script.ts
//
// Set DATABASE_URL to whichever environment you want to inspect (local
// dev, staging, or production). The script does NOT mutate any rows.
// ---------------------------------------------------------------------------

import prisma from '../src/lib/prisma';

const TARGET_EMAIL = 'daetradez2003@gmail.com';

function indent(s: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return s
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

async function main() {
  // ── 1. Resolve account via User.email ─────────────────────────
  const user = await prisma.user.findFirst({
    where: { email: TARGET_EMAIL },
    select: { id: true, email: true, accountId: true }
  });
  if (!user) {
    console.error(`[script-dump] No User found with email=${TARGET_EMAIL}`);
    process.exit(1);
  }
  const account = await prisma.account.findUnique({
    where: { id: user.accountId },
    select: { id: true, slug: true, name: true }
  });
  if (!account) {
    console.error(
      `[script-dump] User.accountId=${user.accountId} has no Account row.`
    );
    process.exit(1);
  }
  console.log(
    '================================================================'
  );
  console.log(`Email:    ${user.email}`);
  console.log(`User:     ${user.id}`);
  console.log(
    `Account:  ${account.id}  slug="${account.slug}"  name="${account.name}"`
  );
  console.log(
    '================================================================'
  );

  // ── 2. List all Scripts on this account ───────────────────────
  const allScripts = await prisma.script.findMany({
    where: { accountId: account.id },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      isActive: true,
      isDefault: true,
      createdVia: true,
      lastParsedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { steps: true } }
    }
  });

  console.log('');
  console.log(`SCRIPTS ON ACCOUNT (${allScripts.length} total)`);
  console.log(
    '----------------------------------------------------------------'
  );
  for (const s of allScripts) {
    console.log(
      `  ${s.isActive ? '[ACTIVE]' : '[      ]'}  id=${s.id}  steps=${s._count.steps}  name="${s.name}"  createdVia=${s.createdVia}  parsedAt=${s.lastParsedAt?.toISOString() ?? 'null'}  updatedAt=${s.updatedAt.toISOString()}`
    );
  }

  // ── 3. Pull the active Script in full ─────────────────────────
  const script = await prisma.script.findFirst({
    where: { accountId: account.id, isActive: true },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: {
          actions: {
            where: { branchId: null },
            orderBy: { sortOrder: 'asc' }
          },
          branches: {
            orderBy: { sortOrder: 'asc' },
            include: {
              actions: { orderBy: { sortOrder: 'asc' } }
            }
          }
        }
      },
      forms: { include: { fields: { orderBy: { sortOrder: 'asc' } } } }
    }
  });

  if (!script) {
    console.log('');
    console.log('No ACTIVE Script row found for this account.');
    console.log(
      'AI prompt assembly will fall back to PersonaBreakdown.scriptSteps.'
    );
    return;
  }

  console.log('');
  console.log(
    '================================================================'
  );
  console.log(`ACTIVE SCRIPT  (id=${script.id})`);
  console.log(`Name:        ${script.name}`);
  console.log(`Description: ${script.description ?? '(none)'}`);
  console.log(`createdVia:  ${script.createdVia}`);
  console.log(`isDefault:   ${script.isDefault}`);
  console.log(`createdAt:   ${script.createdAt.toISOString()}`);
  console.log(`updatedAt:   ${script.updatedAt.toISOString()}`);
  console.log(`lastParsedAt: ${script.lastParsedAt?.toISOString() ?? 'null'}`);
  console.log(`Step count:  ${script.steps.length}`);
  console.log(
    '================================================================'
  );

  // ── 4. Dump every step + branch + action ──────────────────────
  for (const step of script.steps) {
    console.log('');
    console.log(`──── STEP ${step.stepNumber}: ${step.title} ────`);
    console.log(`  step.id:           ${step.id}`);
    console.log(`  stateKey:          ${step.stateKey ?? '(null)'}`);
    console.log(`  description:       ${step.description ?? '(none)'}`);
    console.log(`  objective:         ${step.objective ?? '(none)'}`);
    console.log(`  canonicalQuestion: ${step.canonicalQuestion ?? '(none)'}`);
    console.log(`  artifactField:     ${step.artifactField ?? '(none)'}`);
    console.log(`  parserConfidence:  ${step.parserConfidence ?? '(none)'}`);
    console.log(`  userConfirmed:     ${step.userConfirmed}`);
    if (step.requiredDataPoints) {
      console.log(
        `  requiredDataPoints: ${JSON.stringify(step.requiredDataPoints)}`
      );
    }
    if (step.routingRules) {
      console.log(`  routingRules: ${JSON.stringify(step.routingRules)}`);
    }

    if (step.actions.length > 0) {
      console.log('  Direct actions (no branch):');
      for (const a of step.actions) {
        console.log(indent(formatAction(a), 4));
      }
    }
    if (step.branches.length === 0 && step.actions.length === 0) {
      console.log('  (no actions or branches on this step)');
    }
    for (const branch of step.branches) {
      console.log(`  Branch: "${branch.branchLabel}"`);
      console.log(`    branch.id:          ${branch.id}`);
      console.log(
        `    condition:          ${branch.conditionDescription ?? '(none)'}`
      );
      console.log(
        `    parserConfidence:   ${branch.parserConfidence ?? '(none)'}`
      );
      console.log(`    userConfirmed:      ${branch.userConfirmed}`);
      if (branch.actions.length === 0) {
        console.log('    (no actions in this branch)');
      } else {
        for (const a of branch.actions) {
          console.log(indent(formatAction(a), 6));
        }
      }
    }
  }

  // ── 5. Forms ──────────────────────────────────────────────────
  if (script.forms.length > 0) {
    console.log('');
    console.log('──── SCRIPT FORMS ────');
    for (const form of script.forms) {
      console.log(`  Form: ${form.name}  (id=${form.id})`);
      for (const field of form.fields) {
        console.log(
          `    - ${field.fieldLabel} [id=${field.id}]: ${field.fieldValue ?? '(empty)'}`
        );
      }
    }
  }
}

function formatAction(a: {
  id: string;
  actionType: string;
  content: string | null;
  voiceNoteId: string | null;
  bindingMode: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  formId: string | null;
  waitDuration: number | null;
  sortOrder: number;
  parserConfidence: string | null;
  parserStatus: string | null;
  userConfirmed: boolean;
}): string {
  const lines: string[] = [];
  lines.push(`[${a.actionType}] (sortOrder=${a.sortOrder}, action.id=${a.id})`);
  if (a.content) lines.push(`  content: ${a.content}`);
  if (a.linkUrl) lines.push(`  linkUrl: ${a.linkUrl}`);
  if (a.linkLabel) lines.push(`  linkLabel: ${a.linkLabel}`);
  if (a.voiceNoteId)
    lines.push(`  voiceNoteId: ${a.voiceNoteId} (binding=${a.bindingMode})`);
  if (a.formId) lines.push(`  formId: ${a.formId}`);
  if (typeof a.waitDuration === 'number')
    lines.push(`  waitDuration: ${a.waitDuration}s`);
  lines.push(
    `  parserConfidence=${a.parserConfidence ?? '(none)'}  parserStatus=${a.parserStatus ?? '(none)'}  userConfirmed=${a.userConfirmed}`
  );
  return lines.join('\n');
}

main()
  .catch((err) => {
    console.error('[script-dump] FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
