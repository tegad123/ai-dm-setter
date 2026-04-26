'use client';

import { Cell, Pie, PieChart } from 'recharts';
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
import { useLeadDistribution } from '@/hooks/use-api';

// ---------------------------------------------------------------------------
// Per-stage color map. Keyed off the LeadStage enum (prisma/schema.prisma)
// + a couple of forward-compatible names from the spec that aren't
// currently in the enum (CALL_PENDING_VERIFICATION, DORMANT) — those keys
// are harmless when unused. Anything not in this map falls back to the
// neutral slate. Hex codes per Souljah J 2026-04-25 design spec.
// ---------------------------------------------------------------------------
const STAGE_COLORS: Record<string, string> = {
  NEW_LEAD: '#94A3B8', // slate gray
  ENGAGED: '#22D3EE', // cyan
  QUALIFYING: '#FACC15', // yellow
  CALL_PROPOSED: '#126BFF', // blue
  CALL_PENDING_VERIFICATION: '#7C5CFF', // purple
  QUALIFIED: '#20C997', // green
  BOOKED: '#10B981', // emerald
  UNQUALIFIED: '#FF4D6D', // red
  SHOWED: '#059669', // dark green
  NO_SHOWED: '#F97316', // orange
  CLOSED_WON: '#6366F1', // indigo
  DORMANT: '#CBD5E1', // light gray
  // Enum stages not in the spec — fall through to defensive defaults so
  // they don't all collapse onto the slate fallback and look "the same"
  // again the moment ops uses one of them.
  RESCHEDULED: '#A855F7', // violet
  CLOSED_LOST: '#DC2626', // dark red
  GHOSTED: '#64748B', // slate
  NURTURE: '#0EA5E9' // sky blue
};

const FALLBACK_COLOR = '#94A3B8';

// Friendly labels for the legend. Falls back to the raw enum on miss.
const STAGE_LABELS: Record<string, string> = {
  NEW_LEAD: 'New Lead',
  ENGAGED: 'Engaged',
  QUALIFYING: 'Qualifying',
  CALL_PROPOSED: 'Call Proposed',
  CALL_PENDING_VERIFICATION: 'Pending Verification',
  QUALIFIED: 'Qualified',
  BOOKED: 'Booked',
  UNQUALIFIED: 'Unqualified',
  SHOWED: 'Showed',
  NO_SHOWED: 'No Showed',
  CLOSED_WON: 'Closed Won',
  DORMANT: 'Dormant',
  RESCHEDULED: 'Rescheduled',
  CLOSED_LOST: 'Closed Lost',
  GHOSTED: 'Ghosted',
  NURTURE: 'Nurture'
};

function labelFor(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

const chartConfig = {
  count: { label: 'Leads' }
} satisfies ChartConfig;

// Display order for the legend. Stages are surfaced in pipeline-flow
// order so a reader's eye traces NEW_LEAD → … → CLOSED_WON. Any stage
// not in this list (e.g. a future enum value) is appended at the end.
const STAGE_ORDER: string[] = [
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'CALL_PENDING_VERIFICATION',
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'NURTURE',
  'DORMANT',
  'GHOSTED',
  'UNQUALIFIED'
];

function orderRank(stage: string): number {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? STAGE_ORDER.length : i;
}

export function PieGraph() {
  const { stages, total, loading } = useLeadDistribution();

  // Filter out zero-count stages (spec: "Only show stages with count > 0"),
  // sort into pipeline flow order, and lock the color mapping.
  const visible = stages
    .filter((s) => s.count > 0)
    .slice()
    .sort((a, b) => orderRank(a.stage) - orderRank(b.stage))
    .map((s) => ({
      stage: s.stage,
      count: s.count,
      label: labelFor(s.stage),
      fill: STAGE_COLORS[s.stage] ?? FALLBACK_COLOR
    }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lead Distribution</CardTitle>
        <CardDescription>
          {total > 0
            ? `${total} lead${total === 1 ? '' : 's'} across ${visible.length} stage${visible.length === 1 ? '' : 's'}`
            : 'Current pipeline breakdown'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className='mx-auto h-[300px] w-[300px] rounded-full' />
        ) : visible.length === 0 ? (
          <div className='text-muted-foreground flex h-[300px] items-center justify-center text-sm'>
            No leads yet.
          </div>
        ) : (
          <>
            <ChartContainer config={chartConfig} className='mx-auto h-[300px]'>
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      nameKey='label'
                      formatter={(value, _name, item) => {
                        const v = typeof value === 'number' ? value : 0;
                        const pct =
                          total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
                        const labelText =
                          (item?.payload as { label?: string } | undefined)
                            ?.label ?? '';
                        return `${labelText}: ${v} (${pct}%)`;
                      }}
                    />
                  }
                />
                <Pie
                  data={visible}
                  dataKey='count'
                  nameKey='label'
                  cx='50%'
                  cy='50%'
                  innerRadius={60}
                  outerRadius={100}
                  strokeWidth={2}
                >
                  {visible.map((entry) => (
                    <Cell key={entry.stage} fill={entry.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            {/*
             * Legend — the recharts default legend doesn't surface counts
             * and renders below the chart in a single horizontal strip
             * that wraps awkwardly with 10+ stages. Custom 2-column grid
             * keeps each row readable: dot, name, count.
             */}
            <ul className='mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2'>
              {visible.map((entry) => (
                <li
                  key={entry.stage}
                  className='flex items-center justify-between gap-2'
                >
                  <div className='flex items-center gap-2 truncate'>
                    <span
                      aria-hidden
                      className='inline-block h-2.5 w-2.5 shrink-0 rounded-full'
                      style={{ backgroundColor: entry.fill }}
                    />
                    <span className='truncate'>{entry.label}</span>
                  </div>
                  <span className='text-muted-foreground tabular-nums'>
                    {entry.count}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
