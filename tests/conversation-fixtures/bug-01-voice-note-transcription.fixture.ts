// BUG 01 — voice-note-transcription
// What: When a lead sent a voice note, the AI emitted a robotic
//       fallback ("couldn't catch the audio bro, type it out real
//       quick") instead of either transcribing + responding or
//       using a warm fallback.
// Found: 2026-05-04 production audit.
// Fixed: voice-note transcription + warm fallback wording in
//        ai-engine.ts voice-note path.

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-01-voice-note-transcription',
  bug: 1,
  slug: 'voice-note-transcription',
  description:
    'Voice notes must be transcribed + answered OR fall back to a warm "something glitched" line. Robotic fallback wording is forbidden.',
  bugFoundDate: '2026-05-04',
  fixReference: 'voice-note path in ai-engine.ts + warm fallback copy',
  conversationHistory: [
    { sender: 'AI', content: 'whats the goal you trying to hit by EOY?' },
    { sender: 'LEAD', content: 'replace my 9-5 bro' },
    {
      sender: 'AI',
      content: 'love that. how soon you trying to make it happen?'
    }
  ],
  lastLeadMessage: '[Voice note]',
  recordedAssistantReply:
    "ah bro, something glitched on my end with the audio — mind dropping the gist as text? just so i don't miss anything you said.",
  expectedBehavior:
    'Either transcribed reply OR warm fallback ("something glitched on my end with the audio").',
  forbiddenBehavior:
    'Robotic fallback: "couldn\'t catch the audio bro, type it out real quick".',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPhrases: [
      "couldn't catch the audio",
      'type it out real quick',
      'audio not supported',
      'cannot process audio',
      'unable to play audio'
    ]
  }
};
