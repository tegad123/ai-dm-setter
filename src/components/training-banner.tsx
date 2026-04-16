'use client';

import { useState, useEffect } from 'react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';
import { GraduationCap, X, ChevronRight } from 'lucide-react';

interface TrainingPhaseData {
  trainingPhase: string;
  trainingPhaseStartedAt: string;
  trainingPhaseCompletedAt: string | null;
  trainingTargetOverrideCount: number;
  trainingOverrideCount: number;
}

export function TrainingBanner() {
  const [data, setData] = useState<TrainingPhaseData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [showLearnMore, setShowLearnMore] = useState(false);
  const [showComplete, setShowComplete] = useState(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    apiFetch<{ trainingPhase: TrainingPhaseData }>('/settings/training-phase')
      .then(({ trainingPhase }) => setData(trainingPhase))
      .catch(() => {
        // Non-fatal — banner just won't show
      });
  }, []);

  if (!data || data.trainingPhase !== 'ONBOARDING' || dismissed) {
    return null;
  }

  const progress = Math.min(
    100,
    Math.round(
      (data.trainingOverrideCount / data.trainingTargetOverrideCount) * 100
    )
  );
  const isComplete =
    data.trainingOverrideCount >= data.trainingTargetOverrideCount;

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await apiFetch('/settings/training-phase', {
        method: 'PUT',
        body: JSON.stringify({ action: 'complete' })
      });
      setData((prev) => (prev ? { ...prev, trainingPhase: 'ACTIVE' } : null));
      setShowComplete(false);
      toast.success('Training complete! Your AI is now in active mode.');
    } catch {
      toast.error('Failed to complete training');
    } finally {
      setCompleting(false);
    }
  };

  // If override count hit the target, show the completion prompt
  if (isComplete && !showComplete) {
    return (
      <div className='border-b border-emerald-200 bg-emerald-50 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/30'>
        <div className='mx-auto flex max-w-5xl items-center justify-between gap-4'>
          <div className='flex items-center gap-3'>
            <GraduationCap className='h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            <div>
              <p className='text-sm font-medium text-emerald-900 dark:text-emerald-100'>
                Your AI has captured {data.trainingOverrideCount} overrides from
                you.
              </p>
              <p className='text-xs text-emerald-700 dark:text-emerald-300'>
                It has learned enough of your voice to start getting better each
                day.
              </p>
            </div>
          </div>
          <Button
            size='sm'
            className='shrink-0 bg-emerald-600 hover:bg-emerald-700'
            onClick={handleComplete}
            disabled={completing}
          >
            Complete training
            <ChevronRight className='ml-1 h-4 w-4' />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className='border-b border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-800 dark:bg-blue-950/30'>
        <div className='mx-auto flex max-w-5xl items-center justify-between gap-4'>
          <div className='flex min-w-0 flex-1 items-center gap-3'>
            <GraduationCap className='h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400' />
            <div className='min-w-0 flex-1'>
              <p className='text-sm font-medium text-blue-900 dark:text-blue-100'>
                Training your AI — Week 1 of onboarding
              </p>
              <p className='text-xs text-blue-700 dark:text-blue-300'>
                Your AI learns your voice by watching how you correct it.{' '}
                <button
                  className='underline hover:no-underline'
                  onClick={() => setShowLearnMore(true)}
                >
                  Learn more
                </button>
              </p>
              <div className='mt-2 flex items-center gap-3'>
                <Progress value={progress} className='h-1.5 flex-1' />
                <span className='text-xs font-medium whitespace-nowrap text-blue-700 dark:text-blue-300'>
                  {data.trainingOverrideCount} /{' '}
                  {data.trainingTargetOverrideCount} overrides
                </span>
              </div>
            </div>
          </div>
          <button
            className='text-blue-400 hover:text-blue-600 dark:text-blue-500 dark:hover:text-blue-300'
            onClick={() => setDismissed(true)}
            aria-label='Dismiss banner'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
      </div>

      {/* Learn More Modal */}
      <Dialog open={showLearnMore} onOpenChange={setShowLearnMore}>
        <DialogContent className='max-w-lg'>
          <DialogHeader>
            <DialogTitle>How to train your AI in Week 1</DialogTitle>
          </DialogHeader>
          <div className='space-y-4 text-sm'>
            <p>
              Your AI starts with a general sales voice and learns your specific
              voice through your corrections. The more you correct it, the more
              accurate it becomes.
            </p>

            <div className='space-y-2'>
              <p className='font-medium'>
                How to get maximum value from training week:
              </p>
              <ol className='list-decimal space-y-2 pl-5'>
                <li>Use the AI on at least 20 real conversations</li>
                <li>
                  When the AI sends something that doesn&apos;t sound like you,
                  pause the conversation and send what you actually would have
                  sent
                </li>
                <li>
                  In the &quot;why did you change it&quot; field, leave a
                  one-line reason. Examples:
                  <ul className='text-muted-foreground mt-1 list-disc pl-5'>
                    <li>&quot;Too formal&quot;</li>
                    <li>&quot;Shouldn&apos;t have pitched yet&quot;</li>
                    <li>&quot;Missed the objection&quot;</li>
                    <li>&quot;Wrong tone for this lead type&quot;</li>
                  </ul>
                </li>
                <li>
                  Correct in your real voice. Don&apos;t clean it up for the AI.
                  Authentic corrections train a better AI than polished ones.
                </li>
              </ol>
            </div>

            <div className='space-y-2'>
              <p className='font-medium'>Every correction teaches the AI:</p>
              <ul className='text-muted-foreground list-disc pl-5'>
                <li>Which phrases to avoid</li>
                <li>When to advance conversation stages</li>
                <li>How you handle specific objections</li>
                <li>Your texting rhythm and vocabulary</li>
              </ul>
            </div>

            <p className='text-muted-foreground text-xs'>
              After ~20 overrides, your AI will be measurably closer to your
              voice. The learning continues past week 1 — every correction you
              make forever keeps refining it — but week 1 is when the biggest
              gains happen.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
