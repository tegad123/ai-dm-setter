import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { ActionRequired } from '@/features/overview/components/action-required';
import { KpiCards } from '@/features/overview/components/kpi-cards';
import { requireAuth, isPlatformOperator } from '@/lib/auth-guard';
import { redirect } from 'next/navigation';
import React from 'react';

export default async function OverviewLayout({
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
  const auth = await requireAuth();
  if (isPlatformOperator(auth.role)) {
    redirect('/admin');
  }

  return (
    <>
      {/* (app-bg is mounted once at the root layout for every page) */}
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
