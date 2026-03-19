'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import type { TeamMemberStats } from '@/lib/api';
import {
  IconMessage,
  IconPhone,
  IconClock,
  IconTrophy
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface TeamLeaderboardProps {
  members: TeamMemberStats[];
}

function roleBadgeColor(role: string) {
  switch (role) {
    case 'ADMIN':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
    case 'CLOSER':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
    case 'SETTER':
      return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function formatResponseTime(seconds: number | null): string {
  if (!seconds) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function TeamLeaderboard({ members }: TeamLeaderboardProps) {
  const maxMessages = Math.max(1, ...members.map((m) => m.messagesSent));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team Leaderboard</CardTitle>
        <CardDescription>
          Performance ranking by activity and results
        </CardDescription>
      </CardHeader>
      <CardContent>
        {members.length === 0 ? (
          <p className='text-muted-foreground py-4 text-center text-sm'>
            No team activity data yet.
          </p>
        ) : (
          <div className='space-y-4'>
            {members.map((member, index) => {
              const initials = member.name
                .split(' ')
                .map((n) => n[0])
                .join('');
              return (
                <div
                  key={member.id}
                  className='flex items-center gap-4 rounded-lg border p-3'
                >
                  {/* Rank */}
                  <div className='flex h-8 w-8 items-center justify-center'>
                    {index === 0 ? (
                      <IconTrophy className='h-5 w-5 text-amber-500' />
                    ) : (
                      <span className='text-muted-foreground text-sm font-bold'>
                        #{index + 1}
                      </span>
                    )}
                  </div>

                  {/* Avatar + Name */}
                  <div className='flex items-center gap-3'>
                    <Avatar className='h-9 w-9'>
                      <AvatarImage src={member.avatarUrl ?? undefined} />
                      <AvatarFallback className='text-xs'>
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className='text-sm font-medium'>{member.name}</p>
                      <Badge
                        variant='secondary'
                        className={cn(
                          'px-1 py-0 text-[9px]',
                          roleBadgeColor(member.role)
                        )}
                      >
                        {member.role}
                      </Badge>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className='ml-auto grid grid-cols-4 gap-6'>
                    <div className='text-center'>
                      <div className='flex items-center justify-center gap-1'>
                        <IconMessage className='text-muted-foreground h-3 w-3' />
                        <span className='text-sm font-semibold tabular-nums'>
                          {member.messagesSent}
                        </span>
                      </div>
                      <p className='text-muted-foreground text-[10px]'>
                        Messages
                      </p>
                    </div>
                    <div className='text-center'>
                      <div className='flex items-center justify-center gap-1'>
                        <IconPhone className='text-muted-foreground h-3 w-3' />
                        <span className='text-sm font-semibold tabular-nums'>
                          {member.callsBooked}
                        </span>
                      </div>
                      <p className='text-muted-foreground text-[10px]'>Calls</p>
                    </div>
                    <div className='text-center'>
                      <div className='flex items-center justify-center gap-1'>
                        <IconClock className='text-muted-foreground h-3 w-3' />
                        <span className='text-sm font-semibold tabular-nums'>
                          {formatResponseTime(member.avgResponseTime)}
                        </span>
                      </div>
                      <p className='text-muted-foreground text-[10px]'>
                        Avg Time
                      </p>
                    </div>
                    <div className='text-center'>
                      <span className='text-sm font-semibold tabular-nums'>
                        {member.closeRate
                          ? `${(member.closeRate * 100).toFixed(0)}%`
                          : '—'}
                      </span>
                      <p className='text-muted-foreground text-[10px]'>
                        Close %
                      </p>
                    </div>
                  </div>

                  {/* Activity bar */}
                  <div className='w-24'>
                    <Progress
                      value={(member.messagesSent / maxMessages) * 100}
                      className='h-2'
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
