'use client';

import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useTeamNotes } from '@/hooks/use-api';
import { createTeamNote, deleteTeamNote } from '@/lib/api';
import type { TeamNote } from '@/lib/api';
import { IconSend, IconTrash, IconMessageCircle } from '@tabler/icons-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface NotesPanelProps {
  leadId: string;
  leadName: string;
  currentUserId?: string;
  currentUserRole?: string;
}

export function NotesPanel({
  leadId,
  leadName,
  currentUserId,
  currentUserRole
}: NotesPanelProps) {
  const { notes, total, loading, refetch } = useTeamNotes(leadId);
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);

  const handleSubmit = async () => {
    if (!content.trim()) return;
    setSending(true);
    try {
      await createTeamNote(leadId, content.trim());
      setContent('');
      refetch();
    } catch (err: any) {
      toast.error(err.message || 'Failed to add note');
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (noteId: string) => {
    try {
      await deleteTeamNote(leadId, noteId);
      refetch();
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete note');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canDelete = (authorId: string) =>
    currentUserId === authorId || currentUserRole === 'ADMIN';

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case 'ADMIN':
        return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
      case 'CLOSER':
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
      case 'SETTER':
        return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
      default:
        return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    }
  };

  return (
    <div className='flex h-full flex-col'>
      <div className='flex items-center gap-2 border-b px-4 py-2.5'>
        <IconMessageCircle className='h-4 w-4' />
        <h4 className='text-sm font-semibold'>Team Notes</h4>
        <span className='text-muted-foreground text-xs'>({total})</span>
      </div>

      {/* Notes list */}
      <ScrollArea className='min-h-0 flex-1 overflow-hidden p-3'>
        {loading ? (
          <div className='space-y-3'>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className='h-16 w-full rounded-lg' />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className='text-muted-foreground flex flex-col items-center justify-center py-8 text-center'>
            <IconMessageCircle className='mb-2 h-8 w-8 opacity-40' />
            <p className='text-sm'>No notes yet</p>
            <p className='text-xs'>
              Add a note to share context with your team
            </p>
          </div>
        ) : (
          <div className='space-y-3'>
            {notes.map((note: TeamNote) => (
              <div
                key={note.id}
                className='bg-muted/50 group rounded-lg border p-3'
              >
                <div className='mb-1.5 flex items-center gap-2'>
                  <Avatar className='h-5 w-5'>
                    <AvatarImage src={note.author?.avatarUrl ?? undefined} />
                    <AvatarFallback className='text-[10px]'>
                      {(note.author?.name || 'U')
                        .split(' ')
                        .map((n: string) => n[0])
                        .join('')}
                    </AvatarFallback>
                  </Avatar>
                  <span className='text-xs font-medium'>
                    {note.author?.name}
                  </span>
                  <Badge
                    variant='secondary'
                    className={cn(
                      'px-1 py-0 text-[9px]',
                      roleBadgeColor(note.author?.role ?? '')
                    )}
                  >
                    {note.author?.role}
                  </Badge>
                  <span className='text-muted-foreground ml-auto text-[10px]'>
                    {new Date(note.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                  </span>
                  {canDelete(note.authorId) && (
                    <button
                      onClick={() => handleDelete(note.id)}
                      className='text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500'
                    >
                      <IconTrash className='h-3.5 w-3.5' />
                    </button>
                  )}
                </div>
                <p className='text-sm leading-relaxed'>{note.content}</p>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <div className='border-t p-3'>
        <div className='space-y-2'>
          <Textarea
            placeholder={`Add a note about ${leadName}...`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            className='resize-none text-sm'
            disabled={sending}
          />
          <div className='flex items-center justify-between'>
            <span className='text-muted-foreground text-[10px]'>
              {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter to send
            </span>
            <Button
              size='sm'
              onClick={handleSubmit}
              disabled={sending || !content.trim()}
              className='h-7 gap-1 text-xs'
            >
              <IconSend className='h-3 w-3' />
              Add Note
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
