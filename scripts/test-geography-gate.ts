/* eslint-disable no-console */
// Pure-logic tests for geography-gate.ts. Covers detection precision
// (allowed-list wins over disallowed, currency symbols, # naira shape,
// timezone-only stays MEDIUM) and isFirstWorldCountry semantics.
import {
  detectGeography,
  isFirstWorldCountry
} from '../src/lib/geography-gate';

interface DetectCase {
  label: string;
  messages: string[];
  expectCountry: string | null;
  expectConfidence: 'high' | 'medium';
}

const detectCases: DetectCase[] = [
  // Direct country / city matches
  {
    label: 'Nigeria by name',
    messages: ["I'm from Nigeria"],
    expectCountry: 'Nigeria',
    expectConfidence: 'high'
  },
  {
    label: 'Manila city',
    messages: ['based in manila bro'],
    expectCountry: 'Philippines',
    expectConfidence: 'high'
  },
  {
    label: 'Lagos city',
    messages: ['just got back to lagos'],
    expectCountry: 'Nigeria',
    expectConfidence: 'high'
  },
  // Currency symbols / shapes
  {
    label: '₦ symbol triggers Nigeria',
    messages: ['I got ₦500,000 saved'],
    expectCountry: 'Nigeria',
    expectConfidence: 'high'
  },
  {
    label: '# naira shape (Paul case)',
    messages: ['#100000'],
    expectCountry: 'Nigeria',
    expectConfidence: 'high'
  },
  {
    label: '₱ peso → Philippines',
    messages: ['I have ₱2000'],
    expectCountry: 'Philippines',
    expectConfidence: 'high'
  },
  {
    label: '₹ rupee → India',
    messages: ['saved ₹50000 so far'],
    expectCountry: 'India',
    expectConfidence: 'high'
  },
  // Allowed-list passes
  {
    label: 'US state (Texas) → United States',
    messages: ["I'm in Texas"],
    expectCountry: 'United States',
    expectConfidence: 'high'
  },
  {
    label: 'London → United Kingdom',
    messages: ['based in london'],
    expectCountry: 'United Kingdom',
    expectConfidence: 'high'
  },
  {
    label: 'Dubai → UAE (allowed)',
    messages: ["I'm in Dubai"],
    expectCountry: 'United Arab Emirates',
    expectConfidence: 'high'
  },
  {
    label: 'Sydney → Australia',
    messages: ['Sydney based'],
    expectCountry: 'Australia',
    expectConfidence: 'high'
  },
  // Allowed wins over disallowed when both signals present
  {
    label: 'US-based Nigerian: US wins',
    messages: ["I'm a US-based Nigerian, originally from Lagos"],
    expectCountry: 'United States',
    expectConfidence: 'high'
  },
  // Timezone-only stays MEDIUM
  {
    label: 'IST mentioned in passing → MEDIUM',
    messages: ['can we do 9am IST tomorrow'],
    expectCountry: 'India',
    expectConfidence: 'medium'
  },
  {
    label: 'EAT mentioned alone → MEDIUM',
    messages: ['I work in EAT timezone'],
    expectCountry: 'Kenya', // first match in our list with EAT
    expectConfidence: 'medium'
  },
  // Unknown — passes through
  {
    label: 'No geography signal → null',
    messages: ['been trading for 2 years on demo'],
    expectCountry: null,
    expectConfidence: 'medium'
  },
  {
    label: 'Empty messages → null',
    messages: [],
    expectCountry: null,
    expectConfidence: 'medium'
  }
];

let pass = 0;
let fail = 0;
for (const c of detectCases) {
  const got = detectGeography(c.messages);
  const ok =
    got.country === c.expectCountry && got.confidence === c.expectConfidence;
  if (ok) {
    pass++;
    console.log(
      `PASS  detect: ${c.label} → ${got.country ?? 'null'} (${got.confidence})`
    );
  } else {
    fail++;
    console.log(
      `FAIL  detect: ${c.label} → ${got.country ?? 'null'} (${got.confidence}), expected ${c.expectCountry ?? 'null'} (${c.expectConfidence})`
    );
  }
}

interface FirstWorldCase {
  country: string | null;
  expect: boolean;
}

const fwCases: FirstWorldCase[] = [
  { country: 'United States', expect: true },
  { country: 'United Kingdom', expect: true },
  { country: 'Singapore', expect: true },
  { country: 'United Arab Emirates', expect: true },
  { country: 'Nigeria', expect: false },
  { country: 'India', expect: false },
  { country: 'Philippines', expect: false },
  { country: 'Brazil', expect: false },
  // Unknown → pass (never block when unsure)
  { country: 'Atlantis', expect: true },
  { country: '', expect: true },
  { country: null, expect: true }
];

for (const c of fwCases) {
  const got = isFirstWorldCountry(c.country);
  const ok = got === c.expect;
  if (ok) {
    pass++;
    console.log(`PASS  fw: "${c.country ?? 'null'}" → ${got}`);
  } else {
    fail++;
    console.log(
      `FAIL  fw: "${c.country ?? 'null'}" → ${got}, expected ${c.expect}`
    );
  }
}

const total = detectCases.length + fwCases.length;
console.log(`\n${pass}/${total} passed${fail > 0 ? `, ${fail} failed` : ''}`);
if (fail > 0) process.exit(1);
