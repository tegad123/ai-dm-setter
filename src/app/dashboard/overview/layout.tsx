import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { ActionRequired } from '@/features/overview/components/action-required';
import { KpiCards } from '@/features/overview/components/kpi-cards';
import React from 'react';

export default function OverviewLayout({
  sales,
  pie_stats,
  bar_stats,
  area_stats
}: {
  sales: React.ReactNode;
  pie_stats: React.ReactNode;
  bar_stats: React.ReactNode;
  area_stats: React.ReactNode;
}) {
  return (
    <>
      {/* Fixed decorative backdrop — three blurred gradient orbs +
          faint grid under the dashboard content. Pointer-events-none
          so interactions pass through to the real UI above. */}
      <div className='app-bg' aria-hidden>
        <div className='glow-a' />
        <div className='glow-b' />
        <div className='glow-c' />
        <div className='glow-grid' />
      </div>
      <PageContainer>
        <div className='glass-fadeup relative z-10 flex flex-1 flex-col space-y-4'>
          <div className='flex items-center justify-between'>
            <div>
              <h2 className='num-big tracking-tight'>Dashboard Overview</h2>
              <p className='text-muted-foreground mt-1 text-sm'>
                Live operations at a glance
              </p>
            </div>
            <Badge variant='outline' className='tag tag-engaged'>
              <span className='tag-dot' /> Live
            </Badge>
          </div>

          {/* Action Required — operator command center, sits above
              metrics so the FIRST thing the operator sees is what
              needs their attention right now. */}
          <ActionRequired />

          {/* KPI Cards */}
          <KpiCards />

          {/* Charts Grid */}
          <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-7'>
            <div className='col-span-4'>{bar_stats}</div>
            <div className='col-span-4 md:col-span-3'>{sales}</div>
            <div className='col-span-4'>{area_stats}</div>
            <div className='col-span-4 md:col-span-3'>{pie_stats}</div>
          </div>
        </div>
      </PageContainer>
    </>
  );
}
