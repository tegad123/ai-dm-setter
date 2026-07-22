// Read the per-turn generation trace for a conversation. This is the
// instrumentation Tega asked for — it answers "what did the engine compute,
// what did the model emit, what were the variables, and what prompt did we
// send" without reconstructing anything from delivered message text.
//
// Usage:
//   npx tsx scripts/inspect-turn-trace.ts <convId>              # summary table
//   npx tsx scripts/inspect-turn-trace.ts <convId> --vars       # variable state per turn
//   npx tsx scripts/inspect-turn-trace.ts <convId> --prompt N   # full prompt for turn N
//   npx tsx scripts/inspect-turn-trace.ts <convId> --grep TERM  # search prompts (F2)

import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.PROD_DATABASE_URL } }
});

async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  throw last;
}

async function main() {
  const convId = process.argv[2];
  const flag = process.argv[3];
  const flagArg = process.argv[4];
  if (!convId)
    throw new Error(
      'usage: inspect-turn-trace.ts <convId> [--vars|--prompt N|--grep TERM]'
    );

  const rows = await retry(() =>
    prisma.generationTurnTrace.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'asc' }
    })
  );

  if (rows.length === 0) {
    console.log('No trace rows for', convId);
    console.log(
      '(Traces only exist for turns generated AFTER the instrumentation deploy.)'
    );
    await prisma.$disconnect();
    return;
  }

  if (flag === '--grep' && flagArg) {
    console.log(`Searching ${rows.length} prompts for "${flagArg}":\n`);
    let total = 0;
    rows.forEach((r, i) => {
      const p = r.promptSent ?? '';
      const re = new RegExp(flagArg, 'gi');
      const hits = p.match(re);
      if (hits?.length) {
        total += hits.length;
        console.log(
          `  turn #${i} (${r.createdAt.toISOString().slice(11, 19)}): ${hits.length} hit(s)`
        );
        // show surrounding context for each hit
        let idx = p.search(re);
        if (idx >= 0) {
          console.log(
            '    …' +
              p.slice(Math.max(0, idx - 120), idx + 160).replace(/\n/g, ' ') +
              '…'
          );
        }
      }
    });
    console.log(
      `\nTOTAL "${flagArg}" occurrences across all prompts: ${total}`
    );
    console.log(total === 0 ? '✓ CLEAN' : '✗ PRESENT');
    await prisma.$disconnect();
    return;
  }

  if (flag === '--prompt') {
    const n = Number(flagArg ?? 0);
    const row = rows[n];
    if (!row) throw new Error(`no turn #${n} (have 0..${rows.length - 1})`);
    console.log(
      `=== FULL PROMPT — turn #${n} (${row.promptChars} chars) ===\n`
    );
    console.log(row.promptSent ?? '(null)');
    await prisma.$disconnect();
    return;
  }

  if (flag === '--vars') {
    rows.forEach((r, i) => {
      console.log(
        `\n--- turn #${i} (${r.createdAt.toISOString().slice(11, 19)}) ---`
      );
      const vars = (r.variablesState ?? []) as Array<{
        name: string;
        value: string | null;
        source: string;
        confidence?: string;
      }>;
      if (!Array.isArray(vars) || vars.length === 0) {
        console.log('  (no variables)');
        return;
      }
      vars.forEach((v) =>
        console.log(
          `  ${v.name.padEnd(28)} = ${JSON.stringify(v.value)?.slice(0, 70).padEnd(72)} [${v.source}${v.confidence ? '/' + v.confidence : ''}]`
        )
      );
    });
    await prisma.$disconnect();
    return;
  }

  console.log(`=== TURN TRACE — ${convId} (${rows.length} turns) ===\n`);
  console.log(
    '#'.padEnd(4) +
      'time'.padEnd(10) +
      'step'.padEnd(6) +
      'branch'.padEnd(26) +
      'stage_emitted'.padEnd(22) +
      'prompt'.padEnd(9) +
      'reply'
  );
  rows.forEach((r, i) => {
    console.log(
      String(i).padEnd(4) +
        r.createdAt.toISOString().slice(11, 19).padEnd(10) +
        String(r.stepNumber ?? '-').padEnd(6) +
        (r.branchSelected ?? '-').slice(0, 24).padEnd(26) +
        (r.stageEmitted ?? '-').slice(0, 20).padEnd(22) +
        String(r.promptChars ?? '-').padEnd(9) +
        (r.replyPreview ?? '').slice(0, 44).replace(/\n/g, ' ')
    );
  });

  const anyStamped = rows.filter((r) => r.stageEmitted != null);
  console.log(
    `\nturns where the MODEL emitted a stage: ${anyStamped.length}/${rows.length}`
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
