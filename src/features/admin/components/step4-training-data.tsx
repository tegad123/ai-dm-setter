'use client';

// Step 4 — training data. Phase 2 fidelity: link out to the existing
// /dashboard/settings/training UI (Phase 3 will move the upload
// inline once the CSV/JSON parser is wired into the admin flow).

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Status {
  accountId: string;
  trainingCount: number;
}

export function Step4TrainingData({ status }: { status: Status }) {
  const router = useRouter();
  const [advancing, setAdvancing] = React.useState(false);

  const advance = async () => {
    setAdvancing(true);
    // Bump onboardingStep → 4 server-side. We piggyback on the persona
    // POST in Step 3, so by the time we land here onboardingStep is 3
    // already; just navigate forward — Step 5 / Step 6 handle their
    // own onboardingStep bumps via their respective APIs.
    router.push(`/admin/onboard/${status.accountId}/step/5`);
  };

  return (
    <div className='space-y-5'>
      <div className='rounded-md bg-zinc-50 p-4 dark:bg-zinc-950'>
        <p className='text-sm font-medium'>Current training corpus</p>
        <p className='text-xs text-zinc-500'>
          {status.trainingCount} TrainingExample row(s) for this account.{' '}
          {status.trainingCount === 0
            ? 'Recommended: at least 10 conversations before activation, ideally 25+.'
            : 'Few-shot retrieval will draw examples from this set on every generation.'}
        </p>
      </div>

      <div className='rounded-md border border-amber-200 bg-amber-50 p-4 text-xs dark:border-amber-900/40 dark:bg-amber-900/20'>
        <p className='font-medium text-amber-800 dark:text-amber-300'>
          Phase 2 routes training uploads through the existing tenant page
        </p>
        <p className='mt-1 text-amber-700 dark:text-amber-400'>
          Sign in as the owner (or use Phase 3 impersonation when it ships) and
          upload at{' '}
          <code className='rounded bg-white/40 px-1 dark:bg-zinc-900/40'>
            /dashboard/settings/training
          </code>
          . Phase 3 will surface the uploader inline here so the super-admin can
          do it without impersonation.
        </p>
      </div>

      <div className='flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800'>
        <button
          type='button'
          onClick={() => router.refresh()}
          className='rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
        >
          ↻ Refresh count
        </button>
        <button
          type='button'
          onClick={advance}
          disabled={advancing}
          className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60'
        >
          {advancing ? 'Loading…' : 'Continue to test →'}
        </button>
      </div>
    </div>
  );
}
