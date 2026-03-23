import PageContainer from '@/components/layout/page-container';
import { TagManager } from '@/features/tags/components/tag-manager';

export const metadata = {
  title: 'DMsetter — Tag Management'
};

export default function TagsSettingsPage() {
  return (
    <PageContainer
      pageTitle='Tag Management'
      pageDescription='Create and manage tags for organizing your leads'
    >
      <TagManager />
    </PageContainer>
  );
}
