// BUG 20 — voice-note-transcription-response
// What: ManyChat-side AND lead-side voice notes appeared in the
//       conversation as bare `[Voice note]` placeholders. The AI
//       replied "yo bro you still around?" with zero awareness of
//       the audio content because the URL was never sent through
//       Whisper. Two consecutive un-transcribed voice notes bricked
//       the AI's ability to engage. (@andreierz, @arro_.92 2026-05-05)
// Found: 2026-05-05 production audit.
// Fixed: persist audioUrl on MANYCHAT + HUMAN/PHONE echo creates,
//       call enqueueInboundMediaProcessing in both echo paths,
//       extend R29 regex to also catch "didn't get that audio".
//       (src/lib/webhook-processor.ts, src/lib/voice-quality-gate.ts)
//
// This fixture asserts the post-fix behavior: when the AI's
// generation context contains a transcribed voice note, the recorded
// reply must respond to the CONTENT and must NOT contain any of the
// R29 fallback phrases ("couldn't catch", "didn't get that audio",
// "type it out", "send a text", "hard to hear").

import type { ConversationFixture } from './types';

export const fixture: ConversationFixture = {
  id: 'bug-20-voice-note-transcription-response',
  bug: 20,
  slug: 'voice-note-transcription-response',
  description:
    'After Whisper transcription is wired for echo paths, AI must respond to voice-note content (R29) — no audio-fallback language.',
  bugFoundDate: '2026-05-05',
  fixReference:
    'webhook-processor.ts (echo audio capture + enqueueInboundMediaProcessing), voice-quality-gate.ts:1198 (R29 regex)',
  conversationHistory: [
    {
      sender: 'AI',
      content: "yo what's up bro, what got you into trading?"
    }
  ],
  // The lead message slot stands in for the transcribed-voice-note
  // context that gets injected into the AI's system prompt as
  // `[Voice note (transcribed): "..."]`. The recorded reply
  // demonstrates the post-regen behavior — content-aware, no
  // audio-fallback language.
  lastLeadMessage:
    '[Voice note (transcribed): "I\'ve been trading forex for like 2 years now, mostly on smaller prop firm accounts"]',
  recordedAssistantReply:
    "respect bro, 2 years on prop is solid. what's the size of the accounts you've been running, and are you taking payouts consistently or still grinding to evals?",
  expectedBehavior:
    'AI replies to the trading background content of the transcribed voice note.',
  forbiddenBehavior:
    'AI says it could not hear / catch / get the audio, or asks the lead to type it out.',
  assertion: {
    type: 'FORBIDDEN_PHRASE_ABSENT',
    forbiddenPatterns: [
      /couldn'?t catch/i,
      /didn'?t catch/i,
      /didn'?t get that audio/i,
      /type it out/i,
      /send (a )?text/i,
      /hard to hear/i
    ],
    notes:
      'Mirrors the R29 hardfail regex in voice-quality-gate.ts:1198. Any drift here without updating the gate would let an audio-fallback reply ship. Keep the two in sync.'
  }
};
