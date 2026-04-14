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
    title: 'Content',
    url: '/dashboard/content',
    icon: 'analytics',
    isActive: false,
    shortcut: ['n', 'n'],
    items: []
  },
  {
    title: 'Voice Notes',
    url: '/dashboard/voice-notes',
    icon: 'voiceNotes',
    isActive: true,
    shortcut: ['v', 'n'],
    items: [
      {
        title: 'Library',
        url: '/dashboard/voice-notes',
        icon: 'voiceNotes'
      },
      {
        title: 'Timing',
        url: '/dashboard/voice-notes/timing',
        icon: 'settings'
      }
    ]
  },
  {
    title: 'Analytics',
    url: '/dashboard/analytics',
    icon: 'analytics',
    isActive: true,
    shortcut: ['a', 'a'],
    items: [
      {
        title: 'Overview',
        url: '/dashboard/analytics',
        icon: 'analytics'
      },
      {
        title: 'Team Performance',
        url: '/dashboard/analytics/team',
        icon: 'teams'
      }
    ]
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
        title: 'Sales Scripts',
        url: '/dashboard/settings/persona',
        icon: 'settings'
      },
      {
        title: 'Training Data',
        url: '/dashboard/settings/training',
        icon: 'settings'
      },
      {
        title: 'Tags',
        url: '/dashboard/settings/tags',
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
