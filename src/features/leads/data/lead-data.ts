import { LeadStatus } from '@/features/shared/lead-status-badge';

export interface Lead {
  id: string;
  username: string;
  fullName: string;
  platform: 'instagram' | 'facebook';
  status: LeadStatus;
  qualityScore: number;
  triggerType: 'comment' | 'direct_dm';
  triggerPostUrl?: string;
  bookedAt?: string;
  bookingSlot?: string;
  showedUp?: boolean;
  closed?: boolean;
  revenue?: number;
  createdAt: string;
  lastMessageAt: string;
}

export const leads: Lead[] = [
  {
    id: '1',
    username: 'marcus_johnson',
    fullName: 'Marcus Johnson',
    platform: 'instagram',
    status: 'booked',
    qualityScore: 92,
    triggerType: 'comment',
    bookedAt: '2024-03-18T14:00:00Z',
    bookingSlot: 'Tomorrow 2:00 PM',
    createdAt: '2024-03-15T10:00:00Z',
    lastMessageAt: '2024-03-18T09:30:00Z'
  },
  {
    id: '2',
    username: 'sarah_mitchell',
    fullName: 'Sarah Mitchell',
    platform: 'instagram',
    status: 'hot_lead',
    qualityScore: 88,
    triggerType: 'direct_dm',
    createdAt: '2024-03-16T08:00:00Z',
    lastMessageAt: '2024-03-18T10:15:00Z'
  },
  {
    id: '3',
    username: 'david.kim',
    fullName: 'David Kim',
    platform: 'facebook',
    status: 'booked',
    qualityScore: 85,
    triggerType: 'comment',
    bookedAt: '2024-03-20T10:00:00Z',
    bookingSlot: 'Wed 10:00 AM',
    createdAt: '2024-03-14T12:00:00Z',
    lastMessageAt: '2024-03-18T08:00:00Z'
  },
  {
    id: '4',
    username: 'jaylen_williams',
    fullName: 'Jaylen Williams',
    platform: 'instagram',
    status: 'trust_objection',
    qualityScore: 65,
    triggerType: 'comment',
    createdAt: '2024-03-13T15:00:00Z',
    lastMessageAt: '2024-03-17T22:00:00Z'
  },
  {
    id: '5',
    username: 'alex.rodriguez',
    fullName: 'Alex Rodriguez',
    platform: 'instagram',
    status: 'in_qualification',
    qualityScore: 72,
    triggerType: 'direct_dm',
    createdAt: '2024-03-17T09:00:00Z',
    lastMessageAt: '2024-03-18T11:00:00Z'
  },
  {
    id: '6',
    username: 'nina_patel',
    fullName: 'Nina Patel',
    platform: 'facebook',
    status: 'qualified',
    qualityScore: 80,
    triggerType: 'comment',
    createdAt: '2024-03-12T11:00:00Z',
    lastMessageAt: '2024-03-18T07:00:00Z'
  },
  {
    id: '7',
    username: 'tyler_brooks',
    fullName: 'Tyler Brooks',
    platform: 'instagram',
    status: 'showed_up',
    qualityScore: 90,
    triggerType: 'direct_dm',
    bookedAt: '2024-03-16T14:00:00Z',
    showedUp: true,
    createdAt: '2024-03-10T09:00:00Z',
    lastMessageAt: '2024-03-16T15:30:00Z'
  },
  {
    id: '8',
    username: 'emma.chen',
    fullName: 'Emma Chen',
    platform: 'instagram',
    status: 'closed',
    qualityScore: 95,
    triggerType: 'comment',
    bookedAt: '2024-03-14T11:00:00Z',
    showedUp: true,
    closed: true,
    revenue: 997,
    createdAt: '2024-03-08T10:00:00Z',
    lastMessageAt: '2024-03-14T12:00:00Z'
  },
  {
    id: '9',
    username: 'jordan.lee',
    fullName: 'Jordan Lee',
    platform: 'facebook',
    status: 'money_objection',
    qualityScore: 55,
    triggerType: 'direct_dm',
    createdAt: '2024-03-15T14:00:00Z',
    lastMessageAt: '2024-03-17T16:00:00Z'
  },
  {
    id: '10',
    username: 'maya_thompson',
    fullName: 'Maya Thompson',
    platform: 'instagram',
    status: 'new_lead',
    qualityScore: 30,
    triggerType: 'comment',
    createdAt: '2024-03-18T06:00:00Z',
    lastMessageAt: '2024-03-18T06:05:00Z'
  },
  {
    id: '11',
    username: 'chris.walker',
    fullName: 'Chris Walker',
    platform: 'instagram',
    status: 'ghosted',
    qualityScore: 42,
    triggerType: 'direct_dm',
    createdAt: '2024-03-11T13:00:00Z',
    lastMessageAt: '2024-03-14T09:00:00Z'
  },
  {
    id: '12',
    username: 'lisa.nguyen',
    fullName: 'Lisa Nguyen',
    platform: 'facebook',
    status: 'no_show',
    qualityScore: 60,
    triggerType: 'comment',
    bookedAt: '2024-03-17T09:00:00Z',
    showedUp: false,
    createdAt: '2024-03-09T08:00:00Z',
    lastMessageAt: '2024-03-17T10:00:00Z'
  },
  {
    id: '13',
    username: 'ryan_garcia',
    fullName: 'Ryan Garcia',
    platform: 'instagram',
    status: 'serious_not_ready',
    qualityScore: 68,
    triggerType: 'direct_dm',
    createdAt: '2024-03-13T10:00:00Z',
    lastMessageAt: '2024-03-17T14:00:00Z'
  },
  {
    id: '14',
    username: 'ashley.moore',
    fullName: 'Ashley Moore',
    platform: 'facebook',
    status: 'unqualified',
    qualityScore: 15,
    triggerType: 'comment',
    createdAt: '2024-03-16T11:00:00Z',
    lastMessageAt: '2024-03-16T12:00:00Z'
  },
  {
    id: '15',
    username: 'darius_brown',
    fullName: 'Darius Brown',
    platform: 'instagram',
    status: 'in_qualification',
    qualityScore: 75,
    triggerType: 'comment',
    createdAt: '2024-03-17T15:00:00Z',
    lastMessageAt: '2024-03-18T09:00:00Z'
  },
  {
    id: '16',
    username: 'kayla.james',
    fullName: 'Kayla James',
    platform: 'instagram',
    status: 'hot_lead',
    qualityScore: 86,
    triggerType: 'direct_dm',
    createdAt: '2024-03-16T16:00:00Z',
    lastMessageAt: '2024-03-18T10:30:00Z'
  },
  {
    id: '17',
    username: 'brandon_clark',
    fullName: 'Brandon Clark',
    platform: 'facebook',
    status: 'closed',
    qualityScore: 93,
    triggerType: 'comment',
    bookedAt: '2024-03-13T15:00:00Z',
    showedUp: true,
    closed: true,
    revenue: 1997,
    createdAt: '2024-03-06T09:00:00Z',
    lastMessageAt: '2024-03-13T16:30:00Z'
  },
  {
    id: '18',
    username: 'tiffany.young',
    fullName: 'Tiffany Young',
    platform: 'instagram',
    status: 'qualified',
    qualityScore: 82,
    triggerType: 'direct_dm',
    createdAt: '2024-03-15T12:00:00Z',
    lastMessageAt: '2024-03-18T08:30:00Z'
  },
  {
    id: '19',
    username: 'mike.davis',
    fullName: 'Mike Davis',
    platform: 'instagram',
    status: 'new_lead',
    qualityScore: 25,
    triggerType: 'comment',
    createdAt: '2024-03-18T07:00:00Z',
    lastMessageAt: '2024-03-18T07:10:00Z'
  },
  {
    id: '20',
    username: 'olivia_scott',
    fullName: 'Olivia Scott',
    platform: 'facebook',
    status: 'in_qualification',
    qualityScore: 70,
    triggerType: 'direct_dm',
    createdAt: '2024-03-17T11:00:00Z',
    lastMessageAt: '2024-03-18T09:45:00Z'
  }
];
