/* eslint-disable no-console */
import { readdirSync } from 'fs';
import { join } from 'path';
import { runAssertion } from './conversation-fixtures/assertions';
import type { ConversationFixture } from './conversation-fixtures/types';

const FIXTURE_DIR = join(__dirname, 'conversation-fixtures');

interface RunOutcome {
  fixture: ConversationFixture;
  passed: boolean;
  evidence: string;
  errorMessage?: string;
  durationMs: number;
}

async function loadFixtures(): Promise<ConversationFixture[]> {
  const files = readdirSync(FIXTURE_DIR).filter((f) =>
    /^bug-\d+-.+\.fixture\.ts$/.test(f)
  );
  files.sort();
  const fixtures: ConversationFixture[] = [];
  for (const f of files) {
    // Dynamic import keeps compile-time pressure low and isolates per-
    // fixture failures (a syntax error in one fixture won't crash the
    // whole runner before the others have a chance to print).
    const mod = await import(join(FIXTURE_DIR, f));
    const fixture: ConversationFixture | undefined = mod.fixture;
    if (!fixture) {
      throw new Error(`fixture file ${f} did not export \`fixture\``);
    }
    fixtures.push(fixture);
  }
  return fixtures;
}

async function runOne(fixture: ConversationFixture): Promise<RunOutcome> {
  const start = Date.now();
  try {
    const result = runAssertion(fixture);
    return {
      fixture,
      passed: result.passed,
      evidence: result.evidence,
      durationMs: Date.now() - start
    };
  } catch (e) {
    return {
      fixture,
      passed: false,
      evidence: '',
      errorMessage: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start
    };
  }
}

function formatLine(o: RunOutcome): string {
  const tag = o.passed ? 'PASS' : 'FAIL';
  const head = `${tag}  bug-${String(o.fixture.bug).padStart(2, '0')} ${o.fixture.slug} (${o.fixture.assertion.type}, ${o.durationMs}ms)`;
  if (o.passed) return head + `\n      ${o.evidence}`;
  if (o.errorMessage) return head + `\n      ERROR: ${o.errorMessage}`;
  return head + `\n      ${o.evidence}`;
}

async function main() {
  const fixtures = await loadFixtures();
  if (fixtures.length === 0) {
    console.error('No fixtures found in', FIXTURE_DIR);
    process.exit(1);
  }
  const start = Date.now();
  const results = await Promise.all(fixtures.map(runOne));
  const totalMs = Date.now() - start;

  for (const r of results) console.log(formatLine(r));

  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.length - passCount;
  console.log('');
  console.log(`${passCount}/${results.length} passed in ${totalMs}ms`);
  if (failCount > 0) {
    console.log(`${failCount} failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(1);
});
