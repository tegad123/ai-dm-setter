'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { LeadStatusBadge } from '@/features/shared/lead-status-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { Conversation } from '@/features/conversations/data/conversation-data';
import { IconSend, IconMicrophone, IconRobot } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { LeadStatus } from '@/features/shared/lead-status-badge';

interface ConversationThreadProps {
  conversation: Conversation;
  loading?: boolean;
  onSendMessage?: (content: string) => Promise<void>;
  onToggleAI?: (aiActive: boolean) => Promise<void>;
}

export function ConversationThread({
  conversation,
  loading,
  onSendMessage,
  onToggleAI
}: ConversationThreadProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!message.trim() || !onSendMessage) return;
    setSending(true);
    try {
      await onSendMessage(message.trim());
      setMessage('');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleToggle = async (checked: boolean) => {
    if (onToggleAI) {
      await onToggleAI(checked);
    }
  };

  return (
    <div className='flex flex-1 flex-col'>
      {/* Header */}
      <div className='flex items-center justify-between border-b px-6 py-3'>
        <div className='flex items-center gap-3'>
          <div>
            <div className='flex items-center gap-2'>
              <h3 className='font-semibold'>{conversation.leadName}</h3>
              <PlatformIcon
                platform={conversation.platform}
                className='h-4 w-4'
              />
            </div>
            <p className='text-muted-foreground text-xs'>
              @{conversation.leadUsername}
            </p>
          </div>
          <LeadStatusBadge status={conversation.status as LeadStatus} />
          {conversation.tags && conversation.tags.length > 0 && (
            <div className='flex flex-wrap gap-1'>
              {conversation.tags.map((tag) => (
                <TagBadge key={tag.id} name={tag.name} color={tag.color} />
              ))}
            </div>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <span className='text-muted-foreground text-xs'>AI Active</span>
          <Switch
            checked={conversation.aiActive}
            onCheckedChange={handleToggle}
          />
          <Badge
            variant='outline'
            className={cn(
              conversation.aiActive
                ? 'border-blue-300 text-blue-600 dark:border-blue-700 dark:text-blue-400'
                : 'border-green-300 text-green-600 dark:border-green-700 dark:text-green-400'
            )}
          >
            {conversation.aiActive ? 'AI' : 'Human'}
          </Badge>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className='flex-1 p-6'>
        {loading ? (
          <div className='space-y-4'>
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'flex',
                  i % 2 === 0 ? 'justify-start' : 'justify-end'
                )}
              >
                <Skeleton className='h-12 w-[60%] rounded-2xl' />
              </div>
            ))}
          </div>
        ) : (
          <div className='space-y-4'>
            {conversation.messages.map((msg) => {
              const sender = msg.sender.toLowerCase();
              const isLead = sender === 'lead';
              const isAI = sender === 'ai';
              const isHuman = sender === 'human';
              return (
                <div
                  key={msg.id}
                  className={cn(
                    'flex',
                    isLead ? 'justify-start' : 'justify-end'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[70%] rounded-2xl px-4 py-2.5',
                      isLead && 'bg-muted text-foreground',
                      isAI && 'bg-primary text-primary-foreground',
                      isHuman && 'bg-emerald-600 text-white'
                    )}
                  >
                    {msg.isVoiceNote && (
                      <div className='mb-1 flex items-center gap-1 text-xs opacity-80'>
                        <IconMicrophone className='h-3 w-3' /> Voice Note
                      </div>
                    )}
                    <p className='text-sm'>{msg.content}</p>
                    <div className='mt-1 flex items-center gap-1'>
                      <p
                        className={cn(
                          'text-[10px]',
                          isLead ? 'text-muted-foreground' : 'opacity-60'
                        )}
                      >
                        {new Date(msg.timestamp).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </p>
                      {isAI && <IconRobot className='h-3 w-3 opacity-60' />}
                      {isHuman && (
                        <span className='text-[10px] opacity-60'>Manual</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className='border-t p-4'>
        <div className='flex items-center gap-2'>
          <Input
            placeholder='Type a message...'
            className='flex-1'
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <Button size='icon' variant='ghost'>
            <IconMicrophone className='h-5 w-5' />
          </Button>
          <Button
            size='icon'
            onClick={handleSend}
            disabled={sending || !message.trim()}
          >
            <IconSend className='h-4 w-4' />
          </Button>
        </div>
      </div>
    </div>
  );
}
