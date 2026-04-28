// Section B — health monitor. Renders the 8 checks + rollup pill.

import { HealthBadge } from './health-badge';

interface CheckRow {
  id: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  lastCheckedAt: string;
}
interface SectionB {
  rollup: string;
  lastCheckedAt: string;
  checks: CheckRow[];
}

const STATUS_LABEL: Record<string, string> = {
  PASS: 'Pass',
  WARN: 'Warn',
  FAIL: 'Fail'
};

const STATUS_CLASS: Record<string, string> = {
  PASS: 'text-emerald-600 dark:text-emerald-400',
  WARN: 'text-amber-600 dark:text-amber-400',
  FAIL: 'text-rose-600 dark:text-rose-400'
};

export function HealthMonitor({ sectionB }: { sectionB: SectionB }) {
  return (
    <section className='rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900'>
      <header className='mb-4 flex items-center justify-between'>
        <h3 className='text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
          Health monitor
        </h3>
        <div className='flex items-center gap-3'>
          <HealthBadge status={sectionB.rollup} />
          <span className='text-xs text-zinc-500'>
            Last run{' '}
            {new Date(sectionB.lastCheckedAt).toLocaleString('en-US', {
              dateStyle: 'medium',
              timeStyle: 'short'
            })}
          </span>
        </div>
      </header>
      <ul className='divide-y divide-zinc-100 dark:divide-zinc-800'>
        {sectionB.checks.map((c) => (
          <li
            key={c.id}
            className='flex items-start justify-between gap-4 py-3'
          >
            <div className='min-w-0 flex-1'>
              <p className='text-sm font-medium'>{c.label}</p>
              <p className='mt-0.5 text-xs break-words text-zinc-500'>
                {c.detail}
              </p>
            </div>
            <span
              className={
                'shrink-0 text-xs font-semibold ' +
                (STATUS_CLASS[c.status] ?? '')
              }
            >
              {STATUS_LABEL[c.status] ?? c.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
