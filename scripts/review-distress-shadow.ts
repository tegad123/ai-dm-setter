// Joint-review tool for the classifier-first shadow-mode rollout.
// Prints the regex-vs-classifier comparison from DistressShadowLog: overall
// agreement rate, and — most importantly — every DISAGREEMENT (the cases the
// classifier would have paused that regex did not, and vice-versa). These rows
// are what Tega + eng review together before flipping the classifier
// authoritative ("data, not vibes").
//
// Usage:
//   npx tsx scripts/review-distress-shadow.ts            # last 7 days
//   npx tsx scripts/review-distress-shadow.ts --disagreements-only
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
  const disagreementsOnly = process.argv.includes('--disagreements-only');
  const rows = await retry(() =>
    prisma.distressShadowLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 1000
    })
  );
  const total = rows.length;
  const agreed = rows.filter((r) => r.agreed).length;
  const classifierFiredRegexDidnt = rows.filter(
    (r) => r.classifierDetected && !r.regexDetected
  );
  const regexFiredClassifierDidnt = rows.filter(
    (r) => r.regexDetected && !r.classifierDetected
  );
  const classifierUnavailable = rows.filter((r) => !r.classifierOk).length;

  console.log(`=== Distress shadow review (${total} rows) ===`);
  console.log(
    `agreement: ${agreed}/${total} (${total ? ((agreed / total) * 100).toFixed(1) : '0'}%)`
  );
  console.log(
    `classifier FIRED, regex did NOT: ${classifierFiredRegexDidnt.length} (would-be NEW catches)`
  );
  console.log(
    `regex FIRED, classifier did NOT: ${regexFiredClassifierDidnt.length} (would-be MISSES — review carefully)`
  );
  console.log(
    `classifier unavailable (ok=false): ${classifierUnavailable} (fail-closed on the real path)`
  );

  const show = disagreementsOnly ? rows.filter((r) => !r.agreed) : rows;
  console.log(`\n--- ${disagreementsOnly ? 'disagreements' : 'all rows'} ---`);
  for (const r of show) {
    const flag = r.agreed ? '  ' : '❗';
    console.log(
      `${flag} regex=${r.regexDetected ? 'FIRE' : 'no'}(${r.regexLabel ?? '-'}) ` +
        `classifier=${r.classifierDetected ? 'FIRE' : 'no'}(${r.classifierCategory ?? '-'},ok=${r.classifierOk}) ` +
        `${r.latencyMs ?? '?'}ms :: "${r.messageText.slice(0, 70)}"`
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
