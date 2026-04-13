'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Clock, Mic, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { getVoiceNotes, updateVoiceNote } from '@/lib/api';
import { parseTriggerJson } from '@/lib/voice-note-triggers';
import type { VoiceNoteLibraryItem } from '@/lib/api';
import VoiceNoteCard from './voice-note-card';
import UploadVoiceNoteDialog from './upload-voice-note-dialog';

export default function VoiceNotesHub() {
  const router = useRouter();
  const [items, setItems] = useState<VoiceNoteLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [triggerFilter, setTriggerFilter] = useState('all');

  const load = useCallback(async (q?: string) => {
    try {
      const res = await getVoiceNotes(q || undefined);
      setItems(res.items);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load voice notes'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      load(search || undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [search, load]);

  async function handleToggleActive(id: string, active: boolean) {
    try {
      const res = await updateVoiceNote(id, { active });
      setItems((prev) => prev.map((i) => (i.id === id ? res.item : i)));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to update voice note'
      );
    }
  }

  function handleClick(id: string) {
    router.push(`/dashboard/voice-notes/${id}`);
  }

  function handleUploadComplete(itemId: string) {
    setShowUpload(false);
    router.push(`/dashboard/voice-notes/${itemId}`);
  }

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <div className='border-primary h-8 w-8 animate-spin rounded-full border-2 border-t-transparent' />
      </div>
    );
  }

  // Client-side trigger type filtering
  const needsReviewCount = items.filter(
    (i) => i.status === 'NEEDS_REVIEW'
  ).length;

  const filteredItems = items.filter((item) => {
    if (triggerFilter === 'all') return true;
    if (triggerFilter === 'needs_review') return item.status === 'NEEDS_REVIEW';
    const triggers = parseTriggerJson(item.triggers);
    if (triggerFilter === 'no_triggers') return triggers.length === 0;
    return triggers.some((t) => t.type === triggerFilter);
  });

  return (
    <div className='space-y-4'>
      {/* Needs Review Banner */}
      {needsReviewCount > 0 && (
        <Card className='border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'>
          <CardContent className='flex items-center gap-3 py-3'>
            <Clock className='h-5 w-5 text-amber-600' />
            <span className='text-sm font-medium'>
              {needsReviewCount} voice note
              {needsReviewCount > 1 ? 's' : ''} migrated and need
              {needsReviewCount === 1 ? 's' : ''} review
            </span>
            <Button
              variant='outline'
              size='sm'
              className='ml-auto'
              onClick={() => setTriggerFilter('needs_review')}
            >
              Review Now
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Search + Filter + Add */}
      <div className='flex flex-wrap items-center gap-3'>
        <div className='relative min-w-[200px] flex-1'>
          <Search className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder='Search voice notes...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='pl-9'
          />
        </div>
        <Select value={triggerFilter} onValueChange={setTriggerFilter}>
          <SelectTrigger className='w-[180px]'>
            <SelectValue placeholder='Filter triggers' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All Voice Notes</SelectItem>
            <SelectItem value='stage_transition'>Stage Transition</SelectItem>
            <SelectItem value='content_intent'>Content Intent</SelectItem>
            <SelectItem value='conversational_move'>
              Conversational Move
            </SelectItem>
            <SelectItem value='needs_review'>Needs Review</SelectItem>
            <SelectItem value='no_triggers'>No Triggers</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowUpload(true)}>
          <Plus className='mr-1.5 h-4 w-4' />
          Add Voice Note
        </Button>
      </div>

      {/* List */}
      {filteredItems.length === 0 ? (
        <Card>
          <CardContent className='flex flex-col items-center gap-4 py-16'>
            <div className='bg-muted flex h-16 w-16 items-center justify-center rounded-full'>
              <Mic className='text-muted-foreground h-8 w-8' />
            </div>
            <h3 className='text-lg font-semibold'>No voice notes yet</h3>
            <p className='text-muted-foreground max-w-md text-center text-sm'>
              Upload pre-recorded voice notes to build your personal library.
              The AI will transcribe, label, and match them to the right
              conversation moments automatically.
            </p>
            <Button onClick={() => setShowUpload(true)}>
              <Plus className='mr-1.5 h-4 w-4' />
              Add Your First Voice Note
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className='space-y-3'>
          {filteredItems.map((item) => (
            <VoiceNoteCard
              key={item.id}
              item={item}
              onToggleActive={handleToggleActive}
              onClick={handleClick}
            />
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <UploadVoiceNoteDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        onComplete={handleUploadComplete}
      />
    </div>
  );
}
