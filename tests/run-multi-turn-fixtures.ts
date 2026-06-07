/* eslint-disable no-console */
// Runner for multi-turn stateful fixtures. These replay full conversations
// turn-by-turn through the REAL computeSystemStage with state carried forward,
// catching the stateful position-lag bug that single-turn fixtures cannot see.
//
//   npx tsx tests/run-multi-turn-fixtures.ts
//
// Exit code 0 if all pass, 1 if any fail. A fixture named `repro-*` is EXPECTED
// to fail on pre-fix code (that red is the proof the test catches the bug).

import { readdirSync } from 'fs';
import { join } from 'path';
import { runMultiTurnFixture } from './multi-turn-fixtures/harness';
import type { MultiTurnFixture } from './multi-turn-fixtures/types';

const DIR = join(__dirname, 'multi-turn-fixtures');

async function main() {
  const files = readdirSync(DIR).filter((f) => /\.fixture\.ts$/.test(f));
  files.sort();

  let passed = 0;
  let failed = 0;

  for (const f of files) {
    const mod = await import(join(DIR, f));
    const fixture: MultiTurnFixture | undefined = mod.fixture;
    if (!fixture) {
      console.log(`SKIP  ${f} — no \`fixture\` export`);
      continue;
    }
    const result = runMultiTurnFixture(fixture);
    const tag = result.passed ? 'PASS' : 'FAIL';
    console.log(`\n${tag}  ${fixture.id} — ${fixture.description}`);
    // Turn-by-turn trace
    for (const t of result.traces) {
      const flag = t.lag > 0 ? `  (lag ${t.lag})` : '';
      console.log(
        `      turn ${String(t.turn).padStart(2)}: trueStep=${t.aiStepNumber} tracked=${t.trackedStep}${flag}  [${t.reason}]`
      );
    }
    if (!result.passed) {
      for (const fail of result.failures) console.log(`      ✗ ${fail}`);
      failed += 1;
    } else {
      passed += 1;
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed (${files.length} fixtures)`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
