'use client';

// Admin-only sidebar. Distinct from the tenant /dashboard sidebar so a
// SUPER_ADMIN never visually conflates the two surfaces. Phase 1 only
// the first two links are hot — others are visible-but-disabled to
// preview the eventual scope.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconLayoutDashboard,
  IconUserPlus,
  IconHeartbeat,
  IconCreditCard,
  IconSettings
} from '@tabler/icons-react';

const NAV_ITEMS: Array<{
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  enabled: boolean;
  phase?: string;
}> = [
  {
    label: 'Overview',
    href: '/admin',
    icon: IconLayoutDashboard,
    enabled: true
  },
  {
    label: 'Onboard New Client',
    href: '/admin/onboard',
    icon: IconUserPlus,
    enabled: false,
    phase: 'Phase 2'
  },
  {
    label: 'System Health',
    href: '/admin/health',
    icon: IconHeartbeat,
    enabled: false,
    phase: 'Phase 3'
  },
  {
    label: 'Billing',
    href: '/admin/billing',
    icon: IconCreditCard,
    enabled: false,
    phase: 'Phase 4'
  },
  {
    label: 'Settings',
    href: '/admin/settings',
    icon: IconSettings,
    enabled: false,
    phase: 'Phase 3'
  }
];

export function AdminSidebar() {
  const pathname = usePathname() || '';
  return (
    <aside className='w-64 shrink-0 border-r border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900'>
      <div className='mb-6 px-2'>
        <h1 className='text-sm font-semibold tracking-wide text-zinc-500 uppercase'>
          QualifyDMs Admin
        </h1>
        <p className='text-xs text-zinc-400'>Platform operator console</p>
      </div>
      <nav className='flex flex-col gap-1'>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            item.href === '/admin'
              ? pathname === '/admin'
              : pathname.startsWith(item.href);
          if (!item.enabled) {
            return (
              <div
                key={item.href}
                className='flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-zinc-400 dark:text-zinc-600'
                title={item.phase ? `Coming in ${item.phase}` : 'Disabled'}
              >
                <Icon className='h-4 w-4' />
                <span className='flex-1'>{item.label}</span>
                <span className='text-[10px] tracking-wide text-zinc-400 uppercase'>
                  {item.phase}
                </span>
              </div>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ' +
                (active
                  ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50'
                  : 'text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800')
              }
            >
              <Icon className='h-4 w-4' />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <div className='mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800'>
        <Link
          href='/dashboard'
          className='block rounded-md px-3 py-2 text-xs text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800'
        >
          ← Back to tenant dashboard
        </Link>
      </div>
    </aside>
  );
}
