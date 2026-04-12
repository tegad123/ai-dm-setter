'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Mic, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';
import { getVoiceNotes, updateVoiceNote } from '@/lib/api';
import type { VoiceNoteLibraryItem } from '@/lib/api';
import VoiceNoteCard from './voice-note-card';
import UploadVoiceNoteDialog from './upload-voice-note-dialog';

export default function VoiceNotesHub() {
  const router = useRouter();
  const [items, setItems] = useState<VoiceNoteLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);

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

  return (
    <div className='space-y-4'>
      {/* Search + Add */}
      <div className='flex items-center gap-3'>
        <div className='relative flex-1'>
          <Search className='text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2' />
          <Input
            placeholder='Search voice notes...'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className='pl-9'
          />
        </div>
        <Button onClick={() => setShowUpload(true)}>
          <Plus className='mr-1.5 h-4 w-4' />
          Add Voice Note
        </Button>
      </div>

      {/* List */}
      {items.length === 0 ? (
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
          {items.map((item) => (
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
