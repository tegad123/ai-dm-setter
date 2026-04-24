import { detectDistress } from '../src/lib/distress-detector';
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
  ['going through my darkest season right now', true, 'darkest_season — HARD']
];
let pass = 0,
  fail = 0;
for (const [text, expected, label] of cases) {
  const r = detectDistress(text);
  const ok = r.detected === expected;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}: detected=${r.detected} label=${r.label ?? '-'} match=${r.match ?? '-'}${r.helpPleaMatch ? ` helpPlea="${r.helpPleaMatch}"` : ''}`
  );
}
console.log(`\nResults: ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
