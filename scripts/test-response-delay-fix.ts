/* eslint-disable no-console */
// Pure-logic test of the new fireAt formula. Mirrors the math in
// webhook-processor.ts inline path. Runs without DB or env.

interface FireAtInput {
  now: number;
  debounceSec: number;
  maxDebounceSec: number;
  delayRandomSec: number;
  earliestLeadTimestamp: number | null;
}

function computeFireAt(i: FireAtInput): number {
  const debouncedFireAt = i.earliestLeadTimestamp
    ? Math.min(
        i.now + i.debounceSec * 1000,
        i.earliestLeadTimestamp + i.maxDebounceSec * 1000
      )
    : i.now + i.debounceSec * 1000;
  const responseDelayFireAt = i.now + i.delayRandomSec * 1000;
  return Math.max(i.now + 1000, debouncedFireAt, responseDelayFireAt);
}

interface TestCase {
  name: string;
  input: FireAtInput;
  expectedDelaySec: number;
  toleranceSec: number;
}

const NOW = 1_700_000_000_000;

const cases: TestCase[] = [
  {
    name: 'Daetradez bug repro: response delay floor wins over debounce cap',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 240, // random(120, 600)
      earliestLeadTimestamp: NOW - 30_000 // first lead 30s ago
    },
    expectedDelaySec: 240,
    toleranceSec: 1
  },
  {
    name: 'Max delay rolled (600s) honored',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 600,
      earliestLeadTimestamp: NOW - 30_000
    },
    expectedDelaySec: 600,
    toleranceSec: 1
  },
  {
    name: 'Debounce wins when delay is small (10s) and lead just arrived',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 10,
      earliestLeadTimestamp: NOW
    },
    expectedDelaySec: 45,
    toleranceSec: 1
  },
  {
    name: 'Old lead beyond maxDebounce: response delay still wins as floor',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 5,
      earliestLeadTimestamp: NOW - 200_000 // 200s ago > maxDebounceSec
    },
    // debouncedFireAt = min(now+45s, now-80s) = now-80s (already past)
    // responseDelayFireAt = now+5s
    // Math.max(now+1s, now-80s, now+5s) = now+5s
    expectedDelaySec: 5,
    toleranceSec: 1
  },
  {
    name: 'No lead in batch: debounce timer starts now',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 30,
      earliestLeadTimestamp: null
    },
    expectedDelaySec: 45,
    toleranceSec: 1
  },
  {
    name: 'Long delay (600) + old lead: response delay still honored',
    input: {
      now: NOW,
      debounceSec: 45,
      maxDebounceSec: 120,
      delayRandomSec: 600,
      earliestLeadTimestamp: NOW - 200_000
    },
    expectedDelaySec: 600,
    toleranceSec: 1
  }
];

let pass = 0;
let fail = 0;
for (const c of cases) {
  const fireAt = computeFireAt(c.input);
  const actualDelaySec = (fireAt - c.input.now) / 1000;
  const ok = Math.abs(actualDelaySec - c.expectedDelaySec) <= c.toleranceSec;
  if (ok) {
    pass++;
    console.log(
      `PASS  ${c.name}\n      delay=${actualDelaySec}s (expected ~${c.expectedDelaySec}s)`
    );
  } else {
    fail++;
    console.log(
      `FAIL  ${c.name}\n      delay=${actualDelaySec}s (expected ~${c.expectedDelaySec}s ±${c.toleranceSec}s)`
    );
  }
}

console.log(
  `\n${pass}/${cases.length} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);

// Validation rule sanity (mirror of API guards)
const FLOOR = 30;
const CEILING = 3600;

function validatesAccountInput(
  min: unknown,
  max: unknown
): { ok: boolean; reason?: string } {
  if (min !== undefined) {
    if (
      typeof min !== 'number' ||
      !Number.isFinite(min) ||
      min < FLOOR ||
      min > CEILING
    )
      return { ok: false, reason: 'min out of range' };
  }
  if (max !== undefined) {
    if (
      typeof max !== 'number' ||
      !Number.isFinite(max) ||
      max < FLOOR ||
      max > CEILING
    )
      return { ok: false, reason: 'max out of range' };
  }
  return { ok: true };
}

const validationCases: {
  label: string;
  min?: unknown;
  max?: unknown;
  expectOk: boolean;
}[] = [
  { label: 'min=0 rejected (bot tell)', min: 0, max: 120, expectOk: false },
  {
    label: 'min=29 rejected (under floor)',
    min: 29,
    max: 120,
    expectOk: false
  },
  { label: 'min=30 accepted (floor)', min: 30, max: 120, expectOk: true },
  {
    label: 'max=3601 rejected (over ceiling)',
    min: 30,
    max: 3601,
    expectOk: false
  },
  { label: 'max=3600 accepted (ceiling)', min: 30, max: 3600, expectOk: true },
  { label: 'string rejected', min: '60' as unknown, max: 120, expectOk: false },
  { label: 'NaN rejected', min: NaN, max: 120, expectOk: false },
  {
    label: 'undefined min OK if max valid',
    min: undefined,
    max: 600,
    expectOk: true
  }
];

let vPass = 0;
let vFail = 0;
for (const v of validationCases) {
  const got = validatesAccountInput(v.min, v.max);
  const ok = got.ok === v.expectOk;
  if (ok) {
    vPass++;
    console.log(`PASS  validation: ${v.label}`);
  } else {
    vFail++;
    console.log(
      `FAIL  validation: ${v.label} (expected ok=${v.expectOk}, got ok=${got.ok}${
        got.reason ? `: ${got.reason}` : ''
      })`
    );
  }
}

console.log(
  `\nvalidation: ${vPass}/${validationCases.length} passed${
    vFail > 0 ? `, ${vFail} failed` : ''
  }`
);
if (vFail > 0) process.exit(1);
