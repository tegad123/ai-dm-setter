'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconCalendarOff
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Calendar — week grid (Google-Calendar style)
//
// Tega's feedback: the old availability view was a list of cards and "didn't
// look like an actual calendar." This renders a real 7-day week grid: days as
// columns, hours as rows, each open slot drawn as a positioned block on the
// time axis. Week navigation (prev / today / next) drives the date range that
// is sent to /api/calendar/availability, so the grid always shows the visible
// week's real provider availability.
// ---------------------------------------------------------------------------

interface FormattedSlot {
  start: string; // ISO
  end: string; // ISO
  display: string;
}
interface GroupedDay {
  date: string; // YYYY-MM-DD
  times: FormattedSlot[];
}
interface AvailabilityResponse {
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'google' | 'none';
  slots: GroupedDay[];
  timezone?: string | null;
}

interface ScheduledCall {
  conversationId: string;
  leadName: string;
  start: string; // ISO
  timezone: string | null;
  outcome: string | null;
  confirmed: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  leadconnector: 'LeadConnector',
  calendly: 'Calendly',
  calcom: 'Cal.com',
  google: 'Google Calendar',
  none: 'None'
};

// Visible time window. Slots outside it still render (clamped) but the grid is
// optimised for working hours so the week isn't 24 rows of mostly-empty space.
const DAY_START_HOUR = 7; // 7 AM
const DAY_END_HOUR = 21; // 9 PM
const HOUR_ROW_PX = 56; // height of one hour row

// ── Timezone-aware helpers ─────────────────────────────────────────────────
// The grid must position every slot/call in the CALENDAR'S timezone (e.g. the
// LeadConnector business tz), NOT the viewer's browser tz. Otherwise a call at
// 6 PM EDT viewed from PKT computes to 3 AM and falls outside the 7AM–9PM
// window → invisible (the bug). These derive day-key + fractional hour in an
// explicit IANA tz via Intl.DateTimeFormat.

/** "YYYY-MM-DD" of a Date/ISO as seen in the given IANA timezone. */
function dateKeyInTz(value: Date | string, tz: string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  // en-CA yields YYYY-MM-DD directly.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

/** Fractional hour (0–24) of an ISO timestamp as seen in the given tz. */
function hourOfDayInTz(iso: string, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl can emit "24" for midnight in hour12:false — normalise to 0.
  return (h % 24) + m / 60;
}

/**
 * Wall-clock fractional hour read DIRECTLY from an ISO string that carries an
 * explicit offset (e.g. "2026-06-11T18:00:00-04:00" → 18.0). LeadConnector free
 * slots are returned in the calendar's own tz with the offset baked in, so this
 * is the authoritative hour without needing the IANA tz name. Falls back to
 * tz-aware parsing if no offset is present.
 */
function wallClockHour(iso: string, fallbackTz: string): number {
  const m = iso.match(
    /T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})/
  );
  if (m && m[3] && m[3] !== 'Z') {
    return Number(m[1]) + Number(m[2]) / 60;
  }
  return hourOfDayInTz(iso, fallbackTz);
}

function formatTimeInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/** Short tz label like "EDT" for display next to times. */
function tzAbbrev(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'short'
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
  } catch {
    return tz;
  }
}

// ── Date-string week model ─────────────────────────────────────────────────
// The entire grid operates on calendar-tz "YYYY-MM-DD" strings (not Date
// objects) so there is ONE coordinate system and no browser-tz drift. A
// browser-local Date converted to the calendar tz can cross a day boundary
// (Karachi midnight = previous-day 19:00 EDT) which previously shifted columns
// by a day. String arithmetic via a NOON-UTC anchor avoids that entirely.

/** "YYYY-MM-DD" of *now* as seen in the given IANA timezone. */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/** Parse "YYYY-MM-DD" into a noon-UTC Date (noon never crosses a tz boundary). */
function dateStringToUtcNoon(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Add/subtract whole days to a "YYYY-MM-DD" via UTC arithmetic. */
function addDaysToDateString(s: string, n: number): string {
  const dt = dateStringToUtcNoon(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  const y = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

/** Monday (week start) of the week containing the given "YYYY-MM-DD". */
function mondayOfWeekString(s: string): string {
  const dt = dateStringToUtcNoon(s);
  const day = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  return addDaysToDateString(s, -day);
}

/** Weekday short label + day-number for a "YYYY-MM-DD", tz-drift-free. */
function dateStringToLabelParts(s: string): { weekday: string; day: number } {
  const dt = dateStringToUtcNoon(s);
  return {
    weekday: dt.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: 'UTC'
    }),
    day: dt.getUTCDate()
  };
}

export function CalendarWeekGrid() {
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [calls, setCalls] = useState<ScheduledCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );

  // The calendar's own timezone, resolved ONCE and kept stable across week
  // navigation (upgrade-only — an empty week can never flip the grid back to
  // the browser tz). Set from the first availability/call response that knows
  // it (see load()).
  const [calendarTz, setCalendarTz] = useState<string | null>(null);

  // Stable display tz: calendarTz wins once known; data.timezone covers the
  // synchronous render before calendarTz commits; browser tz is the bootstrap.
  const displayTz = calendarTz ?? data?.timezone ?? browserTz;

  // Week is modeled as calendar-tz "YYYY-MM-DD" strings (no Date/tz drift).
  // Seeded from browser today, then re-anchored to calendar-tz today once the
  // calendar tz resolves (only if the user hasn't navigated yet).
  const [weekStart, setWeekStart] = useState<string>(() =>
    mondayOfWeekString(
      todayInTz(Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
  );
  const [tzAnchored, setTzAnchored] = useState(false);

  // "Today" in the calendar tz, as a date-string. Drives the highlight.
  const todayKey = useMemo(() => todayInTz(displayTz), [displayTz]);

  useEffect(() => {
    if (calendarTz && !tzAnchored) {
      setTzAnchored(true);
      setWeekStart(mondayOfWeekString(todayInTz(calendarTz)));
    }
  }, [calendarTz, tzAnchored]);

  // The 7 calendar-tz date strings for the visible week.
  const days = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => addDaysToDateString(weekStart, i)),
    [weekStart]
  );

  const hours = useMemo(
    () =>
      Array.from(
        { length: DAY_END_HOUR - DAY_START_HOUR },
        (_, i) => DAY_START_HOUR + i
      ),
    []
  );

  async function load(start: string) {
    setLoading(true);
    setError(null);
    try {
      const startDate = start;
      const endDate = addDaysToDateString(start, 6);
      const range = `startDate=${startDate}&endDate=${endDate}`;

      // Availability and booked calls in parallel. Availability drives the
      // error/empty state; booked calls are best-effort (don't fail the view).
      const [availRes, callsRes] = await Promise.all([
        fetch(`/api/calendar/availability?${range}`),
        fetch(`/api/calendar/scheduled-calls?${range}`).catch(() => null)
      ]);

      if (!availRes.ok) {
        const body = await availRes.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${availRes.status})`);
      }
      const avail: AvailabilityResponse = await availRes.json();
      setData(avail);

      let nextCalls: ScheduledCall[] = [];
      if (callsRes && callsRes.ok) {
        const body = await callsRes.json().catch(() => ({ calls: [] }));
        nextCalls = Array.isArray(body.calls) ? body.calls : [];
      }
      setCalls(nextCalls);

      // Seed the calendar tz ONCE from the first source that knows it, then
      // keep it. Never overwrite a known tz with null, never use browser tz.
      setCalendarTz((prev) => {
        if (prev) return prev;
        return (
          avail.timezone || nextCalls.find((c) => c.timezone)?.timezone || null
        );
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load availability');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(weekStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  // Index slots by day key for O(1) column lookup.
  const slotsByDay = useMemo(() => {
    const map = new Map<string, FormattedSlot[]>();
    for (const d of data?.slots ?? []) map.set(d.date, d.times);
    return map;
  }, [data]);

  // Index booked calls by the calendar-tz day they fall on (a call's own stored
  // tz wins; else the grid's displayTz). Browser-local keying previously shifted
  // a 6 PM EDT call to the wrong day for far-offset viewers.
  const callsByDay = useMemo(() => {
    const map = new Map<string, ScheduledCall[]>();
    for (const c of calls) {
      // call.start is UTC ("…Z") → resolve the day via the IANA tz (the call's
      // own stored tz wins), NOT the offset-reading wallClockDateKey.
      const key = dateKeyInTz(c.start, c.timezone || displayTz);
      const list = map.get(key);
      if (list) list.push(c);
      else map.set(key, [c]);
    }
    return map;
  }, [calls, displayTz]);

  const totalSlots = useMemo(
    () => (data?.slots ?? []).reduce((s, d) => s + d.times.length, 0),
    [data]
  );

  const weekLabel = useMemo(() => {
    const endStr = addDaysToDateString(weekStart, 6);
    const start = dateStringToUtcNoon(weekStart);
    const end = dateStringToUtcNoon(endStr);
    const sameMonth = start.getUTCMonth() === end.getUTCMonth();
    const startFmt = start.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric'
    });
    const endFmt = end.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: sameMonth ? undefined : 'short',
      day: 'numeric',
      year: 'numeric'
    });
    return `${startFmt} – ${endFmt}`;
  }, [weekStart]);

  const isCurrentWeek = weekStart === mondayOfWeekString(todayKey);
  const bookedCount = calls.length;

  return (
    <div className='space-y-4'>
      {/* Toolbar */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex items-center gap-1'>
          <Button
            variant='outline'
            size='icon'
            className='size-8'
            aria-label='Previous week'
            onClick={() => setWeekStart((w) => addDaysToDateString(w, -7))}
          >
            <IconChevronLeft className='size-4' />
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='h-8'
            disabled={isCurrentWeek}
            onClick={() =>
              setWeekStart(mondayOfWeekString(todayInTz(displayTz)))
            }
          >
            Today
          </Button>
          <Button
            variant='outline'
            size='icon'
            className='size-8'
            aria-label='Next week'
            onClick={() => setWeekStart((w) => addDaysToDateString(w, 7))}
          >
            <IconChevronRight className='size-4' />
          </Button>
        </div>

        <div className='ml-1 text-sm font-medium'>{weekLabel}</div>

        <div className='ml-auto flex items-center gap-2'>
          {data && data.provider !== 'none' && (
            <>
              <Badge variant='secondary'>
                {PROVIDER_LABEL[data.provider] ?? data.provider}
              </Badge>
              <span className='text-muted-foreground hidden text-sm sm:inline'>
                {totalSlots} open
                {bookedCount > 0 ? ` · ${bookedCount} booked` : ''}
              </span>
              <Badge
                variant='outline'
                className='hidden md:inline-flex'
                title={`All times shown in ${displayTz}`}
              >
                {tzAbbrev(displayTz)} · {displayTz}
              </Badge>
            </>
          )}
          <Button
            variant='ghost'
            size='icon'
            className='size-8'
            aria-label='Refresh'
            onClick={() => load(weekStart)}
          >
            <IconRefresh className={cn('size-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Not connected */}
      {!loading && data && data.provider === 'none' && (
        <div className='flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-16 text-center'>
          <IconCalendarOff className='text-muted-foreground size-8' />
          <p className='text-sm font-medium'>No calendar connected</p>
          <p className='text-muted-foreground max-w-sm text-sm'>
            Connect a calendar in Settings → Integrations (Google Calendar,
            LeadConnector, Calendly, or Cal.com) to show your availability here.
          </p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className='flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-center'>
          <p className='text-destructive text-sm'>{error}</p>
          <Button variant='outline' size='sm' onClick={() => load(weekStart)}>
            Retry
          </Button>
        </div>
      )}

      {/* Legend */}
      {data && data.provider !== 'none' && !error && (
        <div className='text-muted-foreground flex items-center gap-4 text-xs'>
          <span className='flex items-center gap-1.5'>
            <span className='border-primary/30 bg-primary/10 inline-block size-3 rounded-sm border' />
            Open slot
          </span>
          <span className='flex items-center gap-1.5'>
            <span className='border-primary bg-primary inline-block size-3 rounded-sm border' />
            Booked call
          </span>
        </div>
      )}

      {/* The grid */}
      {(loading || (data && data.provider !== 'none' && !error)) && (
        <div className='bg-card overflow-hidden rounded-lg border'>
          {/* Day headers */}
          <div className='grid grid-cols-[4.5rem_repeat(7,1fr)] border-b'>
            <div className='border-r' />
            {days.map((dateKey) => {
              const isToday = dateKey === todayKey;
              const { weekday, day } = dateStringToLabelParts(dateKey);
              return (
                <div
                  key={dateKey}
                  className={cn(
                    'flex flex-col items-center gap-0.5 border-r py-2 last:border-r-0',
                    isToday && 'bg-primary/5'
                  )}
                >
                  <span className='text-muted-foreground text-[11px] font-medium tracking-wide uppercase'>
                    {weekday}
                  </span>
                  <span
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full text-sm font-semibold',
                      isToday && 'bg-primary text-primary-foreground'
                    )}
                  >
                    {day}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Scrollable time body */}
          <div className='relative max-h-[60vh] overflow-y-auto'>
            <div className='grid grid-cols-[4.5rem_repeat(7,1fr)]'>
              {/* Hour gutter */}
              <div className='border-r'>
                {hours.map((h) => (
                  <div
                    key={h}
                    className='text-muted-foreground relative text-right text-[11px] whitespace-nowrap'
                    style={{ height: HOUR_ROW_PX }}
                  >
                    <span className='absolute -top-1.5 right-2'>
                      {h % 12 === 0 ? 12 : h % 12}:00 {h < 12 ? 'AM' : 'PM'}
                    </span>
                  </div>
                ))}
              </div>

              {/* Day columns */}
              {days.map((key) => {
                // `key` is already the column's calendar-tz date string, which
                // matches slotsByDay (from the API) and callsByDay directly —
                // no Date→tz conversion (that caused the off-by-one).
                const slots = slotsByDay.get(key) ?? [];
                const dayCalls = callsByDay.get(key) ?? [];
                const isToday = key === todayKey;
                return (
                  <div
                    key={key}
                    className={cn(
                      'relative border-r last:border-r-0',
                      isToday && 'bg-primary/5'
                    )}
                  >
                    {/* Hour grid lines */}
                    {hours.map((h) => (
                      <div
                        key={h}
                        className='border-b border-dashed last:border-b-0'
                        style={{ height: HOUR_ROW_PX }}
                      />
                    ))}

                    {/* Open availability blocks */}
                    {slots.map((slot) => {
                      const startH = wallClockHour(slot.start, displayTz);
                      const endH = slot.end
                        ? wallClockHour(slot.end, displayTz)
                        : startH + 0.5;
                      // Skip slots fully outside the visible window.
                      if (endH <= DAY_START_HOUR || startH >= DAY_END_HOUR) {
                        return null;
                      }
                      const top =
                        (Math.max(startH, DAY_START_HOUR) - DAY_START_HOUR) *
                        HOUR_ROW_PX;
                      const height = Math.max(
                        (Math.min(endH, DAY_END_HOUR) -
                          Math.max(startH, DAY_START_HOUR)) *
                          HOUR_ROW_PX -
                          2,
                        16
                      );
                      // Only show the "Open" sub-label when the block is tall
                      // enough for two lines; otherwise just the time (no clip).
                      const twoLine = height >= 34;
                      return (
                        <div
                          key={slot.start}
                          className={cn(
                            'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 absolute right-0.5 left-0.5 flex flex-col justify-center overflow-hidden rounded-md border px-1.5 text-[11px] leading-none font-medium transition-colors',
                            twoLine ? 'py-1' : 'py-0'
                          )}
                          style={{ top, height }}
                          title={`${slot.display} · Open`}
                        >
                          <span className='block truncate'>
                            {formatTimeInTz(slot.start, displayTz)}
                          </span>
                          {twoLine && (
                            <span className='mt-0.5 block truncate opacity-70'>
                              Open
                            </span>
                          )}
                        </div>
                      );
                    })}

                    {/* Booked call blocks (solid, on top of availability) */}
                    {dayCalls.map((call) => {
                      // call.start is UTC ("…Z"), no offset to read → resolve
                      // the hour via the IANA tz (call's own tz wins).
                      const startH = hourOfDayInTz(
                        call.start,
                        call.timezone || displayTz
                      );
                      if (startH < DAY_START_HOUR || startH >= DAY_END_HOUR) {
                        return null;
                      }
                      // Calls default to a 30-min visual block.
                      const top = (startH - DAY_START_HOUR) * HOUR_ROW_PX;
                      const height = HOUR_ROW_PX / 2 - 2;
                      const twoLine = height >= 34;
                      const noShow = call.outcome === 'NO_SHOWED';
                      return (
                        <div
                          key={call.conversationId}
                          className={cn(
                            'absolute right-0.5 left-0.5 z-10 flex flex-col justify-center overflow-hidden rounded-md border px-1.5 text-[11px] leading-none font-semibold shadow-sm transition-colors',
                            noShow
                              ? 'border-destructive/40 bg-destructive/15 text-destructive'
                              : 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
                            twoLine ? 'py-1' : 'py-0'
                          )}
                          style={{ top, height }}
                          title={`${formatTimeInTz(call.start, call.timezone || displayTz)} · ${call.leadName}${
                            call.outcome ? ` · ${call.outcome}` : ''
                          }`}
                        >
                          <span className='block truncate'>
                            {call.leadName}
                          </span>
                          {twoLine && (
                            <span className='mt-0.5 block truncate opacity-80'>
                              {formatTimeInTz(
                                call.start,
                                call.timezone || displayTz
                              )}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Empty (connected, but no slots this week) */}
      {!loading &&
        data &&
        data.provider !== 'none' &&
        !error &&
        totalSlots === 0 && (
          <p className='text-muted-foreground text-center text-sm'>
            No open slots this week. Try the next week, or check your calendar
            settings.
          </p>
        )}
    </div>
  );
}
