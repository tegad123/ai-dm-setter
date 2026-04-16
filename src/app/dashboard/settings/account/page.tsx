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
import { Loader2, GraduationCap, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';

interface AccountData {
  id: string;
  name: string | null;
  slug: string | null;
  brandName: string | null;
  plan: string;
  onboardingComplete: boolean;
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

  useEffect(() => {
    apiFetch<{ account: AccountData }>('/settings/account')
      .then(({ account }) => {
        setAccount(account);
        setName(account.name || '');
        setBrandName(account.brandName || '');
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
    action: 'complete' | 'pause' | 'resume'
  ) => {
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
        resume: 'Training resumed.'
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
                <p className='text-muted-foreground text-xs'>
                  Your AI is in active mode. It continues learning from every
                  correction you make — training never truly stops.
                  {training.trainingPhaseCompletedAt &&
                    ` Completed on ${new Date(training.trainingPhaseCompletedAt).toLocaleDateString()}.`}
                </p>
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
