'use client';

import { use } from 'react';
import VoiceNoteReview from '@/components/voice-notes/voice-note-review';

export default function VoiceNoteDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <VoiceNoteReview id={id} />;
}
