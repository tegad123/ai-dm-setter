// Read-only inventory of the active script's message slots for A1 review.
// NODE_PATH=$PWD/node_modules npx tsx scripts/verify/a1-script-audit.ts <scriptId>
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

config({ path: '.env' });

const scriptId = process.argv[2];
if (!scriptId) throw new Error('Usage: a1-script-audit.ts <scriptId>');
if (!process.env.PROD_DATABASE_URL) {
  throw new Error('PROD_DATABASE_URL is required');
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

const fetchScript = () =>
  prisma.script.findUnique({
    where: { id: scriptId },
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
            include: { actions: { orderBy: { sortOrder: 'asc' } } }
          }
        }
      }
    }
  });

async function main() {
  let script: Awaited<ReturnType<typeof fetchScript>> | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      script = await fetchScript();
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!script) throw new Error(`Script ${scriptId} not found`);

  const summarize = (actions: (typeof script.steps)[number]['actions']) =>
    actions.map((action) => ({
      id: action.id,
      type: action.actionType,
      text: action.content,
      link: action.linkUrl,
      order: action.sortOrder
    }));
  console.log(
    JSON.stringify(
      {
        id: script.id,
        name: script.name,
        accountId: script.accountId,
        active: script.isActive,
        updatedAt: script.updatedAt,
        steps: script.steps.map((step) => ({
          number: step.stepNumber,
          title: step.title,
          direct: summarize(step.actions),
          branches: step.branches.map((branch) => ({
            label: branch.branchLabel,
            condition: branch.conditionDescription,
            actions: summarize(branch.actions)
          }))
        }))
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
