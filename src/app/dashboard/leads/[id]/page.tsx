import PageContainer from '@/components/layout/page-container';
import LeadDetail from '@/features/leads/components/lead-detail';

export const metadata = {
  title: 'DMsetter — Lead Detail'
};

export default async function LeadDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PageContainer
      pageTitle='Lead Detail'
      pageDescription='View and manage lead pipeline stage'
    >
      <LeadDetail leadId={id} />
    </PageContainer>
  );
}
