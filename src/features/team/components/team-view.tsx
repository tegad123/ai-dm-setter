'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { IconPlus } from '@tabler/icons-react';
import { useTeam } from '@/hooks/use-api';
import { InviteMemberDialog } from './invite-member-dialog';

const roleColors: Record<string, string> = {
  admin:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  closer:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  setter:
    'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  read_only:
    'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800'
};

const roleLabels: Record<string, string> = {
  admin: 'Admin',
  closer: 'Closer',
  setter: 'Setter',
  read_only: 'Read Only'
};

export function TeamView() {
  const { members, loading, error, refetch } = useTeam();

  if (loading) {
    return (
      <div className='space-y-4'>
        <div className='flex justify-end'>
          <Button disabled>
            <IconPlus className='mr-2 h-4 w-4' />
            Invite Member
          </Button>
        </div>
        <div className='text-muted-foreground py-8 text-center text-sm'>
          Loading team members...
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <div className='flex justify-end'>
        <InviteMemberDialog
          onInvited={refetch}
          trigger={
            <Button>
              <IconPlus className='mr-2 h-4 w-4' />
              Invite Member
            </Button>
          }
        />
      </div>
      <div className='rounded-md border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Leads Handled</TableHead>
              <TableHead>Calls Booked</TableHead>
              <TableHead>Close Rate</TableHead>
              <TableHead className='text-right'>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className='text-muted-foreground py-8 text-center'
                >
                  {error
                    ? 'Failed to load team members.'
                    : 'No team members found.'}
                </TableCell>
              </TableRow>
            ) : (
              members.map((member) => {
                const initials = member.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('');
                // Normalize role to lowercase for styling lookup
                const roleKey = member.role.toLowerCase();
                return (
                  <TableRow key={member.id}>
                    <TableCell>
                      <div className='flex items-center gap-3'>
                        <Avatar className='h-8 w-8'>
                          <AvatarFallback className='bg-primary/10 text-primary text-xs'>
                            {initials}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className='font-medium'>{member.name}</p>
                          <p className='text-muted-foreground text-xs'>
                            {member.email}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant='outline'
                        className={roleColors[roleKey] || ''}
                      >
                        {roleLabels[roleKey] || member.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1.5'>
                        <div
                          className={`h-2 w-2 rounded-full ${member.isActive ? 'bg-green-500' : 'bg-gray-400'}`}
                        />
                        <span className='text-xs'>
                          {member.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>{member.leadsHandled}</TableCell>
                    <TableCell>{member.callsBooked}</TableCell>
                    <TableCell>
                      {member.closeRate ? `${member.closeRate}%` : '—'}
                    </TableCell>
                    <TableCell className='text-right'>
                      <span className='text-muted-foreground text-xs'>
                        {new Date(member.createdAt).toLocaleDateString(
                          'en-US',
                          { month: 'short', day: 'numeric', year: 'numeric' }
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
