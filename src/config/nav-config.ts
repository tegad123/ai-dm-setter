import { NavItem } from '@/types';

export const navItems: NavItem[] = [
  {
    title: 'Dashboard',
    url: '/dashboard/overview',
    icon: 'dashboard',
    isActive: false,
    shortcut: ['d', 'd'],
    items: []
  },
  {
    title: 'Leads',
    url: '/dashboard/leads',
    icon: 'leads',
    isActive: false,
    shortcut: ['l', 'l'],
    items: []
  },
  {
    title: 'Conversations',
    url: '/dashboard/conversations',
    icon: 'conversations',
    isActive: false,
    shortcut: ['c', 'c'],
    items: []
  },
  {
    title: 'Analytics',
    url: '/dashboard/analytics',
    icon: 'analytics',
    isActive: false,
    shortcut: ['a', 'a'],
    items: []
  },
  {
    title: 'Team',
    url: '/dashboard/team',
    icon: 'teams',
    isActive: false,
    items: []
  },
  {
    title: 'Settings',
    url: '#',
    icon: 'settings',
    isActive: true,
    items: [
      {
        title: 'Profile',
        url: '/dashboard/profile',
        icon: 'profile',
        shortcut: ['p', 'p']
      },
      {
        title: 'AI Persona',
        url: '/dashboard/settings/persona',
        icon: 'settings'
      },
      {
        title: 'Training Data',
        url: '/dashboard/settings/training',
        icon: 'settings'
      },
      {
        title: 'Integrations',
        url: '/dashboard/settings/integrations',
        icon: 'settings'
      },
      {
        title: 'Account',
        url: '/dashboard/settings/account',
        icon: 'settings'
      },
      {
        title: 'Notifications',
        url: '/dashboard/settings/notifications',
        icon: 'notifications'
      }
    ]
  }
];
