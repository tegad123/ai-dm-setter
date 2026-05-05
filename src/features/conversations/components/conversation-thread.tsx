'use client';

import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { selectDisplayTags } from '@/features/conversations/lib/select-display-tags';
import { Skeleton } from '@/components/ui/skeleton';
import { LeadStageBadge } from '@/features/shared/lead-stage-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { Conversation } from '@/features/conversations/data/conversation-data';
import {
  IconSend,
  IconMicrophone,
  IconRobot,
  IconUserCheck,
  IconBolt,
  IconPencil
} from '@tabler/icons-react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { LeadStage } from '@/features/shared/lead-stage-badge';
import type { PendingSuggestion } from '@/lib/api';
import { SuggestionBanner } from './suggestion-banner';

// ── Module-scoped training-phase cache ─────────────────────────────
// OverrideNoteInput self-fetches training phase so we can render
// phase-aware copy without prop-drilling through ConversationsView →
// ConversationThread → OverrideNoteInput. 60-second TTL, with a
// shared in-flight promise so a page rendering dozens of override
// inputs only fires one request.
let trainingPhaseCache: { phase: string; fetchedAt: number } | null = null;
let trainingPhaseInFlight: Promise<string> | null = null;
const TRAINING_PHASE_CACHE_TTL_MS = 60_000;

async function getTrainingPhase(): Promise<string> {
  const now = Date.now();
  if (
    trainingPhaseCache &&
    now - trainingPhaseCache.fetchedAt < TRAINING_PHASE_CACHE_TTL_MS
  ) {
    return trainingPhaseCache.phase;
  }
  if (trainingPhaseInFlight) return trainingPhaseInFlight;
  trainingPhaseInFlight = (async () => {
    try {
      const res = await apiFetch<{
        trainingPhase: { trainingPhase: string };
      }>('/settings/training-phase');
      const phase = res?.trainingPhase?.trainingPhase || 'ACTIVE';
      trainingPhaseCache = { phase, fetchedAt: Date.now() };
      return phase;
    } catch {
      return 'ACTIVE'; // safe default — skips the aggressive prompt
    } finally {
      trainingPhaseInFlight = null;
    }
  })();
  return trainingPhaseInFlight;
}

function MessageImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <p className='text-sm'>[Image]</p>;
  }

  return (
    <a
      href={src}
      target='_blank'
      rel='noreferrer'
      className='block max-w-[240px]'
    >
      <img
        src={src}
        alt='Lead shared image'
        className='max-h-80 w-full max-w-[240px] rounded-[12px] object-cover'
        onError={() => setFailed(true)}
      />
    </a>
  );
}

// Placeholder examples rotate every 2s to seed the user with the kind
// of feedback we want ("too formal", "wrong tone", etc.) without
// locking them into any one framing.
const PLACEHOLDER_EXAMPLES = [
  'e.g. too formal',
  "e.g. shouldn't have pitched yet",
  'e.g. wrong tone',
  'e.g. missed the objection'
];
const PLACEHOLDER_ROTATE_MS = 2000;

// Session-scoped: once a user clicks ✕ on a specific override's note
// prompt, don't auto-reopen it on rerender. Cleared on page reload,
// which is intentional — a reload means a fresh look at the data.
const dismissedMessages = new Set<string>();

// ── Inline override note input ──────────────────────────────────────
function OverrideNoteInput({
  conversationId,
  messageId,
  initialNote,
  messageTimestamp
}: {
  conversationId: string;
  messageId: string;
  initialNote: string | null | undefined;
  messageTimestamp: string;
}) {
  // "Fresh" = just sent (< 10s old). Only fresh messages autofocus
  // the input — otherwise, scrolling through history would keep
  // yanking focus out of the main reply box.
  const [isFresh] = useState(() => {
    const t = new Date(messageTimestamp).getTime();
    if (!Number.isFinite(t)) return true; // no timestamp → treat as fresh
    return Date.now() - t < 10_000;
  });

  // Auto-expand on mount unless (a) a note was already saved (show
  // compact saved pill) or (b) user dismissed this message earlier
  // this session.
  const [dismissed, setDismissed] = useState(() =>
    dismissedMessages.has(messageId)
  );
  const [editing, setEditing] = useState(
    () => !initialNote && !dismissedMessages.has(messageId)
  );
  const [note, setNote] = useState(initialNote || '');
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(initialNote || '');
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [trainingPhase, setTrainingPhase] = useState<string | null>(null);

  // Fetch phase once per component instance (cache handles dedup).
  useEffect(() => {
    let cancelled = false;
    getTrainingPhase().then((phase) => {
      if (!cancelled) setTrainingPhase(phase);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rotate placeholder while editing so users see multiple examples.
  useEffect(() => {
    if (!editing) return;
    const interval = setInterval(() => {
      setPlaceholderIndex((i) => (i + 1) % PLACEHOLDER_EXAMPLES.length);
    }, PLACEHOLDER_ROTATE_MS);
    return () => clearInterval(interval);
  }, [editing]);

  const handleSave = async () => {
    // Empty save with no prior saved note = treat as dismiss. Prevents
    // a round-trip for a no-op and matches the ✕ behavior.
    if (!note.trim() && !savedNote) {
      setEditing(false);
      dismissedMessages.add(messageId);
      setDismissed(true);
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/conversations/${conversationId}/override-note`, {
        method: 'POST',
        body: JSON.stringify({ messageId, note: note.trim() })
      });
      setSavedNote(note.trim());
      setEditing(false);
    } catch {
      toast.error('Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = () => {
    setNote(savedNote);
    setEditing(false);
    dismissedMessages.add(messageId);
    setDismissed(true);
  };

  // Saved note → show compact pill, click to re-edit.
  if (!editing && savedNote) {
    return (
      <button
        className='mt-1 flex items-center gap-1 text-[10px] text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300'
        onClick={() => setEditing(true)}
      >
        <IconPencil className='h-3 w-3' />
        &ldquo;{savedNote}&rdquo;
      </button>
    );
  }

  // Dismissed → show a low-key "Add a note" trigger so the user can
  // still reopen if they change their mind.
  if (!editing && dismissed) {
    return (
      <button
        className='text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-[10px]'
        onClick={() => {
          setEditing(true);
          dismissedMessages.delete(messageId);
          setDismissed(false);
        }}
      >
        <IconPencil className='h-3 w-3' />
        Add a note
      </button>
    );
  }

  // Default = inline editable input. ONBOARDING gets amber-filled
  // styling + explicit training-mode copy; other phases get a subtler
  // muted container with softer "Why?" framing.
  const isOnboarding = trainingPhase === 'ONBOARDING';
  return (
    <div
      className={cn(
        'mt-1.5 rounded-md border px-2 py-1.5 text-left',
        isOnboarding
          ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
          : 'border-border bg-muted/40'
      )}
    >
      <div
        className={cn(
          'mb-1 text-[10px]',
          isOnboarding
            ? 'font-medium text-amber-800 dark:text-amber-300'
            : 'text-muted-foreground'
        )}
      >
        {isOnboarding
          ? "You're in training mode — a quick note makes your AI learn faster."
          : 'Why? (helps train your AI)'}
      </div>
      <div className='flex items-center gap-1.5'>
        <input
          type='text'
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 140))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') handleDismiss();
          }}
          placeholder={PLACEHOLDER_EXAMPLES[placeholderIndex]}
          maxLength={140}
          autoFocus={isFresh}
          className={cn(
            'h-6 flex-1 rounded border bg-transparent px-2 text-[11px] outline-none',
            isOnboarding
              ? 'border-amber-400 focus:border-amber-600'
              : 'focus:border-amber-400'
          )}
        />
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-2 text-[10px]'
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '...' : 'Save'}
        </Button>
        <Button
          size='sm'
          variant='ghost'
          className='h-6 px-1 text-[10px]'
          onClick={handleDismiss}
          aria-label='Dismiss note prompt'
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

interface ConversationThreadProps {
  conversation: Conversation;
  loading?: boolean;
  onSendMessage?: (content: string) => Promise<void>;
  onToggleAI?: (aiActive: boolean) => Promise<void>;
  /** Latest unactioned AI suggestion (test-mode platforms with auto-send off). */
  pendingSuggestion?: PendingSuggestion | null;
  /** Called after approve / edit / dismiss so the parent can refetch. */
  onSuggestionActioned?: () => void;
}

export function ConversationThread({
  conversation,
  loading,
  onSendMessage,
  onToggleAI,
  pendingSuggestion,
  onSuggestionActioned
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
          <LeadStageBadge stage={conversation.stage as LeadStage} />
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
          {/* AI-generated tags — capped + deduped to keep header compact.
              Full list lives in the right-hand Summary tab. */}
          {(() => {
            const headerTags = selectDisplayTags(conversation.tags, 4);
            const hidden = (conversation.tags?.length ?? 0) - headerTags.length;
            if (headerTags.length === 0) return null;
            return (
              <div className='flex items-center gap-1'>
                {headerTags.map((tag) => (
                  <TagBadge key={tag.id} name={tag.name} color={tag.color} />
                ))}
                {hidden > 0 && (
                  <span className='text-muted-foreground text-[10px]'>
                    +{hidden}
                  </span>
                )}
              </div>
            );
          })()}
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
              <div>
                {conversation.messages.map((msg, idx) => {
                  const sender = msg.sender.toLowerCase();
                  const isLead = sender === 'lead';
                  const isAI = sender === 'ai';
                  const isHuman = sender === 'human';
                  const isSystem = sender === 'system';
                  const isManyChat = sender === 'manychat';
                  if (isSystem) {
                    return (
                      <div
                        key={msg.id}
                        className={cn(
                          'flex justify-start',
                          idx === 0 ? '' : 'mt-4'
                        )}
                      >
                        <div className='max-w-[78%] rounded-md border border-amber-200 bg-amber-50/90 px-3 py-2 text-left text-amber-950 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'>
                          <div className='text-[10px] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-300'>
                            ⚙️ Internal Note
                          </div>
                          <p className='mt-1 text-xs leading-relaxed whitespace-pre-wrap'>
                            {msg.content}
                          </p>
                          <p className='mt-1 text-[10px] text-amber-700/70 dark:text-amber-300/70'>
                            {new Date(msg.timestamp).toLocaleTimeString(
                              'en-US',
                              {
                                hour: 'numeric',
                                minute: '2-digit'
                              }
                            )}
                          </p>
                        </div>
                      </div>
                    );
                  }
                  // Multi-bubble grouping: a message is part of a group
                  // when messageGroupId is set. The previous/next sibling
                  // sharing the same non-null groupId determines whether
                  // this bubble is first / middle / last in its group.
                  // Messages without a groupId are "standalone" (implicit
                  // 1-bubble group) — same spacing as between groups.
                  const prevMsg =
                    idx > 0 ? conversation.messages[idx - 1] : null;
                  const nextMsg =
                    idx < conversation.messages.length - 1
                      ? conversation.messages[idx + 1]
                      : null;
                  const groupId = msg.messageGroupId ?? null;
                  const inGroup = groupId !== null;
                  const sameGroupAsPrev =
                    inGroup && prevMsg?.messageGroupId === groupId;
                  const sameGroupAsNext =
                    inGroup && nextMsg?.messageGroupId === groupId;
                  const isFirstInGroup = !sameGroupAsPrev;
                  const isLastInGroup = !sameGroupAsNext;
                  const displayContent =
                    msg.hasImage && msg.content === '[Image]'
                      ? ''
                      : msg.content;
                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        'flex',
                        isLead ? 'justify-start' : 'justify-end',
                        // Tight 4px between bubbles of the same group,
                        // 16px between groups / standalone messages. The
                        // first rendered row gets no top margin.
                        idx === 0 ? '' : sameGroupAsPrev ? 'mt-1' : 'mt-4'
                      )}
                    >
                      <div
                        className={cn('max-w-[70%]', !isLead && 'text-right')}
                      >
                        {/* Sender label shown only on the first bubble of a group */}
                        {isFirstInGroup && isAI && (
                          <span className='mb-0.5 inline-block text-[10px] text-blue-400'>
                            AI Setter
                          </span>
                        )}
                        {isFirstInGroup && isHuman && (
                          <span className='mb-0.5 inline-block text-[10px] text-emerald-400'>
                            {msg.sentByUser?.name
                              ? `${msg.sentByUser.name} · Human Setter`
                              : 'Human Setter'}
                            {msg.humanSource === 'PHONE' ? (
                              <span className='text-muted-foreground ml-1'>
                                · from phone
                              </span>
                            ) : null}
                          </span>
                        )}
                        {isFirstInGroup && isManyChat && (
                          <span className='mb-0.5 inline-block text-[10px] text-violet-400'>
                            ManyChat
                            <span className='text-muted-foreground ml-1'>
                              · automation
                            </span>
                          </span>
                        )}
                        <div
                          className={cn(
                            'glass-bubble',
                            isLead && 'theirs',
                            isAI && 'mine',
                            isHuman && 'mine-human',
                            isManyChat && 'mine mine-manychat'
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
                          {msg.imageUrl && (
                            <div className={displayContent ? 'mb-2' : ''}>
                              <MessageImage src={msg.imageUrl} />
                            </div>
                          )}
                          {msg.hasImage && !msg.imageUrl && (
                            <p className='text-sm'>[Image]</p>
                          )}
                          {displayContent && (
                            <p className='text-sm whitespace-pre-wrap'>
                              {displayContent}
                            </p>
                          )}
                          {/* Timestamp + icon row shown only on the last bubble of a group */}
                          {isLastInGroup && (
                            <div className='mt-1 flex items-center gap-1'>
                              <p
                                className={cn(
                                  'text-[10px]',
                                  isLead
                                    ? 'text-muted-foreground'
                                    : 'opacity-60'
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
                          )}
                        </div>
                        {/* Override note input — shown for human override messages */}
                        {isHuman && msg.isHumanOverride && (
                          <OverrideNoteInput
                            conversationId={conversation.id}
                            messageId={msg.id}
                            initialNote={msg.humanOverrideNote}
                            messageTimestamp={msg.timestamp}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {/* Suggestion banner — shown when auto-send is off and the AI
            has generated a reply the operator hasn't actioned yet.
            Sits above the input so the operator sees "approve / edit /
            dismiss" options without scrolling. */}
        {pendingSuggestion && (
          <div className='mt-3 shrink-0'>
            <SuggestionBanner
              conversationId={conversation.id}
              suggestion={pendingSuggestion}
              onActioned={() => onSuggestionActioned?.()}
            />
          </div>
        )}

        {/* Input — fixed at bottom below messages */}
        <div
          className={cn('shrink-0 pb-2', pendingSuggestion ? 'mt-1' : 'mt-3')}
        >
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
