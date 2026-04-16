'use client';

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
import { Button } from '@/components/ui/button';
import { Loader2, BarChart3 } from 'lucide-react';
import type { CostEstimate } from '@/lib/api';

interface AnalysisCostDialogProps {
  estimate: CostEstimate | null;
  loading: boolean;
  running: boolean;
  onEstimate: () => void;
  onConfirm: () => void;
}

export default function AnalysisCostDialog({
  estimate,
  loading,
  running,
  onEstimate,
  onConfirm
}: AnalysisCostDialogProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button onClick={onEstimate} disabled={loading || running}>
          {loading ? (
            <Loader2 className='mr-2 h-4 w-4 animate-spin' />
          ) : (
            <BarChart3 className='mr-2 h-4 w-4' />
          )}
          {running ? 'Analyzing...' : 'Run Analysis'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run Training Data Analysis?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className='space-y-3'>
              {loading ? (
                <div className='flex items-center gap-2'>
                  <Loader2 className='h-4 w-4 animate-spin' />
                  <span>Estimating cost...</span>
                </div>
              ) : estimate ? (
                <>
                  <p>
                    {estimate.isIncremental &&
                    estimate.newConversations !== undefined ? (
                      estimate.newConversations === 0 ? (
                        <>
                          All <strong>{estimate.totalConversations}</strong>{' '}
                          conversations have already been analyzed. This will
                          re-score with updated metrics only (minimal cost).
                        </>
                      ) : (
                        <>
                          Analyzing <strong>{estimate.newConversations}</strong>{' '}
                          new conversations (
                          {estimate.totalConversations -
                            estimate.newConversations}{' '}
                          already analyzed). Only new data will be sent to the
                          AI.
                        </>
                      )
                    ) : (
                      <>
                        This will analyze{' '}
                        <strong>{estimate.totalConversations}</strong>{' '}
                        conversations ({estimate.totalMessages.toLocaleString()}{' '}
                        messages) across 6 quality categories.
                      </>
                    )}
                  </p>
                  <div className='bg-muted rounded-md p-3'>
                    <p className='text-sm font-medium'>
                      Estimated cost:{' '}
                      <span className='text-primary'>
                        {estimate.estimatedCostDollars}
                      </span>
                    </p>
                    <p className='text-muted-foreground text-xs'>
                      ~{estimate.estimatedTokens.toLocaleString()} tokens via
                      Claude Haiku
                    </p>
                  </div>
                  <p className='text-muted-foreground text-xs'>
                    {estimate.isIncremental && estimate.newConversations === 0
                      ? 'This will be quick since no new data needs scanning.'
                      : 'Analysis typically takes 30-90 seconds depending on data volume.'}
                  </p>
                </>
              ) : (
                <p>
                  Click to estimate the cost of analyzing your training data.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={!estimate || loading || running}
          >
            {running ? <Loader2 className='mr-2 h-4 w-4 animate-spin' /> : null}
            Run Analysis
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
