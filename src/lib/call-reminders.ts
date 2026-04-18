// ---------------------------------------------------------------------------
// call-reminders.ts
// ---------------------------------------------------------------------------
// Timezone-aware scheduling logic for DAY_BEFORE_REMINDER and
// MORNING_OF_REMINDER ScheduledMessage rows tied to a scheduledCallAt on
// a Conversation.
//
// The wall-clock-hour math runs through Intl.DateTimeFormat with an IANA
// time zone so DST transitions are handled correctly (e.g. a 2 AM call
// during a spring-forward doesn't accidentally land 23 or 25 hours apart).
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

export interface ReminderTimes {
  /** When the day-before reminder should fire (UTC Date). */
  dayBefore: Date;
  /** When the morning-of reminder should fire (UTC Date). */
  morningOf: Date;
}

/**
 * Return the hour-of-day (0–23) of a UTC Date when rendered in the given
 * IANA timezone. Used to decide whether a baseTime falls inside the
 * "awkward hours" window (11pm–8am).
 */
function hourInTimezone(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone
  }).formatToParts(d);
  const hourPart = parts.find((p) => p.type === 'hour');
  if (!hourPart) return d.getUTCHours();
  // `hour12: false` sometimes renders "24" for midnight; normalize.
  const h = parseInt(hourPart.value, 10);
  return Number.isFinite(h) ? h % 24 : d.getUTCHours();
}

/**
 * Given a calendar date (year/month/day) + hour + minute in a specific
 * timezone, return the equivalent UTC Date. This is the inverse of
 * formatting a Date in a timezone.
 *
 * Uses a converge-on-fixed-point approach: guess the UTC time, see what
 * hour it lands at in the target tz, adjust. Usually converges in one or
 * two passes. Robust against DST gaps/overlaps.
 */
function wallClockInTzToUtc(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  // First guess: treat the wall-clock as if it were UTC, then correct.
  let guess = new Date(Date.UTC(year, monthIndex, day, hour, minute, 0, 0));
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      timeZone
    }).formatToParts(guess);
    const get = (t: string): number =>
      parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    const gotY = get('year');
    const gotM = get('month') - 1;
    const gotD = get('day');
    const gotH = get('hour') % 24;
    const gotMin = get('minute');
    const desiredMs = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
    const gotMs = Date.UTC(gotY, gotM, gotD, gotH, gotMin, 0, 0);
    const diffMs = desiredMs - gotMs;
    if (diffMs === 0) return guess;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

/**
 * Shift a date by N calendar days *in its own timezone*. Preserves wall
 * clock hour/minute. Used to compute "6pm the day before the call" from
 * the call's own date in the lead's local time.
 */
function addCalendarDaysInTz(
  d: Date,
  days: number,
  timeZone: string,
  overrideHour?: number,
  overrideMinute?: number
): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    timeZone
  }).formatToParts(d);
  const get = (t: string): number =>
    parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
  const year = get('year');
  const monthIdx = get('month') - 1;
  const day = get('day') + days;
  const hour = overrideHour ?? get('hour') % 24;
  const minute = overrideMinute ?? get('minute');
  return wallClockInTzToUtc(year, monthIdx, day, hour, minute, timeZone);
}

/**
 * Compute the two reminder times for a given scheduled call.
 *
 * Rules (from the P0 spec):
 *   DAY_BEFORE_REMINDER:
 *     - default: 24 hours before the call
 *     - BUT if that lands between 11 PM and 8 AM (in the lead's tz),
 *       shift to 6 PM on the day before the call in the lead's tz
 *   MORNING_OF_REMINDER:
 *     - if call is BEFORE 11 AM (lead's tz): fire 2 hours before
 *     - otherwise: fire at 9 AM on the same day in the lead's tz
 *
 * @param scheduledCallAt  UTC Date of the call
 * @param leadTimezone     IANA tz string (e.g. "America/New_York").
 *                         Falls back to "UTC" if null/invalid.
 */
export function computeReminderTimes(
  scheduledCallAt: Date,
  leadTimezone: string | null
): ReminderTimes {
  const tz =
    leadTimezone && isValidIanaTimezone(leadTimezone) ? leadTimezone : 'UTC';

  // ── DAY_BEFORE_REMINDER ────────────────────────────────────────
  const rawDayBefore = new Date(scheduledCallAt.getTime() - 24 * 3600 * 1000);
  const rawDayBeforeHour = hourInTimezone(rawDayBefore, tz);
  // 11 PM (23) OR 0-7 AM (midnight through 7:59 AM) = awkward
  const isAwkward = rawDayBeforeHour === 23 || rawDayBeforeHour < 8;
  const dayBefore = isAwkward
    ? addCalendarDaysInTz(scheduledCallAt, -1, tz, 18, 0) // 6 PM day before call (in lead tz)
    : rawDayBefore;

  // ── MORNING_OF_REMINDER ────────────────────────────────────────
  const callHour = hourInTimezone(scheduledCallAt, tz);
  const morningOf =
    callHour < 11
      ? new Date(scheduledCallAt.getTime() - 2 * 3600 * 1000) // 2h before
      : addCalendarDaysInTz(scheduledCallAt, 0, tz, 9, 0); // 9 AM same day (in lead tz)

  return { dayBefore, morningOf };
}

function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Prisma helpers
// ---------------------------------------------------------------------------

/**
 * Cancel any PENDING reminder rows (DAY_BEFORE + MORNING_OF) tied to
 * this conversation. Used when the call is rescheduled or cleared.
 */
export async function cancelCallReminders(
  conversationId: string
): Promise<number> {
  const result = await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      status: 'PENDING',
      messageType: {
        in: ['DAY_BEFORE_REMINDER', 'MORNING_OF_REMINDER']
      }
    },
    data: { status: 'CANCELLED' }
  });
  return result.count;
}

/**
 * Idempotent: cancel existing PENDING reminders, then create fresh ones
 * for the new scheduledCallAt. If the call is in the past or the computed
 * reminder times are in the past, skips that specific reminder.
 */
export async function scheduleCallReminders(params: {
  conversationId: string;
  accountId: string;
  scheduledCallAt: Date;
  leadTimezone: string | null;
  createdByUserId?: string | null;
}): Promise<{ dayBeforeId: string | null; morningOfId: string | null }> {
  const {
    conversationId,
    accountId,
    scheduledCallAt,
    leadTimezone,
    createdByUserId
  } = params;

  await cancelCallReminders(conversationId);

  const { dayBefore, morningOf } = computeReminderTimes(
    scheduledCallAt,
    leadTimezone
  );
  const now = Date.now();

  const created: { dayBeforeId: string | null; morningOfId: string | null } = {
    dayBeforeId: null,
    morningOfId: null
  };

  if (dayBefore.getTime() > now) {
    const row = await prisma.scheduledMessage.create({
      data: {
        conversationId,
        accountId,
        scheduledFor: dayBefore,
        messageType: 'DAY_BEFORE_REMINDER',
        generateAtSendTime: true,
        relatedCallAt: scheduledCallAt,
        createdBy: createdByUserId ? 'HUMAN' : 'SYSTEM',
        createdByUserId: createdByUserId ?? null
      }
    });
    created.dayBeforeId = row.id;
  }

  if (morningOf.getTime() > now) {
    const row = await prisma.scheduledMessage.create({
      data: {
        conversationId,
        accountId,
        scheduledFor: morningOf,
        messageType: 'MORNING_OF_REMINDER',
        generateAtSendTime: true,
        relatedCallAt: scheduledCallAt,
        createdBy: createdByUserId ? 'HUMAN' : 'SYSTEM',
        createdByUserId: createdByUserId ?? null
      }
    });
    created.morningOfId = row.id;
  }

  return created;
}
