// Clone a Script tree (steps → branches → actions) from PROD into the LOCAL
// DB under a local account, deactivate the account's other scripts, activate
// the clone. Dev-only harness helper for testing a client's new script
// end-to-end on local without touching prod. Voice-note / form references are
// dropped (not needed for routing tests).
//
// Usage:
//   NODE_PATH=$PWD/node_modules npx tsx scripts/clone-script-to-local.ts <prodScriptId> [localAccountId]
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
import { PrismaClient } from '@prisma/client';
import localPrisma from '../src/lib/prisma';

const LOCAL_AID_DEFAULT = 'cmpa60h9c0000gs4l85idlaby'; // shazim's Workspace (local)

async function main() {
  const [prodScriptId, localAccountId = LOCAL_AID_DEFAULT] =
    process.argv.slice(2);
  if (!prodScriptId)
    throw new Error(
      'usage: clone-script-to-local.ts <prodScriptId> [localAccountId]'
    );
  if (!(process.env.DATABASE_URL ?? '').includes('localhost')) {
    throw new Error(
      'DATABASE_URL must be localhost (this writes to LOCAL only)'
    );
  }
  const prod = new PrismaClient({
    datasources: { db: { url: process.env.PROD_DATABASE_URL } }
  });
  const src = await prod.script.findUnique({
    where: { id: prodScriptId },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: {
          actions: { orderBy: { sortOrder: 'asc' } },
          branches: {
            orderBy: { sortOrder: 'asc' },
            include: { actions: { orderBy: { sortOrder: 'asc' } } }
          }
        }
      }
    }
  });
  if (!src) throw new Error(`prod script ${prodScriptId} not found`);
  console.log(
    `source: "${src.name}" (${src.steps.length} steps) from account ${src.accountId}`
  );

  const local = await localPrisma.account.findUnique({
    where: { id: localAccountId },
    select: { id: true, name: true }
  });
  if (!local) throw new Error(`local account ${localAccountId} not found`);

  // Replace any earlier clone of the same script (idempotent re-runs).
  const prior = await localPrisma.script.findMany({
    where: { accountId: localAccountId, name: src.name },
    select: { id: true }
  });
  if (prior.length) {
    await localPrisma.script.deleteMany({
      where: { id: { in: prior.map((p) => p.id) } }
    });
    console.log(`removed ${prior.length} earlier local copy/copies`);
  }

  const created = await localPrisma.script.create({
    data: {
      accountId: localAccountId,
      name: src.name,
      description: src.description,
      isActive: false,
      createdVia: src.createdVia,
      originalUploadText: src.originalUploadText,
      lastParsedAt: src.lastParsedAt,
      parseWarnings: src.parseWarnings ?? undefined,
      steps: {
        create: src.steps.map((st) => ({
          stepNumber: st.stepNumber,
          title: st.title,
          description: st.description,
          objective: st.objective,
          stateKey: st.stateKey,
          requiredDataPoints: st.requiredDataPoints ?? undefined,
          recoveryActionType: st.recoveryActionType,
          canonicalQuestion: st.canonicalQuestion,
          artifactField: st.artifactField,
          routingRules: st.routingRules ?? undefined,
          completionRule: st.completionRule ?? undefined,
          parserConfidence: st.parserConfidence,
          userConfirmed: st.userConfirmed,
          actions: {
            create: st.actions
              .filter((a) => !a.branchId)
              .map((a) => ({
                actionType: a.actionType,
                content: a.content,
                linkUrl: a.linkUrl,
                linkLabel: a.linkLabel,
                waitDuration: a.waitDuration,
                sortOrder: a.sortOrder,
                parserConfidence: a.parserConfidence,
                parserStatus: a.parserStatus,
                userConfirmed: a.userConfirmed
              }))
          },
          branches: {
            create: st.branches.map((b) => ({
              branchLabel: b.branchLabel,
              conditionDescription: b.conditionDescription,
              sortOrder: b.sortOrder,
              parserConfidence: b.parserConfidence,
              userConfirmed: b.userConfirmed
            }))
          }
        }))
      }
    },
    include: { steps: { include: { branches: true } } }
  });

  // Branch-scoped actions need both stepId and branchId → second pass.
  let branchActions = 0;
  for (const st of src.steps) {
    const localStep = created.steps.find(
      (s) => s.stepNumber === st.stepNumber
    )!;
    for (const b of st.branches) {
      const localBranch = localStep.branches.find(
        (lb) => lb.branchLabel === b.branchLabel && lb.sortOrder === b.sortOrder
      )!;
      for (const a of b.actions) {
        await localPrisma.scriptAction.create({
          data: {
            stepId: localStep.id,
            branchId: localBranch.id,
            actionType: a.actionType,
            content: a.content,
            linkUrl: a.linkUrl,
            linkLabel: a.linkLabel,
            waitDuration: a.waitDuration,
            sortOrder: a.sortOrder,
            parserConfidence: a.parserConfidence,
            parserStatus: a.parserStatus,
            userConfirmed: a.userConfirmed
          }
        });
        branchActions++;
      }
    }
  }

  await localPrisma.script.updateMany({
    where: { accountId: localAccountId, id: { not: created.id } },
    data: { isActive: false }
  });
  await localPrisma.script.update({
    where: { id: created.id },
    data: { isActive: true }
  });
  console.log(
    `cloned → local script ${created.id} "${created.name}" (${created.steps.length} steps, ${branchActions} branch actions), ACTIVE on ${local.name || localAccountId}; other local scripts deactivated`
  );
  await prod.$disconnect();
  await localPrisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await localPrisma.$disconnect();
  process.exit(1);
});
