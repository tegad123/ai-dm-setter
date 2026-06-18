import PageContainer from '@/components/layout/page-container';
import TakeoverView from './takeover-view';

export const metadata = { title: 'Convlo — Conversation Takeover' };

export default async function TakeoverPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <PageContainer
      pageTitle='Conversation Takeover'
      pageDescription='Import a prior DM thread so the AI can resume from context'
    >
      <TakeoverView leadId={id} />
    </PageContainer>
  );
}
