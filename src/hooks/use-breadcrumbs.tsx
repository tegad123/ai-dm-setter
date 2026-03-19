'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

type BreadcrumbItem = {
  title: string;
  link: string;
};

const routeMapping: Record<string, BreadcrumbItem[]> = {
  '/dashboard': [{ title: 'Dashboard', link: '/dashboard' }],
  '/dashboard/overview': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Overview', link: '/dashboard/overview' }
  ],
  '/dashboard/leads': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Leads', link: '/dashboard/leads' }
  ],
  '/dashboard/conversations': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Conversations', link: '/dashboard/conversations' }
  ],
  '/dashboard/analytics': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Analytics', link: '/dashboard/analytics' }
  ],
  '/dashboard/team': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Team', link: '/dashboard/team' }
  ],
  '/dashboard/profile': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Profile', link: '/dashboard/profile' }
  ],
  '/dashboard/settings/notifications': [
    { title: 'Dashboard', link: '/dashboard' },
    { title: 'Settings', link: '/dashboard/settings/notifications' },
    { title: 'Notifications', link: '/dashboard/settings/notifications' }
  ]
};

export function useBreadcrumbs() {
  const pathname = usePathname();

  const breadcrumbs = useMemo(() => {
    if (routeMapping[pathname]) {
      return routeMapping[pathname];
    }

    const segments = pathname.split('/').filter(Boolean);
    return segments.map((segment, index) => {
      const path = `/${segments.slice(0, index + 1).join('/')}`;
      return {
        title: segment.charAt(0).toUpperCase() + segment.slice(1),
        link: path
      };
    });
  }, [pathname]);

  return breadcrumbs;
}
