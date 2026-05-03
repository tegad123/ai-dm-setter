'use client';

import {
  IconTrendingUp,
  IconUsers,
  IconCalendar,
  IconEye,
  IconTargetArrow,
  IconCash,
  IconMessage,
  IconPhoto
} from '@tabler/icons-react';
import { useOverviewStats } from '@/hooks/use-api';

// ---------------------------------------------------------------------------
// KpiCards — pure-div glass cards (no shadcn Card wrapper) so the
// translucent glass background can't be overridden by `bg-card`. Each
// card is a `.glass.glass-sm` container with a gradient icon chip,
// `.num-big` numeral, and `.kpi-delta.up` delta row.
// ---------------------------------------------------------------------------

const GRID =
  'grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-7';

type KpiIcon = typeof IconUsers;
interface KpiProps {
  icon: KpiIcon;
  label: string;
  value: string;
  delta?: string;
  deltaIcon?: KpiIcon;
  footer?: string;
}

function Kpi({
  icon: Icon,
  label,
  value,
  delta,
  deltaIcon: DeltaIcon,
  footer
}: KpiProps) {
  return (
    <div className='glass glass-sm flex flex-col gap-2 p-5'>
      <div className='kpi-head'>
        <div className='kpi-icon'>
          <Icon className='h-4 w-4' />
        </div>
        <span className='font-medium'>{label}</span>
      </div>
      <div className='num-big'>{value}</div>
      <div className='mt-1 flex items-center gap-1 text-xs'>
        {delta ? (
          <span className='kpi-delta up flex items-center gap-1'>
            {DeltaIcon ? <DeltaIcon className='h-3 w-3' /> : null}
            {delta}
          </span>
        ) : null}
        {footer ? (
          <span className='text-muted-foreground'>{footer}</span>
        ) : null}
      </div>
    </div>
  );
}

function KpiSkeleton() {
  return (
    <div className='glass glass-sm flex animate-pulse flex-col gap-2 p-5'>
      <div className='flex items-center gap-2'>
        <div className='bg-muted/60 h-7 w-7 rounded-lg' />
        <div className='bg-muted/60 h-4 w-24 rounded' />
      </div>
      <div className='bg-muted/60 mt-1 h-8 w-20 rounded' />
      <div className='bg-muted/60 h-3 w-28 rounded' />
    </div>
  );
}

export function KpiCards() {
  const { stats, loading, error } = useOverviewStats();

  if (loading) {
    return (
      <div className={GRID}>
        {Array.from({ length: 7 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className={GRID}>
        <div className='glass glass-sm text-destructive col-span-full p-5 text-sm'>
          Failed to load stats. Using defaults.
        </div>
      </div>
    );
  }

  const media = stats.mediaProcessing;
  const mediaFooter = media
    ? `${media.dailyVolume} today · p50/p95 ${(media.p50LatencyMs / 1000).toFixed(1)}/${(media.p95LatencyMs / 1000).toFixed(1)}s · $${media.totalCostUsd.toFixed(4)}`
    : 'no media yet';

  return (
    <div className={GRID}>
      <Kpi
        icon={IconUsers}
        label='Total Leads'
        value={stats.totalLeads.toLocaleString()}
        delta='+18%'
        deltaIcon={IconTrendingUp}
        footer='vs last month'
      />
      <Kpi
        icon={IconMessage}
        label='Leads Today'
        value={String(stats.leadsToday)}
        delta='+3'
        deltaIcon={IconTrendingUp}
        footer='from yesterday'
      />
      <Kpi
        icon={IconCalendar}
        label='Calls Booked'
        value={String(stats.callsBooked)}
        footer='This month'
      />
      <Kpi
        icon={IconEye}
        label='Show Rate'
        value={`${stats.showRate}%`}
        delta='+5%'
        deltaIcon={IconTrendingUp}
        footer='vs avg'
      />
      <Kpi
        icon={IconTargetArrow}
        label='Close Rate'
        value={`${stats.closeRate}%`}
        delta='+8%'
        deltaIcon={IconTrendingUp}
        footer='vs last month'
      />
      <Kpi
        icon={IconCash}
        label='Revenue'
        value={`$${stats.revenue.toLocaleString()}`}
        delta='+24%'
        deltaIcon={IconTrendingUp}
        footer='this month'
      />
      <Kpi
        icon={IconPhoto}
        label='Media AI'
        value={media ? `${media.successRate}%` : '100%'}
        footer={media?.alert ? 'alert: below 95% last hour' : mediaFooter}
      />
    </div>
  );
}
