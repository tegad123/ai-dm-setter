/**
 * Classifier-first distress detector — offline logic tests (kill switch, fast
 * paths, fail-closed semantics) plus an OPTIONAL live smoke test against the
 * real Haiku API for the phrases regex cannot express (caregiving, novel
 * ideation phrasings). The live portion runs only when RUN_LIVE=1 and an
 * ANTHROPIC_API_KEY is present, so CI stays deterministic and free.
 *
 * Run:            npx tsx scripts/test-distress-classifier-first.ts
 * Run with live:  RUN_LIVE=1 npx tsx scripts/test-distress-classifier-first.ts
 */
import assert from 'node:assert/strict';
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });

import {
  classifyDistress,
  isClassifierEnabled
} from '../src/lib/distress-classifier';

async function run() {
  // ── Kill switch ──────────────────────────────────────────────────────────
  process.env.DISTRESS_CLASSIFIER_ENABLED = 'false';
  assert.equal(isClassifierEnabled(), false, 'kill switch off → disabled');
  const disabled = await classifyDistress('i feel like giving up on life');
  assert.equal(disabled.ok, false, 'disabled → ok=false (fail-closed signal)');
  assert.equal(disabled.detected, false, 'disabled → detected=false');
  assert.equal(disabled.reason, 'classifier_disabled', 'disabled reason');

  process.env.DISTRESS_CLASSIFIER_ENABLED = 'true';
  assert.equal(isClassifierEnabled(), true, 'default → enabled');
  // Any other value still enabled (only literal "false" disables).
  process.env.DISTRESS_CLASSIFIER_ENABLED = 'yes';
  assert.equal(isClassifierEnabled(), true, 'non-false value → enabled');
  delete process.env.DISTRESS_CLASSIFIER_ENABLED;
  assert.equal(isClassifierEnabled(), true, 'unset → enabled by default');

  // ── Empty / whitespace fast path (no API call, ok=true) ──────────────────
  const empty = await classifyDistress('   ');
  assert.equal(empty.ok, true, 'empty → ok=true');
  assert.equal(empty.detected, false, 'empty → not detected');

  console.log('classifier-first offline logic tests passed');

  // ── Live smoke (opt-in) — the phrases regex MISSES ───────────────────────
  if (process.env.RUN_LIVE === '1' && process.env.ANTHROPIC_API_KEY) {
    const mustFire = [
      'my mother got paralyzed back in 2024, i have been taking care of her',
      'my dad is bedridden and i am taking care of him',
      'honestly some days i dont even wanna be here anymore',
      'i lost my brother last month and cant cope'
    ];
    const mustNotFire = [
      'this market is killing me',
      'im dead bro 😂',
      'i blew my account last week',
      'i need more money to pay my bills'
    ];
    let live = 0;
    let liveBad = 0;
    for (const t of mustFire) {
      const r = await classifyDistress(t);
      const ok = r.ok && r.detected;
      if (ok) live++;
      else {
        liveBad++;
        console.log(
          `LIVE MISS (should fire): ok=${r.ok} det=${r.detected} :: ${t}`
        );
      }
    }
    for (const t of mustNotFire) {
      const r = await classifyDistress(t);
      const ok = r.ok && !r.detected;
      if (ok) live++;
      else {
        liveBad++;
        console.log(`LIVE FP (should not fire): cat=${r.category} :: ${t}`);
      }
    }
    console.log(
      `live smoke: ${live}/${mustFire.length + mustNotFire.length} correct` +
        (liveBad ? ` (${liveBad} wrong)` : '')
    );
    assert.equal(liveBad, 0, 'live classifier smoke had failures');
    console.log('classifier-first LIVE smoke passed (incl. caregiving misses)');
  } else {
    console.log('(live smoke skipped — set RUN_LIVE=1 + ANTHROPIC_API_KEY)');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
