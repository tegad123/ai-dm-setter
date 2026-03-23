import PageContainer from '@/components/layout/page-container';
import { LeadsTable } from '@/features/leads/components/leads-table';

export const metadata = {
  title: 'DMsetter — Leads'
};

export default function LeadsPage() {
  return (
    <PageContainer
      pageTitle='Lead Pipeline'
      pageDescription='All leads organized by status with quality scores'
    >
      <LeadsTable />
    </PageContainer>
  );
}
