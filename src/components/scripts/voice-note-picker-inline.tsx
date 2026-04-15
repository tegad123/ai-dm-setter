'use client';

import { useState, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { getVoiceNotes } from '@/lib/api';
import { Loader2, Mic } from 'lucide-react';

interface VoiceNoteOption {
  id: string;
  userLabel: string | null;
  audioFileUrl: string;
  durationSeconds: number;
  status: string;
}

interface VoiceNotePickerInlineProps {
  value: string | null;
  onChange: (voiceNoteId: string | null) => void;
}

export default function VoiceNotePickerInline({
  value,
  onChange
}: VoiceNotePickerInlineProps) {
  const [options, setOptions] = useState<VoiceNoteOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getVoiceNotes()
      .then((data) => {
        const items = data.items || (data as any) || [];
        setOptions(
          items
            .filter((v: any) => v.status === 'ACTIVE')
            .map((v: any) => ({
              id: v.id,
              userLabel: v.userLabel,
              audioFileUrl: v.audioFileUrl,
              durationSeconds: v.durationSeconds,
              status: v.status
            }))
        );
      })
      .catch((err) => console.error('Failed to load voice notes:', err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className='text-muted-foreground flex items-center gap-2 text-sm'>
        <Loader2 className='h-4 w-4 animate-spin' />
        Loading voice notes...
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className='text-muted-foreground flex items-center gap-2 text-sm'>
        <Mic className='h-4 w-4' />
        No voice notes in library. Upload one in Voice Notes &gt; Library first.
      </div>
    );
  }

  const selected = options.find((o) => o.id === value);

  return (
    <div className='space-y-2'>
      <Select
        value={value || '__none__'}
        onValueChange={(v) => onChange(v === '__none__' ? null : v)}
      >
        <SelectTrigger className='w-full'>
          <SelectValue placeholder='Select a voice note...' />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='__none__'>None (user fills later)</SelectItem>
          {options
            .filter((vn) => vn.id)
            .map((vn) => (
              <SelectItem key={vn.id} value={vn.id}>
                <span className='flex items-center gap-2'>
                  <Mic className='h-3 w-3' />
                  {vn.userLabel || 'Untitled'} ({Math.round(vn.durationSeconds)}
                  s)
                </span>
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      {selected && (
        <div className='flex items-center gap-2'>
          <Badge variant='secondary' className='text-xs'>
            <Mic className='mr-1 h-3 w-3' />
            {Math.round(selected.durationSeconds)}s
          </Badge>
          <audio
            src={selected.audioFileUrl}
            controls
            className='h-8 w-48'
            preload='none'
          />
        </div>
      )}
    </div>
  );
}
