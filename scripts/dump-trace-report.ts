// Trace-dump report generator for adversarial-run verification.
// Produces a readable per-turn markdown dump (branch_selected, stage_emitted,
// variables_state, hard fails, reply) for one or more conversations — the
// exact fields Tega requires for trace-level verification.
//
// Usage:
//   npx tsx scripts/dump-trace-report.ts <convId> [convId...]          # markdown to stdout
//   npx tsx scripts/dump-trace-report.ts <convId> --prompts            # include full prompt per turn
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: (process.env.PROD_DATABASE_URL ?? '')
        .replace(':6543/', ':5432/')
        .replace('?pgbouncer=true', '')
    }
  }
});
async function retry<T>(fn: () => Promise<T>, t = 12): Promise<T> {
  let l: unknown;
  for (let i = 0; i < t; i++) {
    try {
      return await fn();
    } catch (e) {
      l = e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw l;
}
async function main() {
  const args = process.argv.slice(2);
  const includePrompts = args.includes('--prompts');
  const convIds = args.filter((a) => !a.startsWith('--'));
  if (convIds.length === 0) {
    console.error(
      'usage: dump-trace-report.ts <convId> [convId...] [--prompts]'
    );
    process.exit(1);
  }
  for (const convId of convIds) {
    const conv = await retry(() =>
      prisma.conversation.findUnique({
        where: { id: convId },
        select: {
          id: true,
          systemStage: true,
          currentScriptStep: true,
          awaitingHumanReview: true,
          distressDetected: true,
          capturedDataPoints: true,
          lead: { select: { name: true } }
        }
      })
    );
    if (!conv) {
      console.log(`\n# ${convId} — NOT FOUND\n`);
      continue;
    }
    console.log(
      `\n---\n\n# Trace report — ${conv.lead?.name ?? '?'} (\`${convId}\`)`
    );
    console.log(
      `Final state: step=${conv.currentScriptStep} stage="${conv.systemStage}" awaitingHuman=${conv.awaitingHumanReview} distress=${conv.distressDetected}\n`
    );

    // transcript
    const msgs = await retry(() =>
      prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true, sender: true, content: true }
      })
    );
    console.log(`## Transcript (${msgs.length} messages)\n`);
    console.log('| time | who | message |');
    console.log('|---|---|---|');
    msgs.forEach((m) =>
      console.log(
        `| ${m.timestamp.toISOString().slice(11, 19)} | ${m.sender} | ${m.content.replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 120)} |`
      )
    );

    // traces
    const traces = await retry(() =>
      prisma.generationTurnTrace.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: 'asc' },
        select: {
          createdAt: true,
          stepNumber: true,
          systemStage: true,
          stageEmitted: true,
          subStageEmitted: true,
          branchSelected: true,
          replyPreview: true,
          qualityHardFails: true,
          variablesState: true,
          promptSent: includePrompts,
          promptChars: true
        }
      })
    );
    console.log(`\n## Generation turns (${traces.length})\n`);
    traces.forEach((t, i) => {
      console.log(
        `### Turn ${i} — ${t.createdAt.toISOString().slice(11, 19)} · step=${t.stepNumber} · system_stage="${t.systemStage}" · stage_emitted=${t.stageEmitted}${t.subStageEmitted ? '/' + t.subStageEmitted : ''} · branch_selected="${t.branchSelected}"`
      );
      console.log(`- reply: ${(t.replyPreview ?? '').slice(0, 200)}`);
      const vs = t.variablesState as unknown;
      if (Array.isArray(vs) && vs.length) {
        console.log('- variables_state:');
        (
          vs as Array<{
            name: string;
            value: unknown;
            source: string;
            confidence?: string;
          }>
        ).forEach((v) =>
          console.log(
            `  - \`${v.name}\` = ${JSON.stringify(v.value)} — source=${v.source}${v.confidence ? ' conf=' + v.confidence : ''}`
          )
        );
      }
      const hf = t.qualityHardFails as unknown;
      if (Array.isArray(hf) && hf.length) {
        console.log('- quality hard fails:');
        (hf as string[]).forEach((f) =>
          console.log(`  - ${String(f).slice(0, 200)}`)
        );
      }
      if (includePrompts && t.promptSent) {
        console.log(`- prompt_sent (${t.promptChars} chars):`);
        console.log('```');
        console.log(t.promptSent.slice(0, 8000));
        console.log('```');
      }
      console.log('');
    });

    // final captured points
    const cdp = (conv.capturedDataPoints ?? {}) as Record<string, any>;
    const skip = new Set([
      'branchHistory',
      'generateReplyTrace',
      'lastClassifierTrace',
      'lastStepCompletionTrace',
      'stepCompletionTrace'
    ]);
    console.log('## Final captured variables\n');
    console.log('| variable | value | method | confidence |');
    console.log('|---|---|---|---|');
    Object.entries(cdp)
      .filter(([k]) => !skip.has(k))
      .forEach(([k, v]) =>
        console.log(
          `| ${k} | ${JSON.stringify(v?.value !== undefined ? v.value : v).slice(0, 80)} | ${v?.extractionMethod ?? '?'} | ${v?.confidence ?? '?'} |`
        )
      );
  }
  await prisma.$disconnect();
}
main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error(e.message);
    await prisma.$disconnect();
    process.exit(1);
  });
