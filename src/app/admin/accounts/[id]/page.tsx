// /admin/accounts/[id] — Phase 1 sections A (info), B (health), C (stats).

import Link from 'next/link';
import { headers } from 'next/headers';
import { requireSuperAdmin } from '@/lib/auth-guard';
import { AccountInfoCard } from '@/features/admin/components/account-info-card';
import { HealthMonitor } from '@/features/admin/components/health-monitor';
import { ActivityStats } from '@/features/admin/components/activity-stats';

export const dynamic = 'force-dynamic';

interface AccountDetailResponse {
  sectionA: any; // typed in the components
  sectionB: any;
  sectionC: any;
}

async function fetchDetail(id: string): Promise<AccountDetailResponse> {
  const h = await headers();
  const cookie = h.get('cookie') ?? '';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  const host = h.get('host') ?? 'localhost:3000';
  const res = await fetch(`${proto}://${host}/api/admin/accounts/${id}`, {
    headers: { cookie },
    cache: 'no-store'
  });
  if (!res.ok) {
    throw new Error(`/api/admin/accounts/${id} ${res.status}`);
  }
  return res.json();
}

export default async function AdminAccountDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const data = await fetchDetail(id);

  return (
    <div className='space-y-6'>
      <div className='flex items-center justify-between'>
        <div>
          <Link
            href='/admin'
            className='text-xs text-zinc-500 hover:text-zinc-700'
          >
            ← All accounts
          </Link>
          <h2 className='mt-1 text-2xl font-semibold tracking-tight'>
            {data.sectionA.name}
          </h2>
          <p className='text-sm text-zinc-500'>{data.sectionA.slug}</p>
        </div>
      </div>

      <AccountInfoCard sectionA={data.sectionA} />
      <HealthMonitor sectionB={data.sectionB} />
      <ActivityStats sectionC={data.sectionC} />

      <div className='rounded-md border border-dashed border-zinc-300 p-4 text-xs text-zinc-500 dark:border-zinc-700'>
        Sections D (cost tracking) · E (recent issues) · F (account actions)
        ship in Phase 3.
      </div>
    </div>
  );
}
