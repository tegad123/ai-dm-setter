'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Loader2, GraduationCap, ChevronRight, Clock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface AccountData {
  id: string;
  name: string | null;
  slug: string | null;
  brandName: string | null;
  plan: string;
  onboardingComplete: boolean;
  responseDelayMin: number;
  responseDelayMax: number;
}

interface TrainingPhaseData {
  trainingPhase: string;
  trainingPhaseStartedAt: string;
  trainingPhaseCompletedAt: string | null;
  trainingTargetOverrideCount: number;
  trainingOverrideCount: number;
}

export default function AccountSettingsPage() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [brandName, setBrandName] = useState('');
  const [training, setTraining] = useState<TrainingPhaseData | null>(null);
  const [trainingAction, setTrainingAction] = useState(false);
  const [delayMinSec, setDelayMinSec] = useState<number>(300);
  const [delayMaxSec, setDelayMaxSec] = useState<number>(600);
  const [savingTiming, setSavingTiming] = useState(false);

  useEffect(() => {
    apiFetch<{ account: AccountData }>('/settings/account')
      .then(({ account }) => {
        setAccount(account);
        setName(account.name || '');
        setBrandName(account.brandName || '');
        setDelayMinSec(account.responseDelayMin ?? 300);
        setDelayMaxSec(account.responseDelayMax ?? 600);
      })
      .catch(() => toast.error('Failed to load account settings'))
      .finally(() => setLoading(false));

    apiFetch<{ trainingPhase: TrainingPhaseData }>('/settings/training-phase')
      .then(({ trainingPhase }) => setTraining(trainingPhase))
      .catch(() => {
        // Non-fatal — training card just won't show
      });
  }, []);

  const handleTrainingAction = async (
    action: 'complete' | 'pause' | 'resume' | 'restart'
  ) => {
    if (action === 'restart') {
      const ok = window.confirm(
        'Restart onboarding? This resets the override counter to 0 and ' +
          'puts your AI back in training mode. Your existing AI messages ' +
          'are not affected — only the training state is reset.'
      );
      if (!ok) return;
    }
    setTrainingAction(true);
    try {
      const res = await apiFetch<{ trainingPhase: TrainingPhaseData }>(
        '/settings/training-phase',
        {
          method: 'PUT',
          body: JSON.stringify({ action })
        }
      );
      setTraining(res.trainingPhase);
      const labels: Record<string, string> = {
        complete: 'Training complete! Your AI is now in active mode.',
        pause: 'Training paused.',
        resume: 'Training resumed.',
        restart: 'Onboarding restarted. Counter reset to 0.'
      };
      toast.success(labels[action]);
    } catch {
      toast.error('Failed to update training phase');
    } finally {
      setTrainingAction(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await apiFetch<{ account: AccountData }>(
        '/settings/account',
        {
          method: 'PUT',
          body: JSON.stringify({ name, brandName })
        }
      );
      setAccount(updated.account);
      toast.success('Account settings saved');
    } catch {
      toast.error('Failed to save account settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveTiming = async () => {
    if (delayMaxSec < delayMinSec) {
      toast.error('Maximum delay must be at least the minimum delay');
      return;
    }
    setSavingTiming(true);
    try {
      const updated = await apiFetch<{ account: AccountData }>(
        '/settings/account',
        {
          method: 'PUT',
          body: JSON.stringify({
            responseDelayMin: delayMinSec,
            responseDelayMax: delayMaxSec
          })
        }
      );
      setAccount(updated.account);
      toast.success('Response timing saved');
    } catch {
      toast.error('Failed to save response timing');
    } finally {
      setSavingTiming(false);
    }
  };

  const formatSeconds = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
  };

  if (loading) {
    return (
      <div className='flex flex-1 items-center justify-center p-6'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Account Settings</h2>
        <p className='text-muted-foreground'>
          Manage your account name, branding, and plan
        </p>
      </div>

      <Separator />

      <div className='grid gap-6'>
        <Card>
          <CardHeader>
            <CardTitle>Account Details</CardTitle>
            <CardDescription>
              Basic information about your account
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='space-y-2'>
              <Label htmlFor='account-name'>Account Name</Label>
              <Input
                id='account-name'
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder='Your account name'
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='brand-name'>Brand Name</Label>
              <Input
                id='brand-name'
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder='Your brand or business name'
              />
              <p className='text-muted-foreground text-xs'>
                This is the name the AI uses when referring to your business in
                conversations.
              </p>
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
              Save Changes
            </Button>
          </CardContent>
        </Card>

        {/* Response Timing — global, applies to every script */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <Clock className='text-muted-foreground h-5 w-5' />
              <div>
                <CardTitle>Response Timing</CardTitle>
                <CardDescription>
                  How long the AI waits before replying. A random value between
                  min and max is picked for each message.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='delay-min'>
                  Minimum delay (seconds) ·{' '}
                  <span className='text-muted-foreground font-normal'>
                    {formatSeconds(delayMinSec)}
                  </span>
                </Label>
                <Input
                  id='delay-min'
                  type='number'
                  min={0}
                  value={delayMinSec}
                  onChange={(e) =>
                    setDelayMinSec(Math.max(0, Number(e.target.value) || 0))
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='delay-max'>
                  Maximum delay (seconds) ·{' '}
                  <span className='text-muted-foreground font-normal'>
                    {formatSeconds(delayMaxSec)}
                  </span>
                </Label>
                <Input
                  id='delay-max'
                  type='number'
                  min={0}
                  value={delayMaxSec}
                  onChange={(e) =>
                    setDelayMaxSec(Math.max(0, Number(e.target.value) || 0))
                  }
                />
              </div>
            </div>
            <div className='flex items-center gap-3'>
              <Button onClick={handleSaveTiming} disabled={savingTiming}>
                {savingTiming && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                Save Timing
              </Button>
              <p className='text-muted-foreground text-xs'>
                Set both to 0 to reply immediately (testing only).
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Your current subscription plan</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex items-center gap-3'>
              <Badge variant='secondary' className='text-sm'>
                {account?.plan || 'Free'}
              </Badge>
              {account?.onboardingComplete && (
                <span className='text-muted-foreground text-sm'>
                  Onboarding complete
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Training Mode Card */}
        {training && (
          <Card>
            <CardHeader>
              <div className='flex items-center gap-2'>
                <GraduationCap className='h-5 w-5 text-blue-600 dark:text-blue-400' />
                <div>
                  <CardTitle>AI Training Mode</CardTitle>
                  <CardDescription>
                    Your AI learns your voice from your corrections
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className='space-y-4'>
              <div className='flex items-center gap-3'>
                <Badge
                  variant={
                    training.trainingPhase === 'ONBOARDING'
                      ? 'default'
                      : training.trainingPhase === 'ACTIVE'
                        ? 'secondary'
                        : 'outline'
                  }
                >
                  {training.trainingPhase === 'ONBOARDING'
                    ? 'Training'
                    : training.trainingPhase === 'ACTIVE'
                      ? 'Active'
                      : 'Paused'}
                </Badge>
                <span className='text-muted-foreground text-sm'>
                  {training.trainingOverrideCount} /{' '}
                  {training.trainingTargetOverrideCount} overrides captured
                </span>
              </div>

              {training.trainingPhase === 'ONBOARDING' && (
                <>
                  <Progress
                    value={Math.min(
                      100,
                      Math.round(
                        (training.trainingOverrideCount /
                          training.trainingTargetOverrideCount) *
                          100
                      )
                    )}
                    className='h-2'
                  />
                  <p className='text-muted-foreground text-xs'>
                    Correct the AI on at least{' '}
                    {training.trainingTargetOverrideCount} messages during
                    onboarding. Each correction teaches the AI your voice.
                  </p>
                  <div className='flex gap-2'>
                    {training.trainingOverrideCount >=
                      training.trainingTargetOverrideCount && (
                      <Button
                        onClick={() => handleTrainingAction('complete')}
                        disabled={trainingAction}
                        className='bg-emerald-600 hover:bg-emerald-700'
                      >
                        {trainingAction && (
                          <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                        )}
                        Complete Training
                        <ChevronRight className='ml-1 h-4 w-4' />
                      </Button>
                    )}
                    <Button
                      variant='outline'
                      onClick={() => handleTrainingAction('complete')}
                      disabled={trainingAction}
                    >
                      Skip to Active Mode
                    </Button>
                  </div>
                </>
              )}

              {training.trainingPhase === 'ACTIVE' && (
                <div className='space-y-3'>
                  <p className='text-muted-foreground text-xs'>
                    Your AI is in active mode. It continues learning from every
                    correction you make — training never truly stops.
                    {training.trainingPhaseCompletedAt &&
                      ` Completed on ${new Date(training.trainingPhaseCompletedAt).toLocaleDateString()}.`}
                  </p>
                  <div className='flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/50 dark:bg-amber-950/20'>
                    <div className='flex-1'>
                      <p className='text-xs font-medium text-amber-900 dark:text-amber-200'>
                        AI voice drifted? Restart onboarding.
                      </p>
                      <p className='mt-0.5 text-[11px] text-amber-800/80 dark:text-amber-300/80'>
                        Resets the override counter and re-engages the
                        structured training prompts. Your existing AI history is
                        preserved — only the training state is reset.
                      </p>
                    </div>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => handleTrainingAction('restart')}
                      disabled={trainingAction}
                      className='shrink-0 border-amber-300 bg-white text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-950/40'
                    >
                      {trainingAction && (
                        <Loader2 className='mr-2 h-3.5 w-3.5 animate-spin' />
                      )}
                      Restart Onboarding
                    </Button>
                  </div>
                </div>
              )}

              {training.trainingPhase === 'PAUSED' && (
                <div className='space-y-2'>
                  <p className='text-muted-foreground text-xs'>
                    Training is paused. Resume to continue teaching the AI your
                    voice.
                  </p>
                  <Button
                    variant='outline'
                    onClick={() => handleTrainingAction('resume')}
                    disabled={trainingAction}
                  >
                    {trainingAction && (
                      <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                    )}
                    Resume Training
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
