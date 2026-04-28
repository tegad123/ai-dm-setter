// /admin — accounts overview. Phase 1 super-admin home screen.
// Server component fetches once + renders client-side filter table.

import Link from 'next/link';
import { requireSuperAdmin } from '@/lib/auth-guard';
import { headers } from 'next/headers';
import { AccountsTable } from '@/features/admin/components/accounts-table';
import { AdminSummaryCards } from '@/features/admin/components/admin-summary-cards';

export const dynamic = 'force-dynamic';

interface AdminAccountRow {
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
interface AdminSummary {
  totalAccounts: number;
  activeToday: number;
  leadsAllTime: number;
  aiMessagesToday: number;
  apiCostMonth: number;
  revenueMonth: number;
}

async function fetchAccounts(): Promise<{
  accounts: AdminAccountRow[];
  summary: AdminSummary;
}> {
  // Forward incoming cookies so requireSuperAdmin sees the same Clerk
  // session that the page render used.
  const h = await headers();
  const cookie = h.get('cookie') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  const res = await fetch(`${proto}://${host}/api/admin/accounts`, {
    headers: { cookie },
    cache: 'no-store'
  });
  if (!res.ok) {
    throw new Error(`/api/admin/accounts ${res.status}`);
  }
  return res.json();
}

export default async function AdminAccountsPage() {
  await requireSuperAdmin();
  const { accounts, summary } = await fetchAccounts();
  return (
    <div className='space-y-6'>
      <div className='flex items-end justify-between'>
        <div>
          <h2 className='text-2xl font-semibold tracking-tight'>
            Accounts overview
          </h2>
          <p className='text-sm text-zinc-500'>
            All tenant accounts on the platform. Health, activity, and economics
            at a glance.
          </p>
        </div>
        <Link
          href='/admin'
          className='text-xs text-zinc-400 hover:text-zinc-600'
        >
          Last refreshed {new Date().toLocaleTimeString()}
        </Link>
      </div>
      <AdminSummaryCards summary={summary} />
      <AccountsTable accounts={accounts} />
    </div>
  );
}
