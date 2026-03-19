import PageContainer from '@/components/layout/page-container';
import { TeamPerformanceView } from '@/features/analytics/components/team-performance-view';

export const metadata = {
  title: 'AI DM Setter — Team Performance'
};

export default function TeamPerformancePage() {
  return (
    <PageContainer
      pageTitle='Team Performance'
      pageDescription='Activity heatmaps, response times, and team leaderboard'
    >
      <TeamPerformanceView />
    </PageContainer>
  );
}
