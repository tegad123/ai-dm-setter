// Top-of-page summary cards on /admin. Six metrics in a row.

interface AdminSummary {
  totalAccounts: number;
  activeToday: number;
  leadsAllTime: number;
  aiMessagesToday: number;
  apiCostMonth: number;
  revenueMonth: number;
}

const cards: Array<{
  label: string;
  pick: (s: AdminSummary) => number;
  format?: (v: number) => string;
}> = [
  { label: 'Total accounts', pick: (s) => s.totalAccounts },
  { label: 'Active today', pick: (s) => s.activeToday },
  { label: 'Leads all time', pick: (s) => s.leadsAllTime },
  { label: 'AI messages today', pick: (s) => s.aiMessagesToday },
  {
    label: 'API cost (month)',
    pick: (s) => s.apiCostMonth,
    format: (v) =>
      v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  },
  {
    label: 'Revenue (month)',
    pick: (s) => s.revenueMonth,
    format: (v) =>
      v.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
  }
];

export function AdminSummaryCards({ summary }: { summary: AdminSummary }) {
  return (
    <div className='grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6'>
      {cards.map((c) => {
        const v = c.pick(summary);
        return (
          <div
            key={c.label}
            className='rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900'
          >
            <p className='text-xs tracking-wide text-zinc-500 uppercase'>
              {c.label}
            </p>
            <p className='mt-2 text-2xl font-semibold tabular-nums'>
              {c.format ? c.format(v) : v.toLocaleString('en-US')}
            </p>
          </div>
        );
      })}
    </div>
  );
}
