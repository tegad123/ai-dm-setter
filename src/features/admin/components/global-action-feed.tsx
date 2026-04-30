import Link from 'next/link';

interface GlobalActionItem {
  id: string;
  accountId: string;
  accountName: string;
  conversationId: string | null;
  leadName: string;
  label: string;
  severity: 'RED' | 'AMBER';
  occurredAt: string;
  href: string;
}

const SEVERITY_CLASS: Record<GlobalActionItem['severity'], string> = {
  RED: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  AMBER: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300'
};

function relativeTime(iso: string): string {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '';
  const diffMs = target - Date.now();
  const absMs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.round(absMs / 60_000));
  if (minutes < 60) return diffMs > 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return diffMs > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
}

export function GlobalActionFeed({ items }: { items: GlobalActionItem[] }) {
  return (
    <section className='rounded-md border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900'>
      <header className='mb-4 flex items-center justify-between gap-3'>
        <div>
          <h3 className='text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
            Global action required
          </h3>
          <p className='text-xs text-zinc-500'>
            All client accounts in one queue. Handle red first, then amber.
          </p>
        </div>
        <span className='rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600 tabular-nums dark:bg-zinc-800 dark:text-zinc-300'>
          {items.length}
        </span>
      </header>
      {items.length === 0 ? (
        <p className='text-sm text-zinc-500'>
          No action required items across client accounts.
        </p>
      ) : (
        <ul className='divide-y divide-zinc-100 dark:divide-zinc-800'>
          {items.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className='flex items-center gap-3 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-950'
              >
                <span
                  className={
                    'rounded px-2 py-0.5 text-[11px] font-semibold ' +
                    SEVERITY_CLASS[item.severity]
                  }
                >
                  {item.severity}
                </span>
                <span className='min-w-0 flex-1 truncate'>
                  <span className='font-medium'>[{item.accountName}]</span>{' '}
                  {item.leadName} - {item.label}
                </span>
                <span className='shrink-0 text-xs text-zinc-500'>
                  {relativeTime(item.occurredAt)}
                </span>
                <span className='text-zinc-400'>→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
