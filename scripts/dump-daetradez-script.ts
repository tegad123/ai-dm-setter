/* eslint-disable no-console */
// Dump the rawScript field for every active daetradez persona, sorted so
// the most recently updated one prints last. Read-only.

import prisma from '../src/lib/prisma';

async function main() {
  const account = await prisma.account.findFirst({
    where: { slug: { contains: 'daetradez', mode: 'insensitive' } },
    select: { id: true, slug: true, name: true }
  });
  if (!account) {
    console.error('No daetradez account found.');
    process.exit(1);
  }
  console.log(
    `[script-dump] account=${account.id} slug=${account.slug} name=${account.name}`
  );

  const personas = await prisma.aIPersona.findMany({
    where: { accountId: account.id },
    select: {
      id: true,
      personaName: true,
      isActive: true,
      rawScript: true,
      rawScriptFileName: true,
      contextUpdatedAt: true,
      updatedAt: true
    },
    orderBy: { updatedAt: 'asc' }
  });

  for (const p of personas) {
    const len = p.rawScript?.length ?? 0;
    console.log('');
    console.log(
      '================================================================'
    );
    console.log(
      `persona=${p.id} name="${p.personaName}" active=${p.isActive} rawScriptLen=${len} ` +
        `rawScriptFile=${p.rawScriptFileName ?? 'null'} ` +
        `contextUpdatedAt=${p.contextUpdatedAt?.toISOString() ?? 'null'} ` +
        `updatedAt=${p.updatedAt.toISOString()}`
    );
    console.log(
      '----------------------------------------------------------------'
    );
    if (p.rawScript) {
      console.log(p.rawScript);
    } else {
      console.log('(rawScript is null)');
    }
    console.log(
      '================================================================'
    );
  }
}

main()
  .catch((err) => {
    console.error('[script-dump] FATAL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
