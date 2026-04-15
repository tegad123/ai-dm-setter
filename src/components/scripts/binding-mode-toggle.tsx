'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Mic, Shuffle, Link2 } from 'lucide-react';
import VoiceNotePickerInline from './voice-note-picker-inline';

interface BindingModeToggleProps {
  bindingMode: 'specific' | 'runtime_match';
  voiceNoteId: string | null;
  onBindingModeChange: (mode: 'specific' | 'runtime_match') => void;
  onVoiceNoteChange: (voiceNoteId: string | null) => void;
}

export default function BindingModeToggle({
  bindingMode,
  voiceNoteId,
  onBindingModeChange,
  onVoiceNoteChange
}: BindingModeToggleProps) {
  if (bindingMode === 'runtime_match') {
    return (
      <Card className='border-dashed'>
        <CardContent className='flex items-center justify-between py-3'>
          <div className='flex items-center gap-2'>
            <Shuffle className='text-muted-foreground h-4 w-4' />
            <div>
              <div className='flex items-center gap-2'>
                <span className='text-sm font-medium'>Runtime Match</span>
                <Badge variant='secondary' className='text-xs'>
                  Auto
                </Badge>
              </div>
              <p className='text-muted-foreground text-xs'>
                AI picks the best voice note from your library based on
                conversation context
              </p>
            </div>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={() => onBindingModeChange('specific')}
          >
            <Link2 className='mr-1.5 h-3.5 w-3.5' />
            Bind Specific
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className='space-y-2'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <Mic className='text-muted-foreground h-4 w-4' />
          <span className='text-sm font-medium'>Specific Voice Note</span>
        </div>
        <Button
          variant='ghost'
          size='sm'
          onClick={() => {
            onBindingModeChange('runtime_match');
            onVoiceNoteChange(null);
          }}
          className='text-xs'
        >
          <Shuffle className='mr-1.5 h-3 w-3' />
          Switch to Runtime Match
        </Button>
      </div>
      <VoiceNotePickerInline value={voiceNoteId} onChange={onVoiceNoteChange} />
    </div>
  );
}
