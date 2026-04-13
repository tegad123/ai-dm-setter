import PageContainer from '@/components/layout/page-container';
import { LeadsViewToggle } from '@/features/leads/components/leads-view-toggle';

export const metadata = {
  title: 'DMsetter — Leads'
};

export default function LeadsPage() {
  return (
    <PageContainer
      scrollable={false}
      pageTitle='Lead Pipeline'
      pageDescription='All leads organized by stage'
    >
      <LeadsViewToggle />
    </PageContainer>
  );
}
