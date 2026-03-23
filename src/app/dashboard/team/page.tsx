import PageContainer from '@/components/layout/page-container';
import { TeamView } from '@/features/team/components/team-view';

export const metadata = {
  title: 'DMsetter — Team'
};

export default function TeamPage() {
  return (
    <PageContainer
      pageTitle='Team Management'
      pageDescription='Manage team members and their roles'
    >
      <TeamView />
    </PageContainer>
  );
}
