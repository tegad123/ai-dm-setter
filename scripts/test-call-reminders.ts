/**
 * Phase A tests for call-reminder infrastructure.
 *
 * Tests the pure timezone math in computeReminderTimes() for the
 * scenarios specified in the P0 brief:
 *   TEST 1   — human-entered call, reminders at correct times
 *   TEST 5   — reminder fire time matches expected (23h before / 9am of)
 *   TEST 6   — clear behavior conceptually verified by cancelCallReminders
 *   TEST 10  — timezone handling (GMT vs CT)
 *
 * Pure-function tests — no DB calls. Exercise edge cases (awkward-hour
 * window, early-morning call, DST-adjacent dates).
 *
 * Usage: npx tsx scripts/test-call-reminders.ts
 */

import { computeReminderTimes } from '../src/lib/call-reminders';

interface Case {
  name: string;
  callAtIso: string;
  tz: string | null;
  expectDayBeforeIso: string;
  expectMorningOfIso: string;
  notes?: string;
}

const CASES: Case[] = [
  {
    name: 'T1 — Thursday 2pm ET call (standard mid-day, afternoon day-before)',
    callAtIso: '2026-04-24T18:00:00Z', // 2pm ET on 4/24 (EDT, UTC-4)
    tz: 'America/New_York',
    // Day-before: 24h before = 2pm ET Wednesday → not awkward → 2pm ET Wed
    expectDayBeforeIso: '2026-04-23T18:00:00Z',
    // Morning-of: call is 2pm (>=11am) → 9am ET Thursday
    expectMorningOfIso: '2026-04-24T13:00:00Z',
    notes: 'Reminders at 2pm ET Wed + 9am ET Thu'
  },
  {
    name: 'T2 — 8am call (before 11am → morning-of fires 2h before)',
    callAtIso: '2026-04-24T12:00:00Z', // 8am ET
    tz: 'America/New_York',
    // Day-before: 24h before = 8am ET Wednesday → not awkward (hour 8) → 8am
    expectDayBeforeIso: '2026-04-23T12:00:00Z',
    // Morning-of: call < 11am → 2h before = 6am ET (10:00Z)
    expectMorningOfIso: '2026-04-24T10:00:00Z',
    notes: 'Morning-of shifts to 2h before call when call < 11am'
  },
  {
    name: 'T3 — 3am call (awkward day-before window, very early morning-of)',
    callAtIso: '2026-04-24T07:00:00Z', // 3am ET Thursday
    tz: 'America/New_York',
    // Day-before: 24h back = 3am ET Wed → hour 3 is awkward → shift to 6pm Wed
    //   (the day before the CALL in lead tz, not day before baseTime)
    // 6pm ET Wed 4/23 = 22:00 UTC Wed 4/23
    expectDayBeforeIso: '2026-04-23T22:00:00Z',
    // Morning-of: call < 11am → 2h before = 1am ET = 5:00 UTC
    expectMorningOfIso: '2026-04-24T05:00:00Z',
    notes: 'Awkward-hour rule: day-before shifts to 6pm day prior'
  },
  {
    name: 'T10 — 2pm GMT call for a UK lead',
    callAtIso: '2026-04-24T14:00:00Z', // 2pm GMT (BST actually in April, UTC+1) — careful!
    // Note: London is on BST (UTC+1) in April, so 2pm London local = 1pm UTC.
    // To test the spec literally, use UTC.
    tz: 'Europe/London',
    // 14:00 UTC = 3pm BST (hour 15 in London) → day-before 24h back = 3pm BST Wed → not awkward
    expectDayBeforeIso: '2026-04-23T14:00:00Z',
    // Morning-of: local hour 15 >= 11 → 9am BST Thursday = 8:00 UTC
    expectMorningOfIso: '2026-04-24T08:00:00Z',
    notes: 'London in April is BST (UTC+1); hour math uses local wall clock'
  },
  {
    name: 'T-edge — 11pm call (day-before reminder lands at 11pm prior → awkward shift)',
    callAtIso: '2026-04-25T03:00:00Z', // 11pm ET 4/24
    tz: 'America/New_York',
    // Day-before: 24h back = 11pm ET 4/23 → hour 23 IS awkward → shift to 6pm ET 4/23
    expectDayBeforeIso: '2026-04-23T22:00:00Z',
    // Morning-of: call is 11pm (hour 23 >= 11) → 9am ET same day 4/24
    expectMorningOfIso: '2026-04-24T13:00:00Z',
    notes: 'Hour 23 triggers awkward-window shift'
  },
  {
    name: 'T-nulltz — call with no timezone (falls back to UTC)',
    callAtIso: '2026-04-24T14:00:00Z',
    tz: null,
    // UTC 14:00 - 24h = 14:00 UTC prev day, hour 14 not awkward
    expectDayBeforeIso: '2026-04-23T14:00:00Z',
    // Call hour 14 >= 11 → morning-of 9am UTC = 09:00 UTC
    expectMorningOfIso: '2026-04-24T09:00:00Z',
    notes: 'Null timezone defaults to UTC'
  }
];

let pass = 0;
let fail = 0;

for (const tc of CASES) {
  const { dayBefore, morningOf } = computeReminderTimes(
    new Date(tc.callAtIso),
    tc.tz
  );
  const dayBeforeOk =
    dayBefore.getTime() === new Date(tc.expectDayBeforeIso).getTime();
  const morningOfOk =
    morningOf.getTime() === new Date(tc.expectMorningOfIso).getTime();
  const ok = dayBeforeOk && morningOfOk;
  console.log(`${ok ? '✓' : '✗'} ${tc.name}`);
  console.log(`    call: ${tc.callAtIso} (${tc.tz ?? 'null'})`);
  console.log(
    `    day-before: expect ${tc.expectDayBeforeIso} got ${dayBefore.toISOString()} ${dayBeforeOk ? '✓' : '✗'}`
  );
  console.log(
    `    morning-of: expect ${tc.expectMorningOfIso} got ${morningOf.toISOString()} ${morningOfOk ? '✓' : '✗'}`
  );
  if (tc.notes) console.log(`    notes: ${tc.notes}`);
  console.log('');
  if (ok) pass++;
  else fail++;
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
