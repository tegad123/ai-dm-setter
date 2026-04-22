'use client';

// ---------------------------------------------------------------------------
// Suggestion banner
// ---------------------------------------------------------------------------
// Sits between the message thread and the "Type a message..." input when
// the AI has a pending suggestion (platform auto-send is off, operator
// hasn't actioned it yet). Three actions: Dismiss / Edit / Send. Edit
// mode swaps the preview for a textarea.
//
// Multi-bubble suggestions render each bubble as its own block.
// Editing collapses them into a single textarea (keeps UX simple —
// operators almost always rewrite the whole thought rather than
// tweaking one bubble).
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IconBolt, IconPencil, IconX, IconSend } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { sendSuggestion, dismissSuggestion } from '@/lib/api';
import type { PendingSuggestion } from '@/lib/api';

interface Props {
  conversationId: string;
  suggestion: PendingSuggestion;
  onActioned: () => void;
}

export function SuggestionBanner({
  conversationId,
  suggestion,
  onActioned
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(suggestion.responseText);
  const [pending, setPending] = useState(false);

  const bubbles: string[] =
    Array.isArray(suggestion.messageBubbles) &&
    suggestion.messageBubbles.length > 0
      ? suggestion.messageBubbles
      : [suggestion.responseText];
  const isMultiBubble = bubbles.length > 1;

  const handleSend = async (withEdit: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      await sendSuggestion(
        conversationId,
        suggestion.id,
        withEdit ? editedText.trim() : undefined
      );
      toast.success(
        withEdit
          ? 'Sent your edit'
          : `Sent AI reply${isMultiBubble ? ` (${bubbles.length} bubbles)` : ''}`
      );
      onActioned();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : 'Failed to send — try again'
      );
    } finally {
      setPending(false);
    }
  };

  const handleDismiss = async () => {
    if (pending) return;
    setPending(true);
    try {
      await dismissSuggestion(conversationId, suggestion.id);
      toast.success('Suggestion dismissed');
      onActioned();
    } catch (err) {
      toast.error(
        err instanceof Error && err.message ? err.message : 'Failed to dismiss'
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className='mb-2 rounded-lg border border-amber-300 bg-amber-50 shadow-sm dark:border-amber-700 dark:bg-amber-950/40'>
      {/* Header row */}
      <div className='flex items-center justify-between border-b border-amber-200 px-3 py-1.5 dark:border-amber-800'>
        <div className='flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300'>
          <IconBolt className='h-3.5 w-3.5' />
          AI Suggestion
          {isMultiBubble && (
            <span className='rounded-full bg-amber-200 px-1.5 py-0 text-[10px] dark:bg-amber-900 dark:text-amber-200'>
              {bubbles.length} bubbles
            </span>
          )}
          {typeof suggestion.qualityGateScore === 'number' && (
            <span className='text-[10px] font-normal text-amber-700/80 dark:text-amber-400'>
              quality {Math.round(suggestion.qualityGateScore * 100)}%
            </span>
          )}
        </div>
        <button
          type='button'
          onClick={() => setCollapsed((v) => !v)}
          className='text-[10px] text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200'
        >
          {collapsed ? 'expand' : 'collapse'}
        </button>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className='px-3 py-2'>
          {editing ? (
            <Textarea
              autoFocus
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
              rows={Math.min(6, Math.max(2, editedText.split('\n').length + 1))}
              className='min-h-[60px] resize-y border-amber-300 bg-white text-sm dark:border-amber-700 dark:bg-neutral-900'
              placeholder='Edit the AI suggestion…'
            />
          ) : isMultiBubble ? (
            <div className='space-y-1'>
              {bubbles.map((b, i) => (
                <div
                  key={i}
                  className='rounded-md bg-white px-2.5 py-1.5 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100'
                >
                  <span className='mr-1 text-[9px] text-amber-600 dark:text-amber-400'>
                    {i + 1}/{bubbles.length}
                  </span>
                  {b}
                </div>
              ))}
            </div>
          ) : (
            <div className='rounded-md bg-white px-2.5 py-1.5 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-100'>
              {suggestion.responseText}
            </div>
          )}

          {/* Actions row */}
          <div className='mt-2 flex items-center justify-end gap-1.5'>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleDismiss}
              disabled={pending}
              className='text-muted-foreground h-7 px-2 text-xs hover:text-red-600'
            >
              <IconX className='mr-1 h-3 w-3' /> Dismiss
            </Button>
            {editing ? (
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setEditing(false);
                  setEditedText(suggestion.responseText);
                }}
                disabled={pending}
                className='h-7 px-2 text-xs'
              >
                Cancel edit
              </Button>
            ) : (
              <Button
                variant='outline'
                size='sm'
                onClick={() => setEditing(true)}
                disabled={pending}
                className='h-7 px-2 text-xs'
              >
                <IconPencil className='mr-1 h-3 w-3' /> Edit
              </Button>
            )}
            <Button
              size='sm'
              onClick={() => handleSend(editing)}
              disabled={pending || (editing && !editedText.trim())}
              className={cn(
                'h-7 px-3 text-xs',
                editing
                  ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                  : 'bg-amber-600 text-white hover:bg-amber-700'
              )}
            >
              <IconSend className='mr-1 h-3 w-3' />
              {editing ? 'Send edit' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
