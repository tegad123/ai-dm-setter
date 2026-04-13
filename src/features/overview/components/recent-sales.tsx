'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { useEffect, useState } from 'react';

interface RecentLead {
  id: string;
  name: string;
  handle: string;
  platform: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
}

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getStageAction(stage: string) {
  const map: Record<string, string> = {
    NEW_LEAD: 'New lead',
    ENGAGED: 'Engaged',
    QUALIFYING: 'In qualification',
    QUALIFIED: 'Qualified',
    CALL_PROPOSED: 'Call proposed',
    BOOKED: 'Booked a call',
    SHOWED: 'Showed up',
    NO_SHOWED: 'No show',
    RESCHEDULED: 'Rescheduled',
    CLOSED_WON: 'Closed won',
    CLOSED_LOST: 'Closed lost',
    UNQUALIFIED: 'Unqualified',
    GHOSTED: 'Went dark',
    NURTURE: 'In nurture'
  };
  return map[stage] || stage.replace(/_/g, ' ').toLowerCase();
}

function timeAgo(dateStr: string) {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function RecentSales() {
  const [leads, setLeads] = useState<RecentLead[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRecentLeads() {
      try {
        const res = await fetch('/api/leads?limit=5', {
          credentials: 'include'
        });
        if (res.ok) {
          const data = await res.json();
          setLeads(data.leads || []);
        }
      } catch {
        // Silently fail — show empty state
      } finally {
        setLoading(false);
      }
    }
    fetchRecentLeads();
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
        <CardDescription>Latest lead events from AI setter</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className='space-y-4'>
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className='flex items-center gap-4'>
                <div className='bg-muted h-9 w-9 animate-pulse rounded-full' />
                <div className='flex-1 space-y-2'>
                  <div className='bg-muted h-3 w-32 animate-pulse rounded' />
                  <div className='bg-muted h-2 w-20 animate-pulse rounded' />
                </div>
              </div>
            ))}
          </div>
        ) : leads.length === 0 ? (
          <div className='text-muted-foreground py-8 text-center text-sm'>
            No activity yet. Leads will appear here as your AI setter engages
            with prospects.
          </div>
        ) : (
          <div className='space-y-4'>
            {leads.map((lead) => (
              <div key={lead.id} className='flex items-center gap-4'>
                <Avatar className='h-9 w-9'>
                  <AvatarFallback className='bg-primary/10 text-primary text-xs'>
                    {getInitials(lead.name)}
                  </AvatarFallback>
                </Avatar>
                <div className='flex-1 space-y-1'>
                  <p className='text-sm leading-none font-medium'>
                    {lead.name}
                    <span className='text-muted-foreground ml-2 text-xs'>
                      {lead.platform === 'INSTAGRAM' ? 'IG' : 'FB'}
                    </span>
                  </p>
                  <p className='text-muted-foreground text-xs'>
                    {getStageAction(lead.stage)}
                  </p>
                </div>
                <div className='text-muted-foreground text-xs'>
                  {timeAgo(lead.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
