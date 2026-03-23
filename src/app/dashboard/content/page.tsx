import PageContainer from '@/components/layout/page-container';
import { ContentTable } from '@/features/content/components/content-table';

export const metadata = {
  title: 'DMsetter — Content Attribution'
};

export default function ContentPage() {
  return (
    <PageContainer
      pageTitle='Content Attribution'
      pageDescription='See which reels, stories, and posts are generating leads and revenue'
    >
      <ContentTable />
    </PageContainer>
  );
}
