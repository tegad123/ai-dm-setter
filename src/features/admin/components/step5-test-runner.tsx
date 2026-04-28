'use client';

// Step 5 — test runner. Calls /api/admin/onboard/:id/test which
// invokes the real generateReply pipeline against 3 scenarios.

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Status {
  accountId: string;
}

interface ScenarioResult {
  id: string;
  label: string;
  leadMessage: string;
  expectationDescription: string;
  passed: boolean;
  reply: string;
  stage: string | null;
  error: string | null;
}

export function Step5TestRunner({ status }: { status: Status }) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<ScenarioResult[] | null>(null);
  const [allPassed, setAllPassed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResults(null);
    setAllPassed(false);
    try {
      const res = await fetch(`/api/admin/onboard/${status.accountId}/test`, {
        method: 'POST'
      });
      const body = (await res.json().catch(() => ({}))) as {
        results?: ScenarioResult[];
        allPassed?: boolean;
        error?: string;
      };
      if (!res.ok) throw new Error(body.error ?? `Failed (${res.status})`);
      setResults(body.results ?? []);
      setAllPassed(body.allPassed ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const advance = () =>
    router.push(`/admin/onboard/${status.accountId}/step/6`);

  return (
    <div className='space-y-5'>
      <div className='rounded-md bg-zinc-50 p-4 dark:bg-zinc-950'>
        <p className='text-sm font-medium'>What this runs</p>
        <p className='text-xs text-zinc-500'>
          Three synthetic LEAD messages are sent through the real generateReply
          pipeline against this account&apos;s persona — so the reply, retry
          loop, and quality gate all execute exactly as in production. Cost: ~3
          LLM calls per run.
        </p>
      </div>

      {!results ? (
        <button
          type='button'
          onClick={run}
          disabled={running}
          className='w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60'
        >
          {running ? 'Running tests… (~30-60s)' : 'Run 3 test scenarios'}
        </button>
      ) : (
        <div className='space-y-3'>
          {results.map((r) => (
            <div
              key={r.id}
              className={
                'rounded-md border p-4 ' +
                (r.error
                  ? 'border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-900/20'
                  : r.passed
                    ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900/40 dark:bg-emerald-900/20'
                    : 'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/20')
              }
            >
              <div className='flex items-center justify-between gap-2'>
                <p className='text-sm font-medium'>{r.label}</p>
                <span
                  className={
                    'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ' +
                    (r.error
                      ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400'
                      : r.passed
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400')
                  }
                >
                  {r.error ? 'ERROR' : r.passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <p className='mt-2 text-xs text-zinc-600 dark:text-zinc-400'>
                Lead: <em>&ldquo;{r.leadMessage}&rdquo;</em>
              </p>
              <p className='mt-1 text-xs text-zinc-500'>
                Expected: {r.expectationDescription}
              </p>
              {r.error ? (
                <p className='mt-2 text-xs text-rose-700 dark:text-rose-400'>
                  Error: {r.error}
                </p>
              ) : (
                <p className='mt-2 rounded bg-white p-2 text-xs whitespace-pre-wrap dark:bg-zinc-900'>
                  AI{r.stage ? ` (${r.stage})` : ''}: {r.reply}
                </p>
              )}
            </div>
          ))}

          <div className='flex items-center justify-between gap-2'>
            <button
              type='button'
              onClick={run}
              disabled={running}
              className='rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed dark:border-zinc-700 dark:hover:bg-zinc-800'
            >
              ↻ Re-run
            </button>
            {allPassed ? (
              <button
                type='button'
                onClick={advance}
                className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700'
              >
                All passed — continue →
              </button>
            ) : (
              <button
                type='button'
                onClick={advance}
                className='rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 shadow-sm hover:bg-amber-100 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300'
                title='Override — proceed even though not all tests passed'
              >
                Override + continue →
              </button>
            )}
          </div>
        </div>
      )}

      {error ? (
        <p className='rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-400'>
          {error}
        </p>
      ) : null}
    </div>
  );
}
