'use client';

// Accounts table for /admin. Client component so the filter pills and
// sort can run client-side without a round trip. Phase 1 actions:
// only [View] is wired (links to /admin/accounts/[id]). [Pause AI] +
// [Edit Plan] are placeholders pending Phase 3 + 4.

import * as React from 'react';
import Link from 'next/link';
import { HealthBadge } from './health-badge';

export interface AdminAccountRow {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  ownerName: string | null;
  plan: string;
  planStatus: string;
  health: string;
  lastHealthCheck: string | null;
  leadsTotal: number;
  leadsToday: number;
  aiMessagesToday: number;
  callsBookedMonth: number;
  revenueMonth: number;
  monthlyApiCostUsd: number;
  lastActive: string | null;
  createdAt: string;
}

type Filter = 'ALL' | 'HEALTHY' | 'WARNING' | 'CRITICAL';
type Sort = 'last_active' | 'leads_today' | 'health';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'HEALTHY', label: 'Healthy' },
  { key: 'WARNING', label: 'Warning' },
  { key: 'CRITICAL', label: 'Critical' }
];

const HEALTH_RANK: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  UNKNOWN: 2,
  HEALTHY: 3
};

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function fmtCurrency(v: number) {
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2
  });
}

export function AccountsTable({ accounts }: { accounts: AdminAccountRow[] }) {
  const [filter, setFilter] = React.useState<Filter>('ALL');
  const [sort, setSort] = React.useState<Sort>('last_active');

  const filtered = React.useMemo(() => {
    let rows = accounts;
    if (filter !== 'ALL') {
      rows = rows.filter((r) => r.health === filter);
    }
    rows = [...rows].sort((a, b) => {
      if (sort === 'leads_today') return b.leadsToday - a.leadsToday;
      if (sort === 'health') {
        return (HEALTH_RANK[a.health] ?? 9) - (HEALTH_RANK[b.health] ?? 9);
      }
      // last_active: newer first; nulls last.
      const ta = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const tb = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return tb - ta;
    });
    return rows;
  }, [accounts, filter, sort]);

  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex gap-1 rounded-md bg-zinc-100 p-1 dark:bg-zinc-800'>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                'rounded px-3 py-1 text-xs ' +
                (filter === f.key
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-50'
                  : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className='ml-auto flex items-center gap-2 text-xs text-zinc-500'>
          Sort by
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className='rounded border border-zinc-200 bg-white px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900'
          >
            <option value='last_active'>Last active</option>
            <option value='leads_today'>Leads today</option>
            <option value='health'>Health (worst first)</option>
          </select>
        </label>
      </div>

      <div className='overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800'>
        <table className='w-full min-w-[1100px] text-sm'>
          <thead className='border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900'>
            <tr className='text-left text-xs tracking-wide text-zinc-500 uppercase'>
              <th className='px-3 py-2'>Account</th>
              <th className='px-3 py-2'>Owner</th>
              <th className='px-3 py-2'>Plan</th>
              <th className='px-3 py-2'>Status</th>
              <th className='px-3 py-2 text-right'>Leads</th>
              <th className='px-3 py-2 text-right'>Today</th>
              <th className='px-3 py-2 text-right'>AI msgs today</th>
              <th className='px-3 py-2 text-right'>Calls (mo)</th>
              <th className='px-3 py-2 text-right'>Revenue (mo)</th>
              <th className='px-3 py-2'>Last active</th>
              <th className='px-3 py-2'>Health</th>
              <th className='px-3 py-2'>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={12}
                  className='px-3 py-8 text-center text-zinc-500'
                >
                  No accounts match the current filter.
                </td>
              </tr>
            ) : (
              filtered.map((row) => (
                <tr
                  key={row.id}
                  className='border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900'
                >
                  <td className='px-3 py-2'>
                    <p className='font-medium'>{row.name}</p>
                    <p className='text-xs text-zinc-500'>{row.slug}</p>
                  </td>
                  <td className='px-3 py-2'>
                    <p>{row.ownerName ?? '—'}</p>
                    <p className='text-xs text-zinc-500'>
                      {row.ownerEmail ?? '—'}
                    </p>
                  </td>
                  <td className='px-3 py-2 text-xs'>{row.plan}</td>
                  <td className='px-3 py-2 text-xs'>{row.planStatus}</td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {row.leadsTotal.toLocaleString('en-US')}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {row.leadsToday.toLocaleString('en-US')}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {row.aiMessagesToday.toLocaleString('en-US')}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {row.callsBookedMonth.toLocaleString('en-US')}
                  </td>
                  <td className='px-3 py-2 text-right tabular-nums'>
                    {fmtCurrency(row.revenueMonth)}
                  </td>
                  <td className='px-3 py-2 text-xs text-zinc-500'>
                    {fmtDate(row.lastActive)}
                  </td>
                  <td className='px-3 py-2'>
                    <HealthBadge status={row.health} />
                  </td>
                  <td className='px-3 py-2'>
                    <div className='flex gap-1'>
                      <Link
                        href={`/admin/accounts/${row.id}`}
                        className='rounded border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
                      >
                        View
                      </Link>
                      <button
                        disabled
                        className='cursor-not-allowed rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-400 dark:border-zinc-800'
                        title='Phase 3'
                      >
                        Pause AI
                      </button>
                      <button
                        disabled
                        className='cursor-not-allowed rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-400 dark:border-zinc-800'
                        title='Phase 4'
                      >
                        Edit plan
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
