'use client';

import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter
} from '@/components/ui/card';
import {
  IconTrendingUp,
  IconUsers,
  IconCalendar,
  IconEye,
  IconTargetArrow,
  IconCash,
  IconMessage
} from '@tabler/icons-react';
import { useOverviewStats } from '@/hooks/use-api';

export function KpiCards() {
  const { stats, loading, error } = useOverviewStats();

  if (loading) {
    return (
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className='@container/card animate-pulse'>
            <CardHeader className='pb-2'>
              <div className='bg-muted h-4 w-24 rounded' />
              <div className='bg-muted mt-2 h-8 w-16 rounded' />
            </CardHeader>
            <CardFooter className='text-xs'>
              <div className='bg-muted h-3 w-20 rounded' />
            </CardFooter>
          </Card>
        ))}
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
        <Card className='col-span-full'>
          <CardHeader>
            <CardDescription className='text-destructive'>
              Failed to load stats. Using defaults.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconUsers className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Total Leads</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            {stats.totalLeads.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='flex items-center gap-1 text-emerald-600'>
            <IconTrendingUp className='h-3 w-3' /> +18%
          </span>
          <span className='text-muted-foreground ml-1'>vs last month</span>
        </CardFooter>
      </Card>

      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconMessage className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Leads Today</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            {stats.leadsToday}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='flex items-center gap-1 text-emerald-600'>
            <IconTrendingUp className='h-3 w-3' /> +3
          </span>
          <span className='text-muted-foreground ml-1'>from yesterday</span>
        </CardFooter>
      </Card>

      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconCalendar className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Calls Booked</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            {stats.callsBooked}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='text-muted-foreground'>This month</span>
        </CardFooter>
      </Card>

      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconEye className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Show Rate</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            {stats.showRate}%
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='flex items-center gap-1 text-emerald-600'>
            <IconTrendingUp className='h-3 w-3' /> +5%
          </span>
          <span className='text-muted-foreground ml-1'>vs avg</span>
        </CardFooter>
      </Card>

      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconTargetArrow className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Close Rate</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            {stats.closeRate}%
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='flex items-center gap-1 text-emerald-600'>
            <IconTrendingUp className='h-3 w-3' /> +8%
          </span>
          <span className='text-muted-foreground ml-1'>vs last month</span>
        </CardFooter>
      </Card>

      <Card className='@container/card'>
        <CardHeader className='pb-2'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 rounded-md p-1.5'>
              <IconCash className='text-primary h-4 w-4' />
            </div>
            <CardDescription>Revenue</CardDescription>
          </div>
          <CardTitle className='text-2xl font-bold tabular-nums'>
            ${stats.revenue.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='flex items-center gap-1 text-emerald-600'>
            <IconTrendingUp className='h-3 w-3' /> +24%
          </span>
          <span className='text-muted-foreground ml-1'>this month</span>
        </CardFooter>
      </Card>
    </div>
  );
}
