'use client';

import { Pie, PieChart } from 'recharts';
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
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent
} from '@/components/ui/chart';
import { Skeleton } from '@/components/ui/skeleton';
import { useFunnel } from '@/hooks/use-api';

const chartConfig = {
  booked: { label: 'Booked', color: 'var(--chart-1)' },
  qualification: { label: 'In Qualification', color: 'var(--chart-2)' },
  hot: { label: 'Hot Lead', color: 'var(--chart-3)' },
  closed: { label: 'Closed', color: 'var(--chart-4)' },
  other: { label: 'Other', color: 'var(--chart-5)' }
} satisfies ChartConfig;

const CHART_FILLS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)'
];

export function PieGraph() {
  const { data: funnelData, loading } = useFunnel();

  const data = funnelData.map((d, i) => ({
    name: d.stage,
    value: d.count,
    fill: CHART_FILLS[i % CHART_FILLS.length]
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead Distribution</CardTitle>
        <CardDescription>Current pipeline breakdown</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className='mx-auto h-[300px] w-[300px] rounded-full' />
        ) : (
          <ChartContainer config={chartConfig} className='mx-auto h-[300px]'>
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent />} />
              <Pie
                data={data}
                dataKey='value'
                nameKey='name'
                cx='50%'
                cy='50%'
                innerRadius={60}
                outerRadius={100}
                strokeWidth={2}
              />
              <ChartLegend content={<ChartLegendContent />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
