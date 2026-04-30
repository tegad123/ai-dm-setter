/* eslint-disable no-console */
// Pure-logic tests for the 2026-04-30 capital qualification refactor.
// Covers AUD/NZD currency conversion, "very little" vague handling,
// pre-objection detection, earlyCapitalGate trigger logic.
import {
  convertCapitalAmountToUsd,
  detectCurrencyFromText,
  parseLeadCapitalAnswer,
  leadHasPreObjectedToCapital,
  aiResponseAddressesPreObjection
} from '../src/lib/ai-engine';

interface ConvertCase {
  label: string;
  amount: number;
  currency:
    | 'USD'
    | 'GBP'
    | 'EUR'
    | 'CAD'
    | 'AUD'
    | 'NZD'
    | 'NGN'
    | 'PHP'
    | 'KES';
  expectMin: number;
  expectMax: number;
}

const convertCases: ConvertCase[] = [
  {
    label: 'NZD 2000 ≈ 1220 USD',
    amount: 2000,
    currency: 'NZD',
    expectMin: 1200,
    expectMax: 1240
  },
  {
    label: 'AUD 2000 ≈ 1300 USD',
    amount: 2000,
    currency: 'AUD',
    expectMin: 1280,
    expectMax: 1320
  },
  {
    label: 'GBP 1000 ≈ 1250 USD',
    amount: 1000,
    currency: 'GBP',
    expectMin: 1240,
    expectMax: 1260
  },
  {
    label: 'USD 1000 = 1000 USD',
    amount: 1000,
    currency: 'USD',
    expectMin: 999,
    expectMax: 1001
  }
];

let pass = 0;
let fail = 0;

for (const c of convertCases) {
  const got = convertCapitalAmountToUsd(c.amount, c.currency);
  const ok = got >= c.expectMin && got <= c.expectMax;
  if (ok) {
    pass++;
    console.log(`PASS  convert: ${c.label} → ${got.toFixed(2)} USD`);
  } else {
    fail++;
    console.log(
      `FAIL  convert: ${c.label} → ${got.toFixed(2)} USD, expected [${c.expectMin}, ${c.expectMax}]`
    );
  }
}

interface DetectCase {
  label: string;
  input: string;
  expect: string | null;
}

const detectCases: DetectCase[] = [
  { label: '"AUD 1500" → AUD', input: 'I have AUD 1500', expect: 'AUD' },
  {
    label: '"aussie dollar" → AUD',
    input: '2k in aussie dollars',
    expect: 'AUD'
  },
  {
    label: '"NZD 2000" → NZD',
    input: 'about NZD 2000 saved',
    expect: 'NZD'
  },
  {
    label: '"kiwi dollar" → NZD',
    input: '500 kiwi dollars',
    expect: 'NZD'
  },
  {
    label: 'NZ$5000 → NZD',
    input: 'I got NZ$5000',
    expect: 'NZD'
  },
  {
    label: '"$5000" still → USD',
    input: 'I got $5000',
    expect: 'USD'
  }
];

for (const c of detectCases) {
  const got = detectCurrencyFromText(c.input);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`PASS  detect: ${c.label} (${got})`);
  } else {
    fail++;
    console.log(`FAIL  detect: ${c.label} got=${got} expected=${c.expect}`);
  }
}

interface ParserCase {
  label: string;
  input: string;
  expectKind: string;
  expectReason?: string;
}

const parserCases: ParserCase[] = [
  {
    label: 'Steven exact: "very little tbh"',
    input: 'very little tbh',
    expectKind: 'ambiguous',
    expectReason: 'vague_no_number'
  },
  {
    label: '"barely anything"',
    input: 'barely anything atm',
    expectKind: 'ambiguous',
    expectReason: 'vague_no_number'
  },
  {
    label: '"$1500" still → amount',
    input: 'I got $1500',
    expectKind: 'amount'
  }
];

for (const c of parserCases) {
  const r = parseLeadCapitalAnswer(c.input);
  const ok =
    r.kind === c.expectKind && (!c.expectReason || r.reason === c.expectReason);
  if (ok) {
    pass++;
    console.log(
      `PASS  parser: ${c.label} → ${r.kind} reason=${r.reason ?? '-'}`
    );
  } else {
    fail++;
    console.log(
      `FAIL  parser: ${c.label} → ${r.kind} reason=${r.reason ?? '-'}, expected ${c.expectKind} reason=${c.expectReason ?? '-'}`
    );
  }
}

interface PreObjCase {
  label: string;
  msgs: string[];
  expect: boolean;
}

const preObjCases: PreObjCase[] = [
  {
    label: 'Steven exact: "anyone asking for a lot is a red flag"',
    msgs: [
      'Very little tbh I was told to start small and work up anyone asking for a lot would be a red flag'
    ],
    expect: true
  },
  {
    label: '"I\'m on a tight budget"',
    msgs: ["I'm on a tight budget rn"],
    expect: true
  },
  {
    label: '"don\'t want to spend much"',
    msgs: ["I don't wanna spend a lot"],
    expect: true
  },
  {
    label: 'no objection in plain text',
    msgs: ['been trading 2 years on demo'],
    expect: false
  },
  {
    label: 'pre-objection in older message — slides outside 4-window',
    msgs: [
      'red flag if you ask for a lot',
      'msg2',
      'msg3',
      'msg4',
      'newest msg with no concern'
    ],
    expect: false
  }
];

for (const c of preObjCases) {
  const got = leadHasPreObjectedToCapital(c.msgs);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`PASS  preObj: ${c.label} → ${got}`);
  } else {
    fail++;
    console.log(`FAIL  preObj: ${c.label} got=${got} expected=${c.expect}`);
  }
}

const reassureCases: { label: string; reply: string; expect: boolean }[] = [
  {
    label: 'reassurance phrase: "no pressure"',
    reply: "nah bro no pressure, just need to know what you're working with",
    expect: true
  },
  {
    label: 'reassurance phrase: "not here to pressure"',
    reply: "i'm not here to pressure you into anything bro",
    expect: true
  },
  {
    label: 'no reassurance — straight capital ask',
    reply: 'how much do you have set aside for the markets?',
    expect: false
  }
];

for (const c of reassureCases) {
  const got = aiResponseAddressesPreObjection(c.reply);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`PASS  reassure: ${c.label} → ${got}`);
  } else {
    fail++;
    console.log(`FAIL  reassure: ${c.label} got=${got} expected=${c.expect}`);
  }
}

// earlyCapitalGate trigger condition (replicated inline since the
// production check is embedded in the directive assembly path).
function shouldEarlyGateFire(
  enabled: boolean,
  threshold: number | null,
  capitalAsked: boolean,
  aiMsgCount: number,
  stage: string
): boolean {
  return (
    enabled &&
    typeof threshold === 'number' &&
    threshold > 0 &&
    !capitalAsked &&
    aiMsgCount >= 4 &&
    (stage === 'NEW_LEAD' ||
      stage === 'ENGAGED' ||
      stage === 'QUALIFYING' ||
      !stage)
  );
}

const earlyCases: {
  label: string;
  args: [boolean, number | null, boolean, number, string];
  expect: boolean;
}[] = [
  {
    label: 'on + threshold + 4 ai msgs + QUALIFYING + not asked → fires',
    args: [true, 1000, false, 4, 'QUALIFYING'],
    expect: true
  },
  {
    label: 'off → does not fire',
    args: [false, 1000, false, 5, 'QUALIFYING'],
    expect: false
  },
  {
    label: 'capital already asked → does not fire',
    args: [true, 1000, true, 5, 'QUALIFYING'],
    expect: false
  },
  {
    label: 'only 3 ai msgs → does not fire',
    args: [true, 1000, false, 3, 'QUALIFYING'],
    expect: false
  },
  {
    label: 'past QUALIFYING → does not fire',
    args: [true, 1000, false, 5, 'BOOKED'],
    expect: false
  },
  {
    label: 'no threshold configured → does not fire',
    args: [true, null, false, 5, 'QUALIFYING'],
    expect: false
  }
];

for (const c of earlyCases) {
  const got = shouldEarlyGateFire(...c.args);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`PASS  earlyGate: ${c.label} → ${got}`);
  } else {
    fail++;
    console.log(`FAIL  earlyGate: ${c.label} got=${got} expected=${c.expect}`);
  }
}

const total = pass + fail;
console.log(`\n${pass}/${total} passed${fail > 0 ? `, ${fail} failed` : ''}`);
if (fail > 0) process.exit(1);
