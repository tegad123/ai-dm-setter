'use client';

import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { Conversation } from '@/features/conversations/data/conversation-data';
import { IconSearch, IconFlame, IconMail } from '@tabler/icons-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

type InboxTab = 'all' | 'priority' | 'unread';

interface ConversationListProps {
  conversations: Conversation[];
  selected: Conversation;
  onSelect: (c: Conversation) => void;
  activeTab?: InboxTab;
  onTabChange?: (tab: InboxTab) => void;
}

export function ConversationList({
  conversations,
  selected,
  onSelect,
  activeTab = 'all',
  onTabChange
}: ConversationListProps) {
  const [search, setSearch] = useState('');
  const filtered = conversations.filter((c) =>
    c.leadName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className='flex h-full min-h-0 w-80 flex-col border-r'>
      <div className='border-b p-4'>
        <h2 className='mb-3 text-lg font-semibold'>Conversations</h2>

        {/* Tab Switcher */}
        {onTabChange && (
          <div className='mb-3 flex rounded-lg border p-0.5'>
            {[
              { key: 'all' as const, label: 'All', icon: null },
              { key: 'priority' as const, label: 'Priority', icon: IconFlame },
              { key: 'unread' as const, label: 'Unread', icon: IconMail }
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => onTabChange(tab.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                  activeTab === tab.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.icon && <tab.icon className='h-3 w-3' />}
                {tab.label}
              </button>
            ))}
          </div>
        )}

        <div className='relative'>
          <IconSearch className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder='Search...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='pl-9'
          />
        </div>
      </div>
      <ScrollArea className='min-h-0 flex-1 overflow-hidden'>
        {filtered.length === 0 ? (
          <div className='text-muted-foreground p-6 text-center text-sm'>
            {activeTab === 'priority'
              ? 'No high-priority conversations'
              : activeTab === 'unread'
                ? 'All caught up!'
                : 'No conversations found'}
          </div>
        ) : (
          filtered.map((convo) => {
            const initials = convo.leadName
              .split(' ')
              .map((n) => n[0])
              .join('');
            const priorityScore = convo.priorityScore ?? 0;
            return (
              <button
                key={convo.id}
                onClick={() => onSelect(convo)}
                className={cn(
                  'hover:bg-accent flex w-full items-start gap-3 border-b p-4 text-left transition-colors',
                  selected.id === convo.id && 'bg-accent'
                )}
              >
                <div className='relative'>
                  <Avatar className='h-10 w-10'>
                    <AvatarFallback className='bg-primary/10 text-primary text-xs'>
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div
                    className={cn(
                      'border-background absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2',
                      convo.aiActive ? 'bg-blue-500' : 'bg-green-500'
                    )}
                  />
                </div>
                <div className='flex-1 overflow-hidden'>
                  <div className='flex items-center justify-between'>
                    <div className='flex items-center gap-1.5'>
                      <span className='text-sm font-medium'>
                        {convo.leadName}
                      </span>
                      {/* Quality score pill */}
                      {(convo.qualityScore ?? 0) > 0 && (
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[9px] font-bold tabular-nums',
                            (convo.qualityScore ?? 0) >= 70
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : (convo.qualityScore ?? 0) >= 40
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          )}
                        >
                          {convo.qualityScore}%
                        </span>
                      )}
                      {/* Priority indicator */}
                      {priorityScore >= 80 && (
                        <IconFlame className='h-3.5 w-3.5 text-orange-500' />
                      )}
                      {priorityScore >= 50 && priorityScore < 80 && (
                        <span className='h-2 w-2 rounded-full bg-amber-400' />
                      )}
                    </div>
                    <span className='text-muted-foreground text-[10px]'>
                      {convo.lastMessageTime}
                    </span>
                  </div>
                  <div className='flex items-center gap-1'>
                    <PlatformIcon
                      platform={convo.platform}
                      className='h-3 w-3'
                    />
                    <span className='text-muted-foreground text-xs'>
                      @{convo.leadUsername}
                    </span>
                    {activeTab === 'priority' && priorityScore > 0 && (
                      <span className='text-muted-foreground ml-auto text-[10px] tabular-nums'>
                        {priorityScore}
                      </span>
                    )}
                  </div>
                  {/* AI-generated tags */}
                  {convo.tags && convo.tags.length > 0 && (
                    <div className='mt-1 flex flex-wrap gap-0.5'>
                      {convo.tags.slice(0, 3).map((tag) => (
                        <TagBadge
                          key={tag.id}
                          name={tag.name}
                          color={tag.color}
                        />
                      ))}
                      {convo.tags.length > 3 && (
                        <span className='text-muted-foreground text-[9px]'>
                          +{convo.tags.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  <p className='text-muted-foreground mt-1 truncate text-xs'>
                    {convo.lastMessage}
                  </p>
                </div>
                {convo.unread > 0 && (
                  <span className='bg-primary text-primary-foreground mt-1 flex h-5 w-5 items-center justify-center rounded-full text-[10px]'>
                    {convo.unread}
                  </span>
                )}
              </button>
            );
          })
        )}
      </ScrollArea>
    </div>
  );
}
