'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CheckCircle2
} from 'lucide-react';
import type { Script } from '@/lib/script-types';

interface ParseSummaryBannerProps {
  script: Script;
  onReupload: () => void;
}

export default function ParseSummaryBanner({
  script,
  onReupload
}: ParseSummaryBannerProps) {
  const [warningsOpen, setWarningsOpen] = useState(false);

  const stats = useMemo(() => {
    let totalActions = 0;
    let needsReview = 0;
    let needsInput = 0;

    for (const step of script.steps) {
      const allActions = [
        ...step.actions,
        ...step.branches.flatMap((b) => b.actions)
      ];
      totalActions += allActions.length;
      for (const action of allActions) {
        if (action.parserStatus === 'needs_review') needsReview++;
        if (action.parserStatus === 'needs_user_input') needsInput++;
      }
    }

    return { totalActions, needsReview, needsInput };
  }, [script.steps]);

  const warnings = script.parseWarnings || [];
  const reviewCount = stats.needsReview + stats.needsInput;
  const allReviewed = reviewCount === 0;

  const timeAgo = script.lastParsedAt
    ? formatTimeAgo(new Date(script.lastParsedAt))
    : null;

  return (
    <div className='border-b border-blue-200 bg-blue-50 px-4 py-2.5 dark:border-blue-800/50 dark:bg-blue-950/20'>
      <div className='flex items-center gap-3'>
        <Upload className='h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400' />

        <div className='flex flex-1 flex-wrap items-center gap-2 text-sm'>
          <span className='font-medium text-blue-800 dark:text-blue-300'>
            Parsed from upload
          </span>
          {timeAgo && (
            <span className='text-blue-600/70 dark:text-blue-400/70'>
              {timeAgo}
            </span>
          )}

          <span className='text-blue-400 dark:text-blue-600'>|</span>

          <span className='text-blue-700 dark:text-blue-300'>
            {script.steps.length} steps, {stats.totalActions} actions
          </span>

          {allReviewed ? (
            <Badge
              variant='outline'
              className='border-green-300 text-green-700 dark:border-green-700 dark:text-green-400'
            >
              <CheckCircle2 className='mr-1 h-3 w-3' />
              All reviewed
            </Badge>
          ) : (
            <Badge
              variant='outline'
              className='border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400'
            >
              <AlertTriangle className='mr-1 h-3 w-3' />
              {reviewCount} field{reviewCount !== 1 ? 's' : ''} need review
            </Badge>
          )}

          {warnings.length > 0 && (
            <button
              onClick={() => setWarningsOpen(!warningsOpen)}
              className='inline-flex items-center gap-1 text-xs text-blue-600 hover:underline dark:text-blue-400'
            >
              {warnings.length} warning{warnings.length !== 1 ? 's' : ''}
              {warningsOpen ? (
                <ChevronUp className='h-3 w-3' />
              ) : (
                <ChevronDown className='h-3 w-3' />
              )}
            </button>
          )}
        </div>

        <Button
          variant='outline'
          size='sm'
          onClick={onReupload}
          className='shrink-0 border-blue-300 text-blue-700 hover:bg-blue-100 dark:border-blue-700 dark:text-blue-300 dark:hover:bg-blue-900/30'
        >
          <Upload className='mr-1.5 h-3.5 w-3.5' />
          Re-upload
        </Button>
      </div>

      {warningsOpen && warnings.length > 0 && (
        <div className='mt-2 rounded bg-blue-100/60 p-2 dark:bg-blue-900/30'>
          <ul className='space-y-1'>
            {warnings.map((w, i) => (
              <li
                key={i}
                className='flex items-start gap-1.5 text-xs text-blue-700 dark:text-blue-300'
              >
                <AlertTriangle className='mt-0.5 h-3 w-3 shrink-0' />
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
