// Color-coded health pill used in the accounts table + account detail.

const STYLES: Record<string, string> = {
  HEALTHY:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  WARNING:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  CRITICAL: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
  UNKNOWN: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
};

const DOT: Record<string, string> = {
  HEALTHY: 'bg-emerald-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-rose-500',
  UNKNOWN: 'bg-zinc-400'
};

export function HealthBadge({ status }: { status: string }) {
  const cls = STYLES[status] ?? STYLES.UNKNOWN;
  const dot = DOT[status] ?? DOT.UNKNOWN;
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ' +
        cls
      }
    >
      <span className={'h-1.5 w-1.5 rounded-full ' + dot} />
      {status}
    </span>
  );
}
