'use client';

import VoiceNoteTimingSettings from '@/components/voice-notes/voice-note-timing-settings';

export default function VoiceNoteTimingPage() {
  return (
    <div className='mx-auto max-w-4xl space-y-6 p-6'>
      <div>
        <h1 className='text-2xl font-bold tracking-tight'>Voice Note Timing</h1>
        <p className='text-muted-foreground text-sm'>
          Control how the AI simulates natural recording delays before sending
          voice notes
        </p>
      </div>
      <VoiceNoteTimingSettings />
    </div>
  );
}
