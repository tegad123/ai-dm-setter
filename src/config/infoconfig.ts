import type { InfobarContent } from '@/components/ui/infobar';

export const teamInfoContent: InfobarContent = {
  title: 'Team Management',
  sections: [
    {
      title: 'Overview',
      description:
        'Manage your team members, roles, and permissions. Assign roles to control what each team member can access.',
      links: []
    },
    {
      title: 'Roles',
      description:
        'Admin: Full access. Closer: View booked calls, update close status. Setter: View conversations, send messages, tag leads. Read Only: View dashboard and analytics only.',
      links: []
    }
  ]
};
