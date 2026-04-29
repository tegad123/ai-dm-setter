/* eslint-disable no-console */
// Pure-logic test for the currency_unclear path. Mirrors the
// confidence-grading shape from detectConversationCurrencyConfidence
// without hitting Postgres. The detectCurrencyFromText helper is
// pure and exported.
import { detectCurrencyFromText } from '../src/lib/ai-engine';

interface Case {
  label: string;
  answer: string;
  priorLeadMessages: string[];
  expectConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function gradeConfidence(
  answer: string,
  priorLeadMessages: string[]
): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (detectCurrencyFromText(answer)) return 'HIGH';
  for (const msg of priorLeadMessages) {
    if (detectCurrencyFromText(msg)) return 'MEDIUM';
  }
  return 'LOW';
}

const cases: Case[] = [
  // Paul 2026-04-29: # symbol not in detector list, no prior context
  {
    label: 'Paul: # symbol → LOW',
    answer: '#100000',
    priorLeadMessages: [],
    expectConfidence: 'LOW'
  },
  // Bare number with no context
  {
    label: 'Plain "5000" with no context → LOW',
    answer: '5000',
    priorLeadMessages: ['been trading for 2 years'],
    expectConfidence: 'LOW'
  },
  // Recognized symbol
  {
    label: '"$2,000" → HIGH',
    answer: '$2,000',
    priorLeadMessages: [],
    expectConfidence: 'HIGH'
  },
  {
    label: '"₦100,000" → HIGH',
    answer: '₦100,000',
    priorLeadMessages: [],
    expectConfidence: 'HIGH'
  },
  {
    label: '"500 quid" → HIGH (GBP)',
    answer: '500 quid',
    priorLeadMessages: [],
    expectConfidence: 'HIGH'
  },
  {
    label: '"3000 naira" → HIGH (NGN)',
    answer: '3000 naira',
    priorLeadMessages: [],
    expectConfidence: 'HIGH'
  },
  // MEDIUM: prior message has a recognized currency word
  {
    label: 'Bare "5000" + prior "from naira" → MEDIUM (NGN context)',
    answer: '5000',
    priorLeadMessages: ['I been trading', "earnings i'm getting are in naira"],
    expectConfidence: 'MEDIUM'
  },
  {
    label: 'Bare "1000" + prior "₱2000" → MEDIUM (PHP context)',
    answer: '1000',
    priorLeadMessages: ['my last challenge i had ₱2000 at one point'],
    expectConfidence: 'MEDIUM'
  },
  // No country-only mention without currency word stays LOW (we are
  // intentionally NOT bridging country→currency, see detector list)
  {
    label: 'Bare "5000" + prior just "philippines" word → LOW',
    answer: '5000',
    priorLeadMessages: ["i'm in the philippines"],
    expectConfidence: 'LOW'
  }
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const got = gradeConfidence(c.answer, c.priorLeadMessages);
  const ok = got === c.expectConfidence;
  if (ok) {
    pass++;
    console.log(`PASS  ${c.label} → ${got}`);
  } else {
    fail++;
    console.log(`FAIL  ${c.label} → ${got}, expected ${c.expectConfidence}`);
  }
}

console.log(
  `\n${pass}/${cases.length} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
