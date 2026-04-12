'use client';

import VoiceNotesHub from '@/components/voice-notes/voice-notes-hub';

export default function VoiceNotesPage() {
  return (
    <div className='mx-auto max-w-4xl space-y-6 p-6'>
      <div>
        <h1 className='text-2xl font-bold tracking-tight'>Voice Notes</h1>
        <p className='text-muted-foreground text-sm'>
          Your personal voice note library for AI-powered conversations
        </p>
      </div>
      <VoiceNotesHub />
    </div>
  );
}
