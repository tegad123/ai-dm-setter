/* eslint-disable no-console */
// Pure-logic test for the time-stripping fix in
// parseLeadAmountDetailsFromReply (Wout Lngrs follow-up,
// 2026-05-01). Time tokens like "12am", "9:30am", "3 pm",
// "14:00", "5 o'clock" are stripped before the bare-number
// regex runs; real $ amounts and "5k" survive.
import { parseLeadCapitalAnswer } from '../src/lib/ai-engine';

const cases: Array<{
  label: string;
  input: string;
  expectAmount: number | null;
}> = [
  {
    label: 'Wout: "Yeah 12am is perfect" → not 12',
    input: 'Yeah 12am is perfect',
    expectAmount: null
  },
  {
    label: '"3pm works" → not 3',
    input: '3pm works for me bro',
    expectAmount: null
  },
  {
    label: '"meet at 9:30am" → not 9 or 30',
    input: 'sure lets meet at 9:30am',
    expectAmount: null
  },
  {
    label: '"5 pm cdt" → not 5',
    input: '5 pm cdt is good',
    expectAmount: null
  },
  {
    label: 'real $ amount survives',
    input: 'I have $5000 saved',
    expectAmount: 5000
  },
  {
    label: 'real amount with time present',
    input: 'I have $2,000 saved up, lets do 3pm',
    expectAmount: 2000
  },
  {
    label: '"5 oclock" → not 5',
    input: 'how about 5 o’clock?',
    expectAmount: null
  },
  {
    label: '14:00 24h time → not 14',
    input: 'lets do 14:00 your time',
    expectAmount: null
  },
  {
    label: '"in 12 hours" → not 12',
    input: 'I expected it to be in 12 hours so I was already in bed',
    expectAmount: null
  },
  {
    label: '"2 hours ago" → not 2',
    input: 'that was like 2 hours ago bro',
    expectAmount: null
  },
  {
    label: '"12 hours" with $ amount elsewhere keeps real amount',
    input: 'I have $5,000 but thought the call was in 12 hours',
    expectAmount: 5000
  },
  { label: '5k still parses', input: 'got 5k saved', expectAmount: 5000 }
];

let pass = 0,
  fail = 0;
for (const c of cases) {
  const r = parseLeadCapitalAnswer(c.input);
  const got = r.kind === 'amount' ? r.amount : null;
  if (got === c.expectAmount) {
    pass++;
    console.log(`PASS  ${c.label} → ${got}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.label} → ${got}, expected ${c.expectAmount}`);
  }
}
console.log(
  `\n${pass}/${cases.length} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
