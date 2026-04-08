'use client';

import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { LeadStatusBadge } from '@/features/shared/lead-status-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { Conversation } from '@/features/conversations/data/conversation-data';
import {
  IconSend,
  IconMicrophone,
  IconRobot,
  IconUserCheck,
  IconBolt
} from '@tabler/icons-react';
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, [conversation.messages.length]);

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
    <div className='flex min-h-0 flex-1 flex-col overflow-hidden'>
      {/* Header */}
      <div className='flex shrink-0 items-center justify-between border-b px-6 py-3'>
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
          {/* Quality Score */}
          {conversation.qualityScore !== undefined &&
            conversation.qualityScore > 0 && (
              <Badge
                variant='outline'
                className={cn(
                  'text-[10px] font-semibold tabular-nums',
                  conversation.qualityScore >= 70
                    ? 'border-green-300 text-green-600 dark:border-green-700 dark:text-green-400'
                    : conversation.qualityScore >= 40
                      ? 'border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400'
                      : 'border-red-300 text-red-600 dark:border-red-700 dark:text-red-400'
                )}
              >
                {conversation.qualityScore}%
              </Badge>
            )}
          {/* AI-generated tags */}
          {conversation.tags && conversation.tags.length > 0 && (
            <div className='flex flex-wrap gap-1'>
              {conversation.tags.map((tag) => (
                <TagBadge key={tag.id} name={tag.name} color={tag.color} />
              ))}
            </div>
          )}
        </div>
        <div className='flex items-center gap-3'>
          <div className='flex items-center gap-2 rounded-full border px-3 py-1.5'>
            {conversation.aiActive ? (
              <IconBolt className='h-4 w-4 text-blue-500' />
            ) : (
              <IconUserCheck className='h-4 w-4 text-green-500' />
            )}
            <span className='text-xs font-medium'>
              {conversation.aiActive ? 'AI' : 'Human'}
            </span>
            <Switch
              checked={conversation.aiActive}
              onCheckedChange={(checked) => handleToggle(checked)}
              className='data-[state=checked]:bg-blue-500 data-[state=unchecked]:bg-green-500'
            />
          </div>
        </div>
      </div>

      {/* Conversation Panel */}
      <div className='flex min-h-0 flex-1 flex-col px-4 py-3'>
        {/* Messages Box — fills remaining space, scrollable */}
        <div
          ref={messagesContainerRef}
          className='bg-muted/20 min-h-0 flex-1 overflow-y-auto rounded-xl border shadow-inner'
        >
          <div className='p-4 md:p-5'>
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
                        className={cn('max-w-[70%]', !isLead && 'text-right')}
                      >
                        {isAI && (
                          <span className='mb-0.5 inline-block text-[10px] text-blue-400'>
                            AI Setter
                          </span>
                        )}
                        {isHuman && (
                          <span className='mb-0.5 inline-block text-[10px] text-emerald-400'>
                            Human Setter
                          </span>
                        )}
                        <div
                          className={cn(
                            'rounded-2xl px-4 py-2.5',
                            isLead && 'bg-muted text-foreground',
                            isAI && 'bg-primary text-primary-foreground',
                            isHuman && 'bg-emerald-600 text-white'
                          )}
                        >
                          {msg.isVoiceNote && msg.voiceNoteUrl && (
                            <div className='mb-2'>
                              <audio
                                controls
                                preload='none'
                                className='h-8 w-48'
                              >
                                <source
                                  src={msg.voiceNoteUrl}
                                  type='audio/mpeg'
                                />
                              </audio>
                            </div>
                          )}
                          {msg.isVoiceNote && !msg.voiceNoteUrl && (
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
                              {new Date(msg.timestamp).toLocaleTimeString(
                                'en-US',
                                {
                                  hour: 'numeric',
                                  minute: '2-digit'
                                }
                              )}
                            </p>
                            {isAI && (
                              <IconRobot className='h-3 w-3 opacity-60' />
                            )}
                            {isHuman && (
                              <span className='text-[10px] opacity-60'>
                                Manual
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Input — fixed at bottom below messages */}
        <div className='mt-3 shrink-0 pb-2'>
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
    </div>
  );
}
