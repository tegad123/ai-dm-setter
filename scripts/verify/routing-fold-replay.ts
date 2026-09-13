// M5 item 4 evidence, Meta-free: replay the compiled FSM over REAL
// conversations (full message history folded through the machine) and compare
// the machine's position with legacy `Conversation.currentScriptStep`.
// Read-only: compiles the active script in memory, writes nothing.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/routing-fold-replay.ts --account <accountId> | --script <scriptId> [--since 7d] [--limit 200] [--verbose]
import 'dotenv/config';
import prisma from '@/lib/prisma';
import { compileScript } from '@/lib/script-fsm/compiler';
import { foldHistory } from '@/lib/script-fsm/runtime';
import { loadScriptStepsForCompile } from '@/lib/script-fsm/store';
import { readBranchHistoryEvents } from '@/lib/script-state-recovery';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sinceMs(spec: string | undefined): number {
  const m = /^(\d+)([hd])$/.exec(spec ?? '7d');
  if (!m) return 7 * 86400e3;
  return Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
}

async function main() {
  const since = new Date(Date.now() - sinceMs(arg('since')));
  const limit = Number(arg('limit') ?? 200);
  const verbose = process.argv.includes('--verbose');

  const scriptArg = arg('script');
  const script = scriptArg
    ? await prisma.script.findUnique({
        where: { id: scriptArg },
        select: { id: true, name: true, accountId: true }
      })
    : await prisma.script.findFirst({
        where: { accountId: arg('account') ?? '__none__', isActive: true },
        select: { id: true, name: true, accountId: true }
      });
  if (!script)
    throw new Error(
      'no active script (pass --account <accountId> or --script <scriptId>)'
    );
  const accountId = script.accountId;
  const steps = await loadScriptStepsForCompile(script.id);
  const fsm = compileScript(steps);
  const errors = fsm.diagnostics.filter((d) => d.severity === 'error');
  console.log(
    `script ${script.id} (${script.name}): ${fsm.nodes.length} nodes, ${errors.length} errors, compilerVersion=${fsm.compilerVersion}`
  );
  if (errors.length) {
    for (const e of errors)
      console.log(`  ERROR ${e.code} step=${e.stepNumber}: ${e.message}`);
  }

  const convs = await prisma.conversation.findMany({
    where: { lead: { accountId }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      currentScriptStep: true,
      source: true,
      createdAt: true,
      capturedDataPoints: true,
      lead: { select: { name: true, platform: true } },
      messages: {
        orderBy: { timestamp: 'asc' },
        select: { sender: true, content: true }
      }
    }
  });

  let agree = 0;
  let ahead = 0;
  let behind = 0;
  let noLegacyTurn = 0;
  const rows: string[] = [];
  const transcripts: string[] = [];
  const show = new Set((arg('show') ?? '').split(',').filter(Boolean));
  const reasons = new Map<string, number>();
  for (const c of convs) {
    const points = (c.capturedDataPoints ?? {}) as Record<string, unknown>;
    const labelForStep = (step: number): string | null => {
      const ev = readBranchHistoryEvents(points as never)
        .filter((e) => e.stepNumber === step && !!e.selectedBranchLabel)
        .at(-1);
      return ev?.selectedBranchLabel ?? null;
    };
    const fold = foldHistory(fsm, c.messages, { labelForStep });
    const legacy = c.currentScriptStep ?? 1;
    const fsmStep = fold.cursor.stepNumber;
    const delta = fsmStep - legacy;
    const aiMsgs = c.messages.filter((m) => m.sender === 'AI').length;
    // Legacy only evaluates on AI turns: a human-run conversation never had a
    // legacy position, so it is not a disagreement between the two algorithms.
    const legacyRan = aiMsgs > 0;
    if (!legacyRan) noLegacyTurn++;
    else if (delta === 0) agree++;
    else if (delta > 0) ahead++;
    else behind++;
    if ((legacyRan && delta < 0) || show.has(c.id)) {
      transcripts.push(
        `\n--- ${c.id} legacy=${legacy} fsm=${fsmStep} advances=${fold.advances.map((a) => `${a.from}>${a.to}:${a.reason}`).join(',')}\n` +
          c.messages
            .slice(-14)
            .map(
              (m) =>
                `    ${m.sender.padEnd(8)} ${m.content.slice(0, 110).replace(/\n/g, ' ')}`
            )
            .join('\n')
      );
    }
    reasons.set(fold.lastReason, (reasons.get(fold.lastReason) ?? 0) + 1);
    const leadMsgs = c.messages.filter((m) => m.sender === 'LEAD').length;
    const outMsgs = c.messages.filter(
      (m) => m.sender === 'AI' || m.sender === 'HUMAN'
    ).length;
    const line = `${!legacyRan ? '·' : delta === 0 ? '=' : delta > 0 ? '+' : '-'} ${c.id} ${c.lead.platform} src=${c.source} lead=${leadMsgs} out=${outMsgs} legacy=${legacy} fsm=${fsmStep} branch=${JSON.stringify(fold.cursor.selectedBranchLabel)} replies=${fold.cursor.repliesInStep} spoke=${fold.cursor.spokeInStep} last=${fold.lastReason} advances=${fold.advances.map((a) => `${a.from}>${a.to}`).join(',')}`;
    if ((legacyRan && delta !== 0) || verbose) rows.push(line);
  }
  console.log(
    `\nconversations since ${since.toISOString()}: ${convs.length}  legacy-evaluated=${agree + ahead + behind} (agree=${agree}  fsm ahead=${ahead}  fsm behind=${behind})  human-run/no legacy turn=${noLegacyTurn}`
  );
  console.log('last-event reasons:', Object.fromEntries(reasons));
  console.log(
    '\nper-conversation (disagreements' + (verbose ? ' + all' : '') + '):'
  );
  for (const r of rows) console.log('  ' + r);
  if (transcripts.length) {
    console.log('\ntranscripts (fsm behind legacy, and --show):');
    for (const t of transcripts) console.log(t);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
