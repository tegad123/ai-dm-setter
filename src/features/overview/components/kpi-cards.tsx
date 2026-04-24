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

  // Shared glass card class lifts every KPI card into the glass-UI
  // aesthetic without changing the Card primitive's default styling
  // used elsewhere in the app.
  const kpiCard = 'glass glass-sm @container/card border-0 py-4';
  const kpiDeltaUp = 'kpi-delta up flex items-center gap-1';

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconUsers className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>
              Total Leads
            </CardDescription>
          </div>
          <CardTitle className='num-big'>
            {stats.totalLeads.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className={kpiDeltaUp}>
            <IconTrendingUp className='h-3 w-3' /> +18%
          </span>
          <span className='text-muted-foreground ml-1'>vs last month</span>
        </CardFooter>
      </Card>

      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconMessage className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>
              Leads Today
            </CardDescription>
          </div>
          <CardTitle className='num-big'>{stats.leadsToday}</CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className={kpiDeltaUp}>
            <IconTrendingUp className='h-3 w-3' /> +3
          </span>
          <span className='text-muted-foreground ml-1'>from yesterday</span>
        </CardFooter>
      </Card>

      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconCalendar className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>
              Calls Booked
            </CardDescription>
          </div>
          <CardTitle className='num-big'>{stats.callsBooked}</CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className='text-muted-foreground'>This month</span>
        </CardFooter>
      </Card>

      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconEye className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>Show Rate</CardDescription>
          </div>
          <CardTitle className='num-big'>{stats.showRate}%</CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className={kpiDeltaUp}>
            <IconTrendingUp className='h-3 w-3' /> +5%
          </span>
          <span className='text-muted-foreground ml-1'>vs avg</span>
        </CardFooter>
      </Card>

      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconTargetArrow className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>
              Close Rate
            </CardDescription>
          </div>
          <CardTitle className='num-big'>{stats.closeRate}%</CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className={kpiDeltaUp}>
            <IconTrendingUp className='h-3 w-3' /> +8%
          </span>
          <span className='text-muted-foreground ml-1'>vs last month</span>
        </CardFooter>
      </Card>

      <Card className={kpiCard}>
        <CardHeader className='pb-2'>
          <div className='kpi-head'>
            <div className='kpi-icon'>
              <IconCash className='h-4 w-4' />
            </div>
            <CardDescription className='font-medium'>Revenue</CardDescription>
          </div>
          <CardTitle className='num-big'>
            ${stats.revenue.toLocaleString()}
          </CardTitle>
        </CardHeader>
        <CardFooter className='text-xs'>
          <span className={kpiDeltaUp}>
            <IconTrendingUp className='h-3 w-3' /> +24%
          </span>
          <span className='text-muted-foreground ml-1'>this month</span>
        </CardFooter>
      </Card>
    </div>
  );
}
