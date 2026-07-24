import { detectDistressSync } from '../src/lib/distress-detector';
const cases: Array<[string, boolean, string]> = [
  [
    'Chairman I need your help am a Christian like you a born again am still a strongly trader 3years I am not consistency please help me how do you use sessions liquidity models strategy',
    false,
    'Uzualu — trading help, NOT distress'
  ],
  ['please help me with my trading strategy', false, 'TEST 1'],
  ["please help me I can't go on like this", true, 'TEST 2'],
  ['my trading is broken, nothing is working', false, 'TEST 3'],
  [
    "I'm completely broken, I don't want to be here anymore",
    true,
    'TEST 4 — indirect_ideation'
  ],
  ['I want to give up on life itself', true, 'existing — direct_ideation'],
  [
    'been so stressed out this month with my strategy',
    false,
    'soft alone — no fire'
  ],
  [
    "I'm broken and stressed up, please help me bro",
    true,
    'soft + help_plea combo'
  ],
  ['help me bro', false, 'help_plea alone — no fire'],
  ['you are my last hope bro please help', true, 'last_hope_appeal — HARD'],
  ['going through my darkest season right now', true, 'darkest_season — HARD'],
  // Caregiver / hardship (added 2026-07-01).
  // NOTE 2026-07-22: these two were asserted `true` and have been FAILING
  // silently — no regex in any tier matches them, because "my mother got
  // paralyzed" carries no fixed distress wording. They are expected MISSES
  // on the sync/regex path and are covered by the classifier instead; see
  // scripts/test-distress-async.ts. Asserting them false here is not a
  // lowered bar, it is an accurate statement of what regex can do.
  [
    'my mother got paralyzed back in 2024, i have been taking care of her and trying to make ends meet',
    false,
    'caregiver — CLASSIFIER-ONLY (regex cannot express; see async suite)'
  ],
  [
    'my dad is bedridden and I am taking care of him',
    false,
    'caregiver — CLASSIFIER-ONLY (regex cannot express; see async suite)'
  ],
  [
    'i cant afford rent this month',
    true,
    'financial_hardship — cant afford rent'
  ],
  [
    'things are tough in the markets right now',
    false,
    'tough markets — NOT distress'
  ],

  // ── F1 regression set (2026-07-22) ────────────────────────────────
  // The four phrasings from Tega's adversarial run. The FIRST one is the
  // exact message that shipped to production and was missed, because the
  // pattern was `give up on life` and the lead wrote `giving`. These must
  // never regress.
  [
    'honestly man some days i feel like giving up on life',
    true,
    'F1 — PROD MISS: gerund "giving" (was: give)'
  ],
  ['dont wanna be here anymore', true, 'F1 — indirect, no apostrophe'],
  ["what's the point of any of this", true, 'F1 — "any of this" (was: living)'],
  ["i'm done with everything", true, 'F1 — "everything" (was: life)'],
  // F1 — live Shazim repro 2026-07-24 MISS: intervening "even" broke the
  // adjacency the pattern required. These must never regress.
  [
    'honestly some days i dont even wanna be here anymore',
    true,
    'F1 — PROD MISS: "dont EVEN wanna be here anymore"'
  ],
  ['i dont really want to live anymore', true, 'F1 — "really" + "anymore"'],
  ['i just dont wanna be here anymore', true, 'F1 — "just" intervening'],
  // False-positive guards for the widened patterns above.
  [
    'this market is killing me',
    false,
    'F1 FP guard — hyperbole, not self-harm'
  ],
  ['im dead bro 😂', false, 'F1 FP guard — slang'],
  ['i blew my account last week', false, 'F1 FP guard — trading loss']
];
let pass = 0,
  fail = 0;
for (const [text, expected, label] of cases) {
  const r = detectDistressSync(text);
  const ok = r.detected === expected;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}: detected=${r.detected} label=${r.label ?? '-'} match=${r.match ?? '-'}${r.helpPleaMatch ? ` helpPlea="${r.helpPleaMatch}"` : ''}`
  );
}
console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
