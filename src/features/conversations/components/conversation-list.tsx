'use client';

import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { Conversation } from '@/features/conversations/data/conversation-data';
import { IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

interface ConversationListProps {
  conversations: Conversation[];
  selected: Conversation;
  onSelect: (c: Conversation) => void;
}

export function ConversationList({
  conversations,
  selected,
  onSelect
}: ConversationListProps) {
  const [search, setSearch] = useState('');
  const filtered = conversations.filter((c) =>
    c.leadName.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className='flex w-80 flex-col border-r'>
      <div className='border-b p-4'>
        <h2 className='mb-3 text-lg font-semibold'>Conversations</h2>
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
      <ScrollArea className='flex-1'>
        {filtered.map((convo) => {
          const initials = convo.leadName
            .split(' ')
            .map((n) => n[0])
            .join('');
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
                  <span className='text-sm font-medium'>{convo.leadName}</span>
                  <span className='text-muted-foreground text-[10px]'>
                    {convo.lastMessageTime}
                  </span>
                </div>
                <div className='flex items-center gap-1'>
                  <PlatformIcon platform={convo.platform} className='h-3 w-3' />
                  <span className='text-muted-foreground text-xs'>
                    @{convo.leadUsername}
                  </span>
                </div>
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
        })}
      </ScrollArea>
    </div>
  );
}
