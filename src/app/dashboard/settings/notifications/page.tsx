'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

interface Prefs {
  notifyOnDistress: boolean;
  notifyOnSchedulingConflict: boolean;
  notifyOnAIStuck: boolean;
  notifyOnHumanOverride: boolean;
  notifyOnCallBooked: boolean;
  notifyOnHotLead: boolean;
  notifyOnBookingLimbo: boolean;
  notifyOnNoShow: boolean;
  notifyOnClosedDeal: boolean;
  emailDailySummary: boolean;
  emailWeeklyReport: boolean;
  accountEmail: string;
}

export default function NotificationSettingsPage() {
  const [prefs, setPrefs] = React.useState<Prefs | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch('/api/settings/notification-prefs')
      .then((r) => r.json())
      .then((p: Prefs) => setPrefs(p))
      .catch(() => setStatus('Failed to load preferences'));
  }, []);

  const toggle = React.useCallback(async (key: keyof Prefs, value: boolean) => {
    if (key === 'accountEmail') return;
    setPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));
    setStatus('Saving…');
    const res = await fetch('/api/settings/notification-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value })
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: 'unknown' }))) as {
        error?: string;
      };
      setStatus(`Save failed: ${err.error ?? 'unknown'}`);
      return;
    }
    const next = (await res.json()) as Prefs;
    setPrefs(next);
    setStatus('Saved');
    setTimeout(() => setStatus(null), 1400);
  }, []);

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>
          Notification Settings
        </h2>
        <p className='text-muted-foreground'>
          Configure how and when you receive notifications
        </p>
      </div>

      <Separator />

      <div className='grid gap-6'>
        {/* URGENT — in-app + email */}
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              <span aria-hidden>🚨</span>
              Urgent Alerts
            </CardTitle>
            <CardDescription>
              Critical events that need immediate attention. These also trigger
              an email to your account address.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <ToggleRow
              id='notify-distress'
              label='Distress signal detected'
              description='A lead may be in crisis — needs immediate human response'
              checked={prefs?.notifyOnDistress ?? true}
              onChange={(v) => toggle('notifyOnDistress', v)}
            />
            <ToggleRow
              id='notify-sched'
              label='Scheduling conflict'
              description="A lead can't make the available booking times — needs manual scheduling"
              checked={prefs?.notifyOnSchedulingConflict ?? true}
              onChange={(v) => toggle('notifyOnSchedulingConflict', v)}
            />
            <ToggleRow
              id='notify-ai-stuck'
              label='Lead stuck — AI cannot help'
              description='AI exhausted retries and needs human intervention'
              checked={prefs?.notifyOnAIStuck ?? true}
              onChange={(v) => toggle('notifyOnAIStuck', v)}
            />
          </CardContent>
        </Card>

        {/* ACTIVITY — in-app only */}
        <Card>
          <CardHeader>
            <CardTitle>Activity Notifications</CardTitle>
            <CardDescription>
              Routine events surfaced in the dashboard. In-app only — no emails.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <ToggleRow
              id='notify-human-override'
              label='Human override needed'
              description='AI flags a conversation for manual review'
              checked={prefs?.notifyOnHumanOverride ?? true}
              onChange={(v) => toggle('notifyOnHumanOverride', v)}
            />
            <ToggleRow
              id='notify-call-booked'
              label='Call booked'
              description='A lead books a call'
              checked={prefs?.notifyOnCallBooked ?? true}
              onChange={(v) => toggle('notifyOnCallBooked', v)}
            />
            <ToggleRow
              id='notify-hot-lead'
              label='Hot lead detected'
              description='AI identifies a high-intent lead'
              checked={prefs?.notifyOnHotLead ?? true}
              onChange={(v) => toggle('notifyOnHotLead', v)}
            />
            <ToggleRow
              id='notify-booking-limbo'
              label='Booking limbo alert'
              description="A lead filled out the Typeform but hasn't confirmed their booking after 24 hours"
              checked={prefs?.notifyOnBookingLimbo ?? true}
              onChange={(v) => toggle('notifyOnBookingLimbo', v)}
            />
            <ToggleRow
              id='notify-no-show'
              label='No-show alert'
              description='Lead missed their scheduled call'
              checked={prefs?.notifyOnNoShow ?? true}
              onChange={(v) => toggle('notifyOnNoShow', v)}
            />
            <ToggleRow
              id='notify-closed-deal'
              label='Closed deal'
              description='Lead enrolled and paid'
              checked={prefs?.notifyOnClosedDeal ?? true}
              onChange={(v) => toggle('notifyOnClosedDeal', v)}
            />
          </CardContent>
        </Card>

        {/* EMAIL REPORTS */}
        <Card>
          <CardHeader>
            <CardTitle>Email Reports</CardTitle>
            <CardDescription>
              Scheduled summary reports delivered to your inbox
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <ToggleRow
              id='daily-summary'
              label='Daily summary'
              description='Total leads contacted, calls booked, pipeline snapshot — sent every evening'
              checked={prefs?.emailDailySummary ?? true}
              onChange={(v) => toggle('emailDailySummary', v)}
            />
            <ToggleRow
              id='weekly-report'
              label='Weekly report'
              description='Full analytics summary — sent every Monday morning'
              checked={prefs?.emailWeeklyReport ?? true}
              onChange={(v) => toggle('emailWeeklyReport', v)}
            />
            <Separator />
            <div className='flex items-start justify-between gap-3'>
              <div className='space-y-0.5'>
                <p className='text-sm font-medium'>
                  Notifications sent to:{' '}
                  <span className='font-mono text-sm font-normal'>
                    {prefs?.accountEmail ?? '…'}
                  </span>
                </p>
                <p className='text-muted-foreground text-xs'>
                  Urgent alerts + reports go to your account email.
                </p>
              </div>
              <Link
                href='/dashboard/settings/account'
                className='text-primary shrink-0 text-sm underline-offset-4 hover:underline'
              >
                Change email → Account Settings
              </Link>
            </div>
          </CardContent>
        </Card>

        {status ? (
          <p className='text-muted-foreground text-xs'>{status}</p>
        ) : null}
      </div>
    </div>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className='flex items-center justify-between'>
      <Label htmlFor={id} className='flex flex-col gap-1'>
        <span>{label}</span>
        <span className='text-muted-foreground text-sm font-normal'>
          {description}
        </span>
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
