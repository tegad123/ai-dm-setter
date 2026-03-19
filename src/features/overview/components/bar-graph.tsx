'use client';

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useLeadVolume } from '@/hooks/use-api';

const chartConfig = {
  leads: {
    label: 'New Leads',
    color: 'var(--primary)'
  }
} satisfies ChartConfig;

export function BarGraph() {
  const { data: rawData, loading } = useLeadVolume();

  const data = rawData.map((d) => ({
    day: new Date(d.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric'
    }),
    leads: d.count
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead Volume</CardTitle>
        <CardDescription>New leads per day (last 14 days)</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className='h-[300px] w-full' />
        ) : (
          <ChartContainer config={chartConfig} className='h-[300px] w-full'>
            <BarChart data={data}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey='day'
                tickLine={false}
                axisLine={false}
                fontSize={12}
              />
              <YAxis tickLine={false} axisLine={false} fontSize={12} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar
                dataKey='leads'
                fill='var(--color-leads)'
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
