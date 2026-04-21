'use client';

import { useState, useCallback, useEffect } from 'react';
import { useConversations, useMessages } from '@/hooks/use-api';
import { sendMessage, toggleAI } from '@/lib/api';
import type { Conversation as ApiConversation } from '@/lib/api';
import type {
  Conversation,
  Message
} from '@/features/conversations/data/conversation-data';
import { ConversationList } from './conversation-list';
import { ConversationThread } from './conversation-thread';
import { ConversationSidebar } from './conversation-sidebar';
import { Skeleton } from '@/components/ui/skeleton';

/** Map API conversation shape to the local UI shape used by child components */
function toLocalConvo(
  c: ApiConversation & {
    tags?: Array<{ id: string; name: string; color: string }>;
    priorityScore?: number;
    qualityScore?: number;
  },
  messages: Message[] = []
): Conversation {
  return {
    id: c.id,
    leadName: c.leadName,
    leadUsername: c.leadHandle,
    platform: c.platform as 'instagram' | 'facebook',
    stage: c.stage,
    aiActive: c.aiActive,
    lastMessage: c.lastMessage ?? '',
    lastMessageTime: c.lastMessageAt
      ? new Date(c.lastMessageAt).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit'
        })
      : '',
    unread: c.unreadCount,
    messages,
    tags: c.tags ?? [],
    priorityScore: c.priorityScore ?? 0,
    qualityScore: c.qualityScore ?? 0,
    scheduledCallAt: c.scheduledCallAt ?? null
  };
}

type InboxTab = 'all' | 'priority' | 'unread' | 'qualified' | 'unqualified';

type PlatformFilter = '' | 'INSTAGRAM' | 'FACEBOOK';

export function ConversationsView() {
  const [inboxTab, setInboxTab] = useState<InboxTab>('all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('');
  const {
    conversations: apiConversations,
    loading: listLoading,
    refetch: refetchList
  } = useConversations(
    undefined,
    inboxTab === 'priority' ? true : undefined,
    inboxTab === 'unread' ? true : undefined,
    platformFilter || undefined,
    inboxTab === 'qualified'
      ? 'qualified'
      : inboxTab === 'unqualified'
        ? 'unqualified'
        : undefined
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Determine which conversation is selected
  const activeId =
    selectedId ??
    (apiConversations.length > 0 ? apiConversations[0].id : undefined);

  // Fetch messages for the active conversation
  const {
    messages: apiMessages,
    loading: msgLoading,
    refetch: refetchMessages
  } = useMessages(activeId);

  // Map API messages to local Message shape. The API returns uppercase
  // `sender` ("HUMAN" / "AI" / "LEAD") from the Prisma enum; the
  // renderer lowercases it before comparison. `sentByUser` is a new
  // join (Apr 21) used to show the operator's name on manual sends.
  const localMessages: Message[] = apiMessages.map((m) => {
    // `sentByUser` isn't on the narrow `ApiMessage` type yet — read it
    // as an unknown extra field rather than growing the type so other
    // consumers of the Message API stay unaffected.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extra = m as any;
    return {
      id: m.id,
      sender: m.sender as 'ai' | 'lead' | 'human',
      content: m.content,
      timestamp: m.sentAt || m.timestamp || '',
      isHumanOverride: m.isHumanOverride,
      humanOverrideNote: m.humanOverrideNote,
      sentByUser: extra.sentByUser ?? null
    };
  });

  // Map conversations list
  const localConversations: Conversation[] = apiConversations.map((c) =>
    toLocalConvo(c)
  );

  // Build the selected conversation with its messages
  const activeApiConvo = apiConversations.find((c) => c.id === activeId);
  const selected: Conversation | null = activeApiConvo
    ? toLocalConvo(activeApiConvo, localMessages)
    : (localConversations[0] ?? null);

  // Handlers
  const handleSelect = useCallback((c: Conversation) => {
    setSelectedId(c.id);
  }, []);

  const handleSendMessage = useCallback(
    async (content: string) => {
      if (!activeId) return;
      await sendMessage(activeId, content, 'HUMAN');
      refetchMessages();
    },
    [activeId, refetchMessages]
  );

  const handleToggleAI = useCallback(
    async (aiActive: boolean) => {
      if (!activeId) return;
      await toggleAI(activeId, aiActive);
      refetchList();
    },
    [activeId, refetchList]
  );

  // Auto-refresh conversations every 8s to pick up new tags, scores, and messages
  useEffect(() => {
    const interval = setInterval(() => {
      refetchList();
      if (activeId) refetchMessages();
    }, 8000);
    return () => clearInterval(interval);
  }, [refetchList, refetchMessages, activeId]);

  if (listLoading) {
    return (
      <div className='flex h-[calc(100vh-64px)]'>
        <div className='flex w-80 flex-col gap-4 border-r p-4'>
          <Skeleton className='h-8 w-full' />
          <Skeleton className='h-10 w-full' />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className='h-16 w-full' />
          ))}
        </div>
        <div className='flex flex-1 items-center justify-center'>
          <Skeleton className='h-8 w-48' />
        </div>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className='flex h-[calc(100vh-64px)] items-center justify-center'>
        <p className='text-muted-foreground'>No conversations yet.</p>
      </div>
    );
  }

  return (
    <div className='flex h-[calc(100vh-64px)]'>
      <ConversationList
        conversations={localConversations}
        selected={selected}
        onSelect={handleSelect}
        activeTab={inboxTab}
        onTabChange={setInboxTab}
        platformFilter={platformFilter}
        onPlatformFilterChange={setPlatformFilter}
      />
      <ConversationThread
        conversation={selected}
        loading={msgLoading}
        onSendMessage={handleSendMessage}
        onToggleAI={handleToggleAI}
      />
      {/* Right Sidebar — Summary / Score / Notes */}
      {activeApiConvo && (
        <div className='hidden min-h-0 w-80 overflow-hidden border-l lg:flex lg:flex-col'>
          <ConversationSidebar
            conversationId={activeApiConvo.id}
            leadId={activeApiConvo.leadId}
            leadName={activeApiConvo.leadName}
            leadHandle={activeApiConvo.leadHandle}
            platform={activeApiConvo.platform}
            status={activeApiConvo.stage}
            aiActive={activeApiConvo.aiActive}
            qualityScore={activeApiConvo.qualityScore ?? 0}
            priorityScore={activeApiConvo.priorityScore ?? 0}
            tags={activeApiConvo.tags}
            messages={apiMessages.map((m) => ({
              ...m,
              timestamp: m.sentAt || m.timestamp || ''
            }))}
            createdAt={activeApiConvo.createdAt}
          />
        </div>
      )}
    </div>
  );
}
