import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
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
    <PageContainer>
      <div className='flex flex-1 flex-col space-y-4'>
        <div className='flex items-center justify-between'>
          <h2 className='text-2xl font-bold tracking-tight'>
            Dashboard Overview
          </h2>
          <Badge variant='outline' className='border-primary/30 text-primary'>
            Live
          </Badge>
        </div>

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
  );
}
