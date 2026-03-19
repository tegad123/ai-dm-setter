import PageContainer from '@/components/layout/page-container';
import { LeadsTable } from '@/features/leads/components/leads-table';

export const metadata = {
  title: 'AI DM Setter — Leads'
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
