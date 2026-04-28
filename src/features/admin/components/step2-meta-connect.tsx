'use client';

// Step 2 — Meta connect status. Phase 2 fidelity: status display + skip.
// Real OAuth happens tenant-side via /dashboard/settings/integrations,
// so the wizard can't drive it directly without impersonation
// (Phase 3). The super-admin's job here is to:
//   • Send the owner a sign-in invite (if no Clerk session yet)
//   • Refresh until both IG + FB show ✓
//   • Skip + circle back later

import * as React from 'react';
import { useRouter } from 'next/navigation';

interface Status {
  accountId: string;
  meta: { instagramConnected: boolean; facebookConnected: boolean };
  owner: { email: string; name: string; isActive: boolean } | null;
}

export function Step2MetaConnect({ status }: { status: Status }) {
  const router = useRouter();
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      router.refresh();
    } finally {
      setTimeout(() => setRefreshing(false), 500);
    }
  };

  const advance = () =>
    router.push(`/admin/onboard/${status.accountId}/step/3`);

  return (
    <div className='space-y-5'>
      <div className='rounded-md bg-zinc-50 p-4 dark:bg-zinc-950'>
        <p className='text-sm font-medium'>Owner</p>
        <p className='text-xs text-zinc-500'>
          {status.owner ? (
            <>
              {status.owner.name} · {status.owner.email}{' '}
              {status.owner.isActive ? (
                <span className='text-emerald-600'>· Signed in</span>
              ) : (
                <span className='text-amber-600'>
                  · Not signed in yet (Clerk invite pending)
                </span>
              )}
            </>
          ) : (
            '—'
          )}
        </p>
      </div>

      <ConnectRow
        label='Instagram Business Account'
        connected={status.meta.instagramConnected}
      />
      <ConnectRow
        label='Facebook Page (Meta)'
        connected={status.meta.facebookConnected}
      />

      <div className='rounded-md border border-amber-200 bg-amber-50 p-4 text-xs dark:border-amber-900/40 dark:bg-amber-900/20'>
        <p className='font-medium text-amber-800 dark:text-amber-300'>
          Owner action required
        </p>
        <p className='mt-1 text-amber-700 dark:text-amber-400'>
          Meta OAuth must be completed by the account owner. Send them the
          dashboard URL — once they sign in (Clerk) and connect IG + FB at{' '}
          <code className='rounded bg-white/40 px-1 dark:bg-zinc-900/40'>
            /dashboard/settings/integrations
          </code>
          , refresh this page. Phase 3 will support super-admin-driven OAuth via
          impersonation.
        </p>
      </div>

      <div className='flex items-center justify-between border-t border-zinc-100 pt-4 dark:border-zinc-800'>
        <button
          type='button'
          onClick={refresh}
          className='rounded-md border border-zinc-200 px-3 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh status'}
        </button>
        <div className='flex gap-2'>
          <button
            type='button'
            onClick={advance}
            className='rounded-md border border-zinc-200 px-4 py-2 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
          >
            Skip for now
          </button>
          <button
            type='button'
            onClick={advance}
            disabled={
              !status.meta.instagramConnected && !status.meta.facebookConnected
            }
            className='rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60'
          >
            Continue →
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectRow({
  label,
  connected
}: {
  label: string;
  connected: boolean;
}) {
  return (
    <div className='flex items-center justify-between rounded-md border border-zinc-200 px-4 py-3 dark:border-zinc-800'>
      <span className='text-sm font-medium'>{label}</span>
      {connected ? (
        <span className='inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'>
          <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' /> Connected
        </span>
      ) : (
        <span className='inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'>
          <span className='h-1.5 w-1.5 rounded-full bg-zinc-400' /> Pending
        </span>
      )}
    </div>
  );
}
