// Reusable shell for /admin/onboard step pages. Renders a 6-dot step
// indicator, title, body, and a Back / Skip / Save & Continue button row.

import * as React from 'react';
import Link from 'next/link';

const STEPS: Array<{ n: number; label: string }> = [
  { n: 1, label: 'Create Account' },
  { n: 2, label: 'Connect Meta' },
  { n: 3, label: 'Configure Persona' },
  { n: 4, label: 'Training Data' },
  { n: 5, label: 'Test' },
  { n: 6, label: 'Activate' }
];

export function OnboardingWizardShell({
  accountId,
  step,
  title,
  description,
  children
}: {
  accountId?: string;
  step: number;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className='mx-auto max-w-3xl space-y-6'>
      <header>
        <Link
          href='/admin/onboard'
          className='text-xs text-zinc-500 hover:text-zinc-700'
        >
          ← Onboarding
        </Link>
        <h2 className='mt-1 text-2xl font-semibold tracking-tight'>{title}</h2>
        {description ? (
          <p className='mt-1 text-sm text-zinc-500'>{description}</p>
        ) : null}
      </header>

      <ol className='flex items-center justify-between gap-2'>
        {STEPS.map((s) => {
          const isComplete = step > s.n;
          const isCurrent = step === s.n;
          return (
            <li
              key={s.n}
              className='flex flex-1 flex-col items-center gap-1 text-center'
            >
              <span
                className={
                  'flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold ' +
                  (isComplete
                    ? 'bg-emerald-500 text-white'
                    : isCurrent
                      ? 'bg-blue-600 text-white'
                      : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400')
                }
              >
                {isComplete ? '✓' : s.n}
              </span>
              <span
                className={
                  'text-[10px] tracking-wide uppercase ' +
                  (isCurrent
                    ? 'font-semibold text-zinc-700 dark:text-zinc-200'
                    : 'text-zinc-500')
                }
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>

      <section className='rounded-md border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900'>
        {children}
      </section>

      {accountId ? (
        <p className='text-center text-xs text-zinc-500'>
          Account ID:{' '}
          <code className='rounded bg-zinc-100 px-1 py-0.5 dark:bg-zinc-800'>
            {accountId}
          </code>
        </p>
      ) : null}
    </div>
  );
}
