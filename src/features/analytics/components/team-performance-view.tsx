'use client';

import { useTeamAnalytics } from '@/hooks/use-api';
import { Skeleton } from '@/components/ui/skeleton';
import { ActivityHeatmap } from './activity-heatmap';
import { TeamLeaderboard } from './team-leaderboard';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { IconMessage, IconUsers, IconActivity } from '@tabler/icons-react';

export function TeamPerformanceView() {
  const { analytics, loading } = useTeamAnalytics();

  if (loading) {
    return (
      <div className='space-y-4'>
        <div className='grid grid-cols-3 gap-4'>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className='h-24 w-full' />
          ))}
        </div>
        <Skeleton className='h-64 w-full' />
        <Skeleton className='h-96 w-full' />
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className='text-muted-foreground py-8 text-center'>
        No team analytics data available.
      </div>
    );
  }

  const activeMembers = analytics.members.filter((m) => m.messagesSent > 0);

  return (
    <div className='space-y-6'>
      {/* Summary cards */}
      <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Total Messages</CardDescription>
            <IconMessage className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>
              {analytics.totalMessages.toLocaleString()}
            </div>
            <p className='text-muted-foreground text-xs'>
              Across all team members
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Active Members</CardDescription>
            <IconUsers className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>
              {activeMembers.length}
              <span className='text-muted-foreground text-sm font-normal'>
                {' '}
                / {analytics.members.length}
              </span>
            </div>
            <p className='text-muted-foreground text-xs'>
              Members with activity
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Total Calls Booked</CardDescription>
            <IconActivity className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>
              {analytics.members.reduce((sum, m) => sum + m.callsBooked, 0)}
            </div>
            <p className='text-muted-foreground text-xs'>By all team members</p>
          </CardContent>
        </Card>
      </div>

      {/* Team Activity Heatmap */}
      <ActivityHeatmap
        heatmap={analytics.teamHeatmap}
        title='Team Activity Heatmap'
        description='When your team is most active sending messages (all members combined)'
      />

      {/* Leaderboard */}
      <TeamLeaderboard members={analytics.members} />

      {/* Individual heatmaps for top members */}
      {activeMembers.length > 0 && (
        <div className='space-y-4'>
          <h3 className='text-lg font-semibold'>Individual Activity</h3>
          <div className='grid grid-cols-1 gap-4'>
            {activeMembers.slice(0, 3).map((member) => (
              <ActivityHeatmap
                key={member.id}
                heatmap={member.heatmap}
                title={`${member.name} (${member.role})`}
                description={`${member.messagesSent} messages sent`}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
