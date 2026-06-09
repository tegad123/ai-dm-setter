'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import luxon3Plugin from '@fullcalendar/luxon3';
import type { EventInput } from '@fullcalendar/core';
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
// Calendar — week grid, powered by FullCalendar (timeGridWeek).
//
// The previous hand-rolled grid did its own timezone math (Intl day/hour
// extraction, manual block positioning) and kept producing tz bugs: off-by-one
// days, tz flipping to the browser zone on refresh, and "N open" counts not
// matching what rendered. FullCalendar with `timeZone` set to the calendar's
// IANA tz handles day-grouping, slot positioning, the visible window, and week
// navigation natively — we just feed it events and the tz. luxon3 plugin adds
// named-timezone support (FullCalendar core only does 'local'/'UTC').
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
  start: string; // ISO (UTC)
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

/** "YYYY-MM-DD" of *now* in the given IANA tz (for the API range query). */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function dateStringToUtcNoon(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addDaysToDateString(s: string, n: number): string {
  const dt = dateStringToUtcNoon(s);
  dt.setUTCDate(dt.getUTCDate() + n);
  const y = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function mondayOfWeekString(s: string): string {
  const dt = dateStringToUtcNoon(s);
  const day = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  return addDaysToDateString(s, -day);
}

/** Short tz label like "EDT" for the badge. */
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

function timeLabelInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
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
  // the browser tz, which caused the EDT↔Karachi flip on refresh).
  const [calendarTz, setCalendarTz] = useState<string | null>(null);
  const displayTz = calendarTz ?? data?.timezone ?? browserTz;

  // Visible week anchor (Monday) as a calendar-tz date string. FullCalendar
  // owns layout; we only track the range to query + label.
  const [weekStart, setWeekStart] = useState<string>(() =>
    mondayOfWeekString(
      todayInTz(Intl.DateTimeFormat().resolvedOptions().timeZone)
    )
  );
  const [tzAnchored, setTzAnchored] = useState(false);

  const calRef = useRef<FullCalendar | null>(null);

  // Once the real calendar tz resolves, snap the week to calendar-tz "today"
  // (only the first time, so we don't yank the user off a week they navigated).
  useEffect(() => {
    if (calendarTz && !tzAnchored) {
      setTzAnchored(true);
      setWeekStart(mondayOfWeekString(todayInTz(calendarTz)));
    }
  }, [calendarTz, tzAnchored]);

  const load = useCallback(async (start: string) => {
    setLoading(true);
    setError(null);
    try {
      // Query a day wider on each side so edge-of-week slots/calls (in the
      // calendar tz) are never missed at the UTC boundary.
      const startDate = addDaysToDateString(start, -1);
      const endDate = addDaysToDateString(start, 7);
      const range = `startDate=${startDate}&endDate=${endDate}`;

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

      // Seed the calendar tz ONCE (upgrade-only — never back to browser tz).
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
  }, []);

  useEffect(() => {
    load(weekStart);
  }, [weekStart, load]);

  // Build FullCalendar events. FullCalendar positions each by its instant in
  // `timeZone={displayTz}` — no manual day/hour math, so no off-by-one.
  const events = useMemo<EventInput[]>(() => {
    const out: EventInput[] = [];
    for (const day of data?.slots ?? []) {
      for (const s of day.times) {
        out.push({
          start: s.start,
          end: s.end || undefined,
          display: 'block',
          title: 'Open',
          classNames: ['fc-open-slot'],
          extendedProps: { kind: 'open' }
        });
      }
    }
    for (const c of calls) {
      const noShow = c.outcome === 'NO_SHOWED';
      out.push({
        start: c.start,
        title: c.leadName,
        classNames: [noShow ? 'fc-booked-noshow' : 'fc-booked-call'],
        extendedProps: { kind: 'booked', outcome: c.outcome }
      });
    }
    return out;
  }, [data, calls]);

  const totalSlots = useMemo(
    () => (data?.slots ?? []).reduce((s, d) => s + d.times.length, 0),
    [data]
  );
  const bookedCount = calls.length;

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

  const isCurrentWeek = weekStart === mondayOfWeekString(todayInTz(displayTz));

  // Drive FullCalendar's visible week from weekStart. Keeping the API instance
  // in sync lets us reuse its native gridding while our toolbar owns nav.
  useEffect(() => {
    const api = calRef.current?.getApi();
    if (api) api.gotoDate(`${weekStart}T12:00:00`);
  }, [weekStart, displayTz]);

  const goPrev = () => setWeekStart((w) => addDaysToDateString(w, -7));
  const goNext = () => setWeekStart((w) => addDaysToDateString(w, 7));
  const goToday = () => setWeekStart(mondayOfWeekString(todayInTz(displayTz)));

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
            onClick={goPrev}
          >
            <IconChevronLeft className='size-4' />
          </Button>
          <Button
            variant='outline'
            size='sm'
            className='h-8'
            disabled={isCurrentWeek}
            onClick={goToday}
          >
            Today
          </Button>
          <Button
            variant='outline'
            size='icon'
            className='size-8'
            aria-label='Next week'
            onClick={goNext}
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

      {error && (
        <div className='border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm'>
          {error}
        </div>
      )}

      {data && data.provider === 'none' && !error && (
        <div className='text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed p-10 text-center text-sm'>
          <IconCalendarOff className='size-6' />
          No calendar connected. Connect one in Settings → Integrations to see
          availability here.
        </div>
      )}

      {/* The grid — FullCalendar owns all tz/day/positioning */}
      {data && data.provider !== 'none' && !error && (
        <div className='bg-card overflow-hidden rounded-lg border p-2'>
          <FullCalendar
            ref={calRef}
            plugins={[timeGridPlugin, luxon3Plugin]}
            initialView='timeGridWeek'
            timeZone={displayTz}
            firstDay={1} // Monday
            headerToolbar={false}
            allDaySlot={false}
            nowIndicator
            // Full 24h so no slot is ever clipped by a business-hours window;
            // scroll opens at 8am by default (scrollable to any hour).
            slotMinTime='00:00:00'
            slotMaxTime='24:00:00'
            scrollTime='08:00:00'
            expandRows
            height='70vh'
            dayHeaderFormat={{ weekday: 'short', day: 'numeric' }}
            slotLabelFormat={{
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
              meridiem: 'short'
            }}
            eventTimeFormat={{
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            }}
            events={events}
            eventContent={(arg) => {
              const kind = arg.event.extendedProps.kind;
              const time = timeLabelInTz(
                arg.event.start?.toISOString() ?? '',
                displayTz
              );
              if (kind === 'booked') {
                return (
                  <div className='truncate px-1 text-[11px] leading-tight font-semibold'>
                    {arg.event.title}
                    <div className='opacity-80'>{time}</div>
                  </div>
                );
              }
              return (
                <div className='truncate px-1 text-[11px] leading-tight font-medium'>
                  {time} · Open
                </div>
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
