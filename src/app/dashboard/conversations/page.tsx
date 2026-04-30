import { ConversationsView } from '@/features/conversations/components/conversations-view';

export const metadata = {
  title: 'DMsetter — Conversations'
};

export const dynamic = 'force-dynamic';

export default function ConversationsPage() {
  return <ConversationsView />;
}
