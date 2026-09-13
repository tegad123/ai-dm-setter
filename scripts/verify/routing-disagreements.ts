// M5 items 3–4: show the conversations behind RoutingShadowLog disagreements
// (legacy vs compiled FSM) with their recent messages, so each disagreement
// can be judged by hand. Read-only.
//
// Run (prod):
//   DATABASE_URL="$PROD_DATABASE_URL" NODE_PATH=$PWD/node_modules npx tsx scripts/verify/routing-disagreements.ts [--since 24h] [--conv <id>,<id>] [--steps 1,7,8] [--script <scriptId>]
import 'dotenv/config';
import prisma from '@/lib/prisma';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sinceMs(spec: string | undefined): number {
  const m = /^(\d+)([hd])$/.exec(spec ?? '24h');
  if (!m) return 24 * 3600e3;
  return Number(m[1]) * (m[2] === 'd' ? 86400e3 : 3600e3);
}

async function main() {
  const since = new Date(Date.now() - sinceMs(arg('since')));
  let convIds = arg('conv')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!convIds?.length) {
    const bad = await prisma.routingShadowLog.findMany({
      where: {
        createdAt: { gte: since },
        OR: [
          { advanceAgreed: false },
          { branchAgreed: false, fsmBranchLabel: { not: null } }
        ]
      },
      select: { conversationId: true },
      distinct: ['conversationId'],
      orderBy: { createdAt: 'desc' }
    });
    convIds = bad.map((b) => b.conversationId).filter((x): x is string => !!x);
  }
  console.log(`inspecting ${convIds.length} conversations`);

  const stepFilter = arg('steps')
    ?.split(',')
    .map(Number)
    .filter((n) => !Number.isNaN(n));
  const scriptIds = new Set<string>();
  if (arg('script')) scriptIds.add(arg('script') as string);

  for (const id of convIds) {
    const c = await prisma.conversation.findUnique({
      where: { id },
      select: {
        id: true,
        currentScriptStep: true,
        source: true,
        aiActive: true,
        createdAt: true,
        capturedDataPoints: true,
        lead: {
          select: {
            name: true,
            platform: true,
            account: {
              select: {
                id: true,
                name: true,
                generateOnlyInstagram: true,
                generateOnlyFacebook: true
              }
            }
          }
        },
        messages: {
          orderBy: { timestamp: 'asc' },
          select: {
            sender: true,
            content: true,
            timestamp: true,
            platformMessageId: true
          }
        }
      }
    });
    if (!c) {
      console.log(`\n${id}: not found`);
      continue;
    }
    const a = c.lead.account;
    console.log(
      `\n=== ${id} | ${a.name} | ${c.lead.platform} | src=${c.source} | step=${c.currentScriptStep} | aiActive=${c.aiActive} | genOnly IG=${a.generateOnlyInstagram} FB=${a.generateOnlyFacebook} | lead=${c.lead.name} | created=${c.createdAt.toISOString()}`
    );
    for (const m of c.messages.slice(-12)) {
      console.log(
        `  ${m.timestamp.toISOString()} ${m.sender.padEnd(8)} ${m.platformMessageId ? '' : '[no-pmid] '}${m.content.slice(0, 120).replace(/\n/g, ' ')}`
      );
    }
    const rows = await prisma.routingShadowLog.findMany({
      where: { conversationId: id, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' }
    });
    for (const r of rows) {
      const flag =
        (r.fsmBranchLabel != null && !r.branchAgreed) ||
        r.advanceAgreed === false
          ? '✗'
          : '✓';
      console.log(
        `  ${flag} ${r.createdAt.toISOString()} step=${r.stepNumber} branch legacy=${JSON.stringify(r.legacyBranchLabel)} fsm=${JSON.stringify(r.fsmBranchLabel)} (${r.fsmReason}) advance ${r.legacyNextStep ?? '-'}→${r.fsmNextStep ?? '-'}`
      );
      if (r.scriptId) scriptIds.add(r.scriptId);
    }
    const sugg = await prisma.aISuggestion.count({
      where: { conversationId: id }
    });
    console.log(`  suggestions=${sugg}`);
  }

  for (const scriptId of Array.from(scriptIds)) {
    const s = await prisma.script.findUnique({
      where: { id: scriptId },
      select: {
        name: true,
        steps: {
          ...(stepFilter?.length
            ? { where: { stepNumber: { in: stepFilter } } }
            : {}),
          orderBy: { stepNumber: 'asc' },
          select: {
            stepNumber: true,
            title: true,
            branches: {
              orderBy: { sortOrder: 'asc' },
              select: {
                branchLabel: true,

                actions: {
                  orderBy: { sortOrder: 'asc' },
                  select: { actionType: true, content: true }
                }
              }
            }
          }
        }
      }
    });
    console.log(`\n##### script ${scriptId} (${s?.name})`);
    for (const st of s?.steps ?? []) {
      console.log(`--- step ${st.stepNumber}: ${st.title}`);
      for (const b of st.branches)
        console.log(
          `  ${b.branchLabel}: ${b.actions.map((x) => x.actionType + (x.content ? `(${x.content.slice(0, 28).replace(/\n/g, ' ')})` : '')).join(' > ')}`
        );
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
