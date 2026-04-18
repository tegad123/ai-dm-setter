'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { IconCalendarEvent, IconClock, IconCheck } from '@tabler/icons-react';

interface CallDetailsState {
  scheduledCallAt: string | null;
  scheduledCallTimezone: string | null;
  scheduledCallSource: string | null;
  scheduledCallConfirmed: boolean;
  scheduledCallNote: string | null;
  scheduledCallUpdatedAt: string | null;
  scheduledCallUpdatedBy: string | null;
  leadTimezone: string | null;
  reminders: Array<{
    id: string;
    messageType: string;
    scheduledFor: string;
  }>;
}

/** Common IANA tz options. More can be added later; these cover 95% of cases. */
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'America/New_York (ET)' },
  { value: 'America/Chicago', label: 'America/Chicago (CT)' },
  { value: 'America/Denver', label: 'America/Denver (MT)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PT)' },
  { value: 'America/Phoenix', label: 'America/Phoenix (AZ, no DST)' },
  { value: 'America/Toronto', label: 'America/Toronto' },
  { value: 'America/Mexico_City', label: 'America/Mexico_City' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo' },
  { value: 'Europe/London', label: 'Europe/London' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin' },
  { value: 'Europe/Paris', label: 'Europe/Paris' },
  { value: 'Europe/Madrid', label: 'Europe/Madrid' },
  { value: 'Africa/Lagos', label: 'Africa/Lagos' },
  { value: 'Africa/Harare', label: 'Africa/Harare (CAT)' },
  { value: 'Africa/Johannesburg', label: 'Africa/Johannesburg' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai' },
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland' },
  { value: 'UTC', label: 'UTC' }
];

function formatInTz(iso: string | null, tz: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz || 'UTC',
      timeZoneName: 'short'
    });
  } catch {
    return new Date(iso).toISOString();
  }
}

function toLocalDateTimeInput(iso: string | null, tz: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz || undefined
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  } catch {
    return '';
  }
}

/**
 * Convert a datetime-local string (e.g. "2026-04-24T14:00") interpreted in
 * `tz` into a UTC ISO string we can send to the API.
 */
function localDateTimeToUtcIso(local: string, tz: string): string | null {
  if (!local) return null;
  // Parse: "YYYY-MM-DDTHH:MM"
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // Fixed-point convergence: guess, check wall-clock in tz, adjust
  let guess = new Date(
    Date.UTC(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(h, 10),
      parseInt(mi, 10)
    )
  );
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz
    }).formatToParts(guess);
    const g = (t: string) =>
      parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
    const desired = Date.UTC(
      parseInt(y, 10),
      parseInt(mo, 10) - 1,
      parseInt(d, 10),
      parseInt(h, 10),
      parseInt(mi, 10)
    );
    const got = Date.UTC(
      g('year'),
      g('month') - 1,
      g('day'),
      g('hour'),
      g('minute')
    );
    const diff = desired - got;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess.toISOString();
}

interface Props {
  conversationId: string;
}

export function CallDetailsPanel({ conversationId }: Props) {
  const [state, setState] = useState<CallDetailsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit form state
  const [datetimeLocal, setDatetimeLocal] = useState('');
  const [timezone, setTimezone] = useState<string>('America/New_York');
  const [note, setNote] = useState('');

  const fetchState = useCallback(async () => {
    try {
      const data = await apiFetch<CallDetailsState>(
        `/conversations/${conversationId}/call`
      );
      setState(data);
    } catch {
      // Non-fatal; panel renders the "no call scheduled" state
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  const startEdit = () => {
    if (state?.scheduledCallAt) {
      const tz =
        state.scheduledCallTimezone || state.leadTimezone || 'America/New_York';
      setDatetimeLocal(toLocalDateTimeInput(state.scheduledCallAt, tz));
      setTimezone(tz);
      setNote(state.scheduledCallNote || '');
    } else {
      // Default: tomorrow at 2 PM in the lead's tz (or ET fallback)
      const tz = state?.leadTimezone || 'America/New_York';
      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      setDatetimeLocal(toLocalDateTimeInput(tomorrow.toISOString(), tz));
      setTimezone(tz);
      setNote('');
    }
    setEditing(true);
  };

  const handleSave = async () => {
    const iso = localDateTimeToUtcIso(datetimeLocal, timezone);
    if (!iso) {
      toast.error('Please enter a valid date and time');
      return;
    }
    if (new Date(iso).getTime() <= Date.now()) {
      toast.error('Call time must be in the future');
      return;
    }
    setSaving(true);
    try {
      const updated = await apiFetch<CallDetailsState>(
        `/conversations/${conversationId}/call`,
        {
          method: 'PUT',
          body: JSON.stringify({
            scheduledCallAt: iso,
            scheduledCallTimezone: timezone,
            note: note.trim() || undefined
          })
        }
      );
      setState(updated);
      setEditing(false);
      toast.success('Call details saved. Reminders scheduled.');
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to save call details';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    try {
      await apiFetch(`/conversations/${conversationId}/call`, {
        method: 'DELETE'
      });
      await fetchState();
      toast.success('Call details cleared. Reminders cancelled.');
    } catch {
      toast.error('Failed to clear call details');
    }
  };

  if (loading) return null;

  const hasCall = !!state?.scheduledCallAt;
  const displayTz =
    state?.scheduledCallTimezone || state?.leadTimezone || 'UTC';

  return (
    <div className='rounded-lg border p-3'>
      <h5 className='text-muted-foreground mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase'>
        <IconCalendarEvent className='h-3.5 w-3.5' /> Call Details
      </h5>

      {/* Display mode */}
      {!editing && !hasCall && (
        <div className='space-y-2'>
          <p className='text-muted-foreground text-xs'>No call scheduled</p>
          <Button size='sm' variant='outline' onClick={startEdit}>
            + Add Call Details
          </Button>
        </div>
      )}

      {!editing && hasCall && state && (
        <div className='space-y-2 text-xs'>
          <div>
            <div className='font-medium'>
              {formatInTz(state.scheduledCallAt, displayTz)}
            </div>
            {state.leadTimezone &&
              displayTz !== state.leadTimezone &&
              state.leadTimezone !== displayTz && (
                <div className='text-muted-foreground'>
                  {formatInTz(state.scheduledCallAt, state.leadTimezone)} (lead
                  local)
                </div>
              )}
          </div>
          {state.scheduledCallNote && (
            <div className='text-muted-foreground italic'>
              &ldquo;{state.scheduledCallNote}&rdquo;
            </div>
          )}
          {state.scheduledCallSource && (
            <div className='text-muted-foreground text-[10px]'>
              Source:{' '}
              {state.scheduledCallSource.replace(/_/g, ' ').toLowerCase()}
            </div>
          )}
          {state.reminders.length > 0 && (
            <div className='space-y-1 border-t pt-2'>
              <div className='text-muted-foreground flex items-center gap-1 text-[10px] font-medium'>
                <IconClock className='h-3 w-3' />
                Reminders
              </div>
              {state.reminders.map((r) => (
                <div
                  key={r.id}
                  className='text-muted-foreground flex items-center gap-1 text-[10px]'
                >
                  <IconCheck className='h-3 w-3 text-emerald-600' />
                  {r.messageType === 'DAY_BEFORE_REMINDER'
                    ? 'Day before'
                    : 'Morning of'}
                  : {formatInTz(r.scheduledFor, displayTz)}
                </div>
              ))}
            </div>
          )}
          <div className='flex gap-2 pt-1'>
            <Button size='sm' variant='outline' onClick={startEdit}>
              Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size='sm' variant='ghost'>
                  Clear
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear call details?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will cancel any scheduled reminders for this
                    conversation. Cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleClear}>
                    Clear
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <div className='space-y-2'>
          <div className='space-y-1'>
            <Label htmlFor='call-dt' className='text-[10px]'>
              Date &amp; Time
            </Label>
            <Input
              id='call-dt'
              type='datetime-local'
              value={datetimeLocal}
              onChange={(e) => setDatetimeLocal(e.target.value)}
              className='h-8 text-xs'
            />
          </div>
          <div className='space-y-1'>
            <Label htmlFor='call-tz' className='text-[10px]'>
              Timezone (lead&apos;s local time)
            </Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id='call-tz' className='h-8 text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONE_OPTIONS.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1'>
            <Label htmlFor='call-note' className='text-[10px]'>
              Note (optional)
            </Label>
            <Input
              id='call-note'
              type='text'
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 140))}
              placeholder='e.g., rescheduled from Tuesday'
              maxLength={140}
              className='h-8 text-xs'
            />
          </div>
          <div className='flex gap-2 pt-1'>
            <Button size='sm' onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Returns a compact badge label for the conversation list preview.
 * Returns null if no call or call is >7 days out.
 */
export function callBadgeLabel(
  scheduledCallAt: string | null | undefined
): string | null {
  if (!scheduledCallAt) return null;
  const ms = new Date(scheduledCallAt).getTime() - Date.now();
  if (ms < 0) return null;
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor(ms / 3_600_000);
  if (days === 0) return hours === 0 ? 'Call soon' : 'Call today';
  if (days === 1) return 'Call tomorrow';
  if (days <= 7) return `Call in ${days}d`;
  return null;
}
