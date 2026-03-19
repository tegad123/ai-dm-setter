export const notifications = [
  {
    id: '1',
    type: 'call_booked' as const,
    title: 'New Call Booked',
    body: 'Marcus J. booked for Tomorrow 2:00 PM',
    time: '5m ago',
    read: false
  },
  {
    id: '2',
    type: 'hot_lead' as const,
    title: 'Hot Lead Alert',
    body: 'Sarah M. is highly engaged',
    time: '18m ago',
    read: false
  },
  {
    id: '3',
    type: 'call_booked' as const,
    title: 'New Call Booked',
    body: 'David K. booked for Wed 10:00 AM',
    time: '1h ago',
    read: false
  },
  {
    id: '4',
    type: 'human_override' as const,
    title: 'Human Override Needed',
    body: 'Jaylen W. needs attention',
    time: '2h ago',
    read: true
  },
  {
    id: '5',
    type: 'daily_summary' as const,
    title: 'Daily Summary',
    body: '12 leads contacted, 3 calls booked',
    time: '6h ago',
    read: true
  },
  {
    id: '6',
    type: 'hot_lead' as const,
    title: 'Hot Lead Alert',
    body: 'Alex R. responding fast',
    time: '8h ago',
    read: true
  }
];
