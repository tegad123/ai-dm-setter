export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'closer' | 'setter' | 'read_only';
  avatar?: string;
  isActive: boolean;
  leadsHandled: number;
  callsBooked: number;
  closeRate: number;
  joinedAt: string;
}

export const teamMembers: TeamMember[] = [
  {
    id: '1',
    name: 'John Smith',
    email: 'john@example.com',
    role: 'admin',
    isActive: true,
    leadsHandled: 247,
    callsBooked: 38,
    closeRate: 45,
    joinedAt: '2024-01-01'
  },
  {
    id: '2',
    name: 'Alex Parker',
    email: 'anthony@example.com',
    role: 'closer',
    isActive: true,
    leadsHandled: 0,
    callsBooked: 0,
    closeRate: 62,
    joinedAt: '2024-02-15'
  },
  {
    id: '3',
    name: 'Jessica Adams',
    email: 'jessica@example.com',
    role: 'setter',
    isActive: true,
    leadsHandled: 45,
    callsBooked: 8,
    closeRate: 0,
    joinedAt: '2024-03-01'
  },
  {
    id: '4',
    name: 'Mike Torres',
    email: 'mike@example.com',
    role: 'setter',
    isActive: true,
    leadsHandled: 32,
    callsBooked: 5,
    closeRate: 0,
    joinedAt: '2024-03-05'
  },
  {
    id: '5',
    name: 'Rachel Kim',
    email: 'rachel@example.com',
    role: 'read_only',
    isActive: false,
    leadsHandled: 0,
    callsBooked: 0,
    closeRate: 0,
    joinedAt: '2024-03-10'
  }
];
