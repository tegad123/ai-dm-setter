import PageContainer from '@/components/layout/page-container';
import { AnalyticsView } from '@/features/analytics/components/analytics-view';

export const metadata = {
  title: 'DMsetter — Analytics'
};

export default function AnalyticsPage() {
  return (
    <PageContainer
      pageTitle='Analytics'
      pageDescription='Performance metrics and conversion insights'
    >
      <AnalyticsView />
    </PageContainer>
  );
}
