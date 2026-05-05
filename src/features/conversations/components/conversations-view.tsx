'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  useConversations,
  useMessages,
  usePendingSuggestion
} from '@/hooks/use-api';
import { useRealtime } from '@/hooks/use-realtime';
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
    scheduledCallAt: c.scheduledCallAt ?? null,
    hasPendingSuggestion: c.hasPendingSuggestion ?? false,
    source: c.source ?? 'INBOUND'
  };
}

type InboxTab = 'all' | 'priority' | 'unread' | 'qualified' | 'unqualified';

type PlatformFilter = '' | 'INSTAGRAM' | 'FACEBOOK';

export function ConversationsView() {
  const searchParams = useSearchParams();
  const accountId = searchParams.get('accountId');
  const conversationIdParam = searchParams.get('conversationId');
  const [inboxTab, setInboxTab] = useState<InboxTab>('all');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('');
  const [sourceFilter, setSourceFilter] = useState<'' | 'MANYCHAT' | 'DIRECT'>(
    ''
  );
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
        : undefined,
    accountId
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (conversationIdParam) {
      setSelectedId(conversationIdParam);
    }
  }, [conversationIdParam]);

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

  // Pending-suggestion fetch (test-mode platforms with auto-send off).
  // Silently returns null when the platform has auto-send on or when
  // nothing's pending — hook is safe to call unconditionally.
  const { suggestion, refetch: refetchSuggestion } =
    usePendingSuggestion(activeId);

  // Map API messages to local Message shape. The API returns uppercase
  // `sender` ("HUMAN" / "AI" / "LEAD") from the Prisma enum; the
  // renderer lowercases it before comparison. `sentByUser` is a new
  // join (Apr 21) used to show the operator's name on manual sends.
  const localMessages: Message[] = apiMessages
    .map((m) => {
      // `sentByUser` isn't on the narrow `ApiMessage` type yet — read it
      // as an unknown extra field rather than growing the type so other
      // consumers of the Message API stay unaffected.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extra = m as any;
      return {
        id: m.id,
        sender: m.sender.toLowerCase() as
          | 'ai'
          | 'lead'
          | 'human'
          | 'system'
          | 'manychat',
        content: m.content,
        timestamp: m.sentAt || m.timestamp || '',
        isVoiceNote: m.isVoiceNote,
        voiceNoteUrl: m.voiceNoteUrl ?? undefined,
        imageUrl: m.imageUrl ?? null,
        hasImage: m.hasImage ?? Boolean(m.imageUrl),
        mediaType: m.mediaType ?? null,
        mediaUrl: m.mediaUrl ?? null,
        transcription: m.transcription ?? null,
        imageMetadata: m.imageMetadata ?? null,
        mediaProcessedAt: m.mediaProcessedAt ?? null,
        mediaProcessingError: m.mediaProcessingError ?? null,
        isHumanOverride: m.isHumanOverride,
        humanOverrideNote: m.humanOverrideNote,
        sentByUser: extra.sentByUser ?? null,
        humanSource: extra.humanSource ?? null,
        messageGroupId: extra.messageGroupId ?? null,
        bubbleIndex: extra.bubbleIndex ?? null,
        bubbleTotalCount: extra.bubbleTotalCount ?? null,
        msgSource: extra.msgSource ?? null,
        // Soft-delete fields. Read via the `extra` cast — ApiMessage's
        // narrow type doesn't list them yet, but the API selects the
        // full Message row so the values are present at runtime.
        deletedAt: extra.deletedAt ?? null,
        deletedBy: extra.deletedBy ?? null,
        deletedSource: extra.deletedSource ?? null
      };
    })
    .filter((m) => !(m.deletedAt && m.deletedSource === 'DASHBOARD'));

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

  // SSE subscription: when the AI emits a new suggestion for any
  // conversation on this account, re-pull both the pending-suggestion
  // for the focused convo AND the conversation list (so the ⚡ icon
  // on a non-focused convo updates without waiting for the 8s poll).
  useRealtime('ai:suggestion', (data) => {
    const payload = data as { conversationId?: string } | null;
    refetchList();
    if (payload?.conversationId && payload.conversationId === activeId) {
      refetchSuggestion();
    }
  });

  // Phone-origin Meta echoes are saved server-side as HUMAN/PHONE rows.
  // Refresh immediately when the webhook broadcasts one so Daniel's
  // native Facebook/Instagram replies appear without waiting for polling.
  useRealtime('message:new', (data) => {
    const payload = data as { conversationId?: string } | null;
    refetchList();
    if (payload?.conversationId && payload.conversationId === activeId) {
      refetchMessages();
      refetchSuggestion();
    }
  });

  useRealtime('message:deleted', (data) => {
    const payload = data as { conversationId?: string } | null;
    refetchList();
    if (payload?.conversationId && payload.conversationId === activeId) {
      refetchMessages();
      refetchSuggestion();
    }
  });

  // Auto-refresh conversations every 8s for tags, scores, messages,
  // and anything the SSE path might miss (cold-start, missed events,
  // etc.). The suggestion banner also piggybacks on this poll so it
  // catches the initial mount and any late-arriving broadcasts.
  useEffect(() => {
    const interval = setInterval(() => {
      refetchList();
      if (activeId) {
        refetchMessages();
        refetchSuggestion();
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [refetchList, refetchMessages, refetchSuggestion, activeId]);

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
        sourceFilter={sourceFilter}
        onSourceFilterChange={setSourceFilter}
      />
      <ConversationThread
        conversation={selected}
        loading={msgLoading}
        onSendMessage={handleSendMessage}
        onToggleAI={handleToggleAI}
        pendingSuggestion={suggestion}
        onSuggestionActioned={() => {
          // After approve / edit / dismiss, refetch both the suggestion
          // (to clear the banner) and the messages (so newly-sent
          // approval shows up in the thread).
          refetchSuggestion();
          refetchMessages();
          refetchList();
        }}
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
