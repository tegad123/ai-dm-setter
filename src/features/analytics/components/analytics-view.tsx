'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent
} from '@/components/ui/chart';
import {
  Line,
  LineChart,
  Bar,
  BarChart,
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis
} from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import {
  IconClock,
  IconPercentage,
  IconMessage,
  IconTargetArrow
} from '@tabler/icons-react';
import {
  useOverviewStats,
  useLeadVolume,
  useFunnel,
  useTriggerPerformance,
  useRevenueData
} from '@/hooks/use-api';

const leadConfig = {
  leads: { label: 'Leads', color: 'var(--primary)' }
} satisfies ChartConfig;
const triggerConfig = {
  leads: { label: 'Leads', color: 'var(--primary)' }
} satisfies ChartConfig;
const revenueConfig = {
  revenue: { label: 'Revenue', color: 'var(--primary)' }
} satisfies ChartConfig;

export function AnalyticsView() {
  const { stats, loading: statsLoading } = useOverviewStats();
  const { data: leadVolumeData, loading: lvLoading } = useLeadVolume();
  const { data: funnelData, loading: funnelLoading } = useFunnel();
  const { data: triggerRaw, loading: triggerLoading } = useTriggerPerformance();
  const { data: revenueRaw, loading: revenueLoading } = useRevenueData();

  // Map API shapes to chart-friendly shapes
  const leadChartData = leadVolumeData.map((d) => ({
    day: new Date(d.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }),
    leads: d.count
  }));

  const funnelChartData = funnelData.map((d) => ({
    stage: d.stage,
    count: d.count
  }));

  const triggerChartData = triggerRaw.map((d) => ({
    source: d.trigger,
    leads: d.leads
  }));

  const revenueChartData = revenueRaw.map((d) => ({
    week: new Date(d.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }),
    revenue: d.cumulative
  }));

  const maxFunnelCount =
    funnelChartData.length > 0 ? funnelChartData[0].count : 1;

  return (
    <div className='space-y-4'>
      {/* AI Metrics */}
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Response Rate</CardDescription>
            <IconMessage className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className='h-8 w-20' />
            ) : (
              <>
                <div className='text-2xl font-bold'>
                  {stats ? `${stats.leadsToday}` : '--'}
                </div>
                <p className='text-muted-foreground text-xs'>New leads today</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Avg Time to Book</CardDescription>
            <IconClock className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className='h-8 w-20' />
            ) : (
              <>
                <div className='text-2xl font-bold'>
                  {stats ? `${stats.showRate.toFixed(0)}%` : '--'}
                </div>
                <p className='text-muted-foreground text-xs'>
                  Show rate for booked calls
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Qualification Rate</CardDescription>
            <IconPercentage className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className='h-8 w-20' />
            ) : (
              <>
                <div className='text-2xl font-bold'>
                  {stats ? `${stats.closeRate.toFixed(0)}%` : '--'}
                </div>
                <p className='text-muted-foreground text-xs'>
                  Close rate from booked calls
                </p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardDescription>Booked Calls</CardDescription>
            <IconTargetArrow className='text-primary h-4 w-4' />
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className='h-8 w-20' />
            ) : (
              <>
                <div className='text-2xl font-bold'>
                  {stats?.callsBooked ?? '--'}
                </div>
                <p className='text-muted-foreground text-xs'>
                  Total: {stats?.totalLeads ?? 0} | Revenue: $
                  {stats?.revenue?.toLocaleString() ?? 0}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        {/* Lead Volume */}
        <Card>
          <CardHeader>
            <CardTitle>Lead Volume (30 Days)</CardTitle>
            <CardDescription>
              Daily new leads entering the pipeline
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lvLoading ? (
              <Skeleton className='h-[250px] w-full' />
            ) : (
              <ChartContainer config={leadConfig} className='h-[250px] w-full'>
                <LineChart data={leadChartData}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey='day'
                    tickLine={false}
                    axisLine={false}
                    fontSize={10}
                    interval={4}
                  />
                  <YAxis tickLine={false} axisLine={false} fontSize={12} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line
                    type='monotone'
                    dataKey='leads'
                    stroke='var(--color-leads)'
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Conversion Funnel */}
        <Card>
          <CardHeader>
            <CardTitle>Conversion Funnel</CardTitle>
            <CardDescription>
              Lead progression through pipeline stages
            </CardDescription>
          </CardHeader>
          <CardContent>
            {funnelLoading ? (
              <Skeleton className='h-[250px] w-full' />
            ) : (
              <div className='space-y-3'>
                {funnelChartData.map((stage) => (
                  <div key={stage.stage} className='space-y-1'>
                    <div className='flex justify-between text-sm'>
                      <span>{stage.stage}</span>
                      <span className='font-medium'>{stage.count}</span>
                    </div>
                    <div className='bg-muted h-8 overflow-hidden rounded'>
                      <div
                        className='bg-primary h-full rounded transition-all'
                        style={{
                          width: `${(stage.count / maxFunnelCount) * 100}%`
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Trigger Performance */}
        <Card>
          <CardHeader>
            <CardTitle>Trigger Performance</CardTitle>
            <CardDescription>
              Which content drives the most leads
            </CardDescription>
          </CardHeader>
          <CardContent>
            {triggerLoading ? (
              <Skeleton className='h-[250px] w-full' />
            ) : (
              <ChartContainer
                config={triggerConfig}
                className='h-[250px] w-full'
              >
                <BarChart data={triggerChartData} layout='vertical'>
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type='number'
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                  />
                  <YAxis
                    dataKey='source'
                    type='category'
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar
                    dataKey='leads'
                    fill='var(--color-leads)'
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        {/* Revenue */}
        <Card>
          <CardHeader>
            <CardTitle>Revenue Growth</CardTitle>
            <CardDescription>
              Cumulative revenue from AI-booked calls
            </CardDescription>
          </CardHeader>
          <CardContent>
            {revenueLoading ? (
              <Skeleton className='h-[250px] w-full' />
            ) : (
              <ChartContainer
                config={revenueConfig}
                className='h-[250px] w-full'
              >
                <AreaChart data={revenueChartData}>
                  <defs>
                    <linearGradient
                      id='revenueGrad'
                      x1='0'
                      y1='0'
                      x2='0'
                      y2='1'
                    >
                      <stop
                        offset='5%'
                        stopColor='var(--color-revenue)'
                        stopOpacity={0.3}
                      />
                      <stop
                        offset='95%'
                        stopColor='var(--color-revenue)'
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey='week'
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={12}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type='monotone'
                    dataKey='revenue'
                    stroke='var(--color-revenue)'
                    fill='url(#revenueGrad)'
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
