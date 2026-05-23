'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface FormattedSlot {
  start: string;
  end: string;
  display: string;
}
interface GroupedDay {
  date: string;
  times: FormattedSlot[];
}
interface AvailabilityResponse {
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'google' | 'none';
  slots: GroupedDay[];
}

const PROVIDER_LABEL: Record<string, string> = {
  leadconnector: 'LeadConnector',
  calendly: 'Calendly',
  calcom: 'Cal.com',
  google: 'Google Calendar',
  none: 'None'
};

function formatDayHeading(dateKey: string): string {
  // dateKey is YYYY-MM-DD
  const d = new Date(`${dateKey}T00:00:00`);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });
}

export function CalendarAvailability() {
  const [data, setData] = useState<AvailabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/calendar/availability');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load availability');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <p className='text-muted-foreground text-sm'>Loading availability…</p>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className='space-y-3 py-6'>
          <p className='text-destructive text-sm'>{error}</p>
          <Button variant='outline' size='sm' onClick={load}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.provider === 'none') {
    return (
      <Card>
        <CardContent className='space-y-2 py-6'>
          <p className='text-sm font-medium'>No calendar connected</p>
          <p className='text-muted-foreground text-sm'>
            Connect a calendar in Settings → Integrations (Google Calendar,
            LeadConnector, Calendly, or Cal.com) to show your availability here.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalSlots = data.slots.reduce((sum, d) => sum + d.times.length, 0);

  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2'>
        <Badge variant='secondary'>
          {PROVIDER_LABEL[data.provider] ?? data.provider}
        </Badge>
        <span className='text-muted-foreground text-sm'>
          {totalSlots} open slot{totalSlots === 1 ? '' : 's'} over the next 7
          days
        </span>
        <Button variant='ghost' size='sm' className='ml-auto' onClick={load}>
          Refresh
        </Button>
      </div>

      {data.slots.length === 0 ? (
        <p className='text-muted-foreground text-sm'>
          No open slots in the next 7 days.
        </p>
      ) : (
        <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-3'>
          {data.slots.map((day) => (
            <Card key={day.date}>
              <CardHeader className='pb-2'>
                <CardTitle className='text-sm'>
                  {formatDayHeading(day.date)}
                </CardTitle>
              </CardHeader>
              <CardContent className='flex flex-wrap gap-2'>
                {day.times.map((t) => (
                  <Badge
                    key={t.start}
                    variant='outline'
                    className='font-normal'
                  >
                    {t.display}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
