'use client';

import * as React from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';

interface Prefs {
  notificationEmail: string | null;
  notifyOnSchedulingConflict: boolean;
  notifyOnDistress: boolean;
  notifyOnStuckLead: boolean;
  notifyOnAIStuck: boolean;
  notifyOnAllAIPauses: boolean;
}

function ExternalAlertsCard() {
  const [prefs, setPrefs] = React.useState<Prefs | null>(null);
  const [email, setEmail] = React.useState('');
  const [status, setStatus] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch('/api/settings/notification-prefs')
      .then((r) => r.json())
      .then((p: Prefs) => {
        setPrefs(p);
        setEmail(p.notificationEmail ?? '');
      })
      .catch(() => setStatus('Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []);

  const patch = React.useCallback(async (partial: Partial<Prefs>) => {
    setStatus('Saving…');
    const res = await fetch('/api/settings/notification-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial)
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
    setTimeout(() => setStatus(null), 1600);
  }, []);

  const onEmailBlur = () => {
    const trimmed = email.trim();
    if (trimmed === (prefs?.notificationEmail ?? '')) return;
    patch({ notificationEmail: trimmed.length > 0 ? trimmed : null });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>External Alerts (Email)</CardTitle>
        <CardDescription>
          Reach you outside the dashboard when the AI hits a wall only a human
          can resolve. Critical items fire immediately; others follow the
          toggles below.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        <div className='space-y-1'>
          <Label htmlFor='notification-email'>Notification email</Label>
          <Input
            id='notification-email'
            type='email'
            placeholder='alerts@yourdomain.com'
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={onEmailBlur}
            disabled={loading}
          />
          <p className='text-muted-foreground text-xs'>
            Leave empty to disable email alerts entirely (in-app notifications
            keep firing).
          </p>
        </div>
        {prefs && (
          <>
            <Separator />
            <ToggleRow
              id='notify-sched'
              label='Scheduling conflicts'
              description='Lead filled Typeform but can’t make available times — needs you to confirm a slot'
              checked={prefs.notifyOnSchedulingConflict}
              onChange={(v) => patch({ notifyOnSchedulingConflict: v })}
            />
            <ToggleRow
              id='notify-distress'
              label='Distress signals'
              description='Lead’s message matched the crisis / desperation detector — safety escalation'
              checked={prefs.notifyOnDistress}
              onChange={(v) => patch({ notifyOnDistress: v })}
            />
            <ToggleRow
              id='notify-stuck'
              label='Stuck lead 24h+'
              description='Lead has been waiting more than 24 hours for a response'
              checked={prefs.notifyOnStuckLead}
              onChange={(v) => patch({ notifyOnStuckLead: v })}
            />
            <ToggleRow
              id='notify-ai-stuck'
              label='AI stuck'
              description='Retries exhausted on an unshippable reply, conversation paused'
              checked={prefs.notifyOnAIStuck}
              onChange={(v) => patch({ notifyOnAIStuck: v })}
            />
            <ToggleRow
              id='notify-all-pauses'
              label='All AI pauses (noisy)'
              description='Every time the system pauses the AI for any reason — off by default'
              checked={prefs.notifyOnAllAIPauses}
              onChange={(v) => patch({ notifyOnAllAIPauses: v })}
            />
          </>
        )}
        {status ? (
          <p className='text-muted-foreground text-xs'>{status}</p>
        ) : null}
      </CardContent>
    </Card>
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

export default function NotificationSettingsPage() {
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
        <ExternalAlertsCard />
        <Card>
          <CardHeader>
            <CardTitle>Push Notifications</CardTitle>
            <CardDescription>
              Instant alerts for important events
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <Label htmlFor='call-booked' className='flex flex-col gap-1'>
                <span>Call Booked</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Get notified when a lead books a call
                </span>
              </Label>
              <Switch id='call-booked' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='hot-lead' className='flex flex-col gap-1'>
                <span>Hot Lead Detected</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  AI identifies a high-intent lead
                </span>
              </Label>
              <Switch id='hot-lead' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='human-override' className='flex flex-col gap-1'>
                <span>Human Override Needed</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  AI flags a conversation for manual review
                </span>
              </Label>
              <Switch id='human-override' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='no-show' className='flex flex-col gap-1'>
                <span>No Show Alert</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Lead missed their scheduled call
                </span>
              </Label>
              <Switch id='no-show' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='closed-deal' className='flex flex-col gap-1'>
                <span>Closed Deal</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Lead enrolled and paid
                </span>
              </Label>
              <Switch id='closed-deal' defaultChecked />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email Reports</CardTitle>
            <CardDescription>
              Scheduled summary reports delivered to your inbox
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='flex items-center justify-between'>
              <Label htmlFor='daily-summary' className='flex flex-col gap-1'>
                <span>Daily Summary</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Total leads contacted, calls booked, pipeline snapshot — sent
                  every evening
                </span>
              </Label>
              <Switch id='daily-summary' defaultChecked />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='weekly-report' className='flex flex-col gap-1'>
                <span>Weekly Report</span>
                <span className='text-muted-foreground text-sm font-normal'>
                  Full analytics summary — sent every Monday morning
                </span>
              </Label>
              <Switch id='weekly-report' defaultChecked />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
