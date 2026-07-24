import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
const p = new PrismaClient({
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
  const conv = 'cmrp4fxl1005qle047vnnmcp6';
  // full interleaved transcript
  const msgs = await retry(() =>
    p.message.findMany({
      where: { conversationId: conv },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, sender: true, content: true }
    })
  );
  console.log('=== FULL TRANSCRIPT ===');
  msgs.forEach((m) =>
    console.log(
      `[${m.timestamp.toISOString().slice(11, 19)}] ${m.sender}: ${m.content}`
    )
  );
  // all traces with full detail
  const traces = await retry(() =>
    p.generationTurnTrace.findMany({
      where: { conversationId: conv },
      orderBy: { createdAt: 'asc' },
      select: {
        createdAt: true,
        branchSelected: true,
        stepNumber: true,
        systemStage: true,
        stageEmitted: true,
        subStageEmitted: true,
        replyPreview: true,
        qualityHardFails: true,
        variablesState: true
      }
    })
  );
  console.log('\n=== TRACES (full) ===');
  for (const t of traces) {
    console.log(
      `\n[${t.createdAt.toISOString().slice(11, 19)}] step=${t.stepNumber} sysStage="${t.systemStage}" stageEmitted=${t.stageEmitted}/${t.subStageEmitted} branch="${t.branchSelected}"`
    );
    console.log(`  reply: ${t.replyPreview}`);
    const vs = t.variablesState as any;
    if (vs && Array.isArray(vs))
      vs.forEach((v: any) =>
        console.log(
          `  var ${v.name}=${JSON.stringify(v.value)} [${v.source}/${v.confidence}]`
        )
      );
    else if (vs && typeof vs === 'object')
      Object.entries(vs).forEach(([k, v]: any) =>
        console.log(`  var ${k}=${JSON.stringify(v)}`)
      );
    const hf = t.qualityHardFails as any;
    if (Array.isArray(hf) && hf.length)
      hf.forEach((f: string) => console.log(`  HARDFAIL: ${f.slice(0, 140)}`));
  }
  await p.$disconnect();
}
main().catch(async (e) => {
  console.error(e.message);
  await p.$disconnect();
  process.exit(1);
});
