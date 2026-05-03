import assert from 'node:assert/strict';
import {
  buildImageContextText,
  buildVoiceContextText,
  detectAttachmentMediaType,
  extractAttachmentDurationSeconds
} from '@/lib/media-processing';
import { scoreVoiceQuality } from '@/lib/voice-quality-gate';

const transcribedContext =
  '[Voice note (transcribed): "I have two years in network marketing and just started trading this year"]';

const blocked = scoreVoiceQuality("couldn't catch the audio bro, type it out", {
  mediaContextCorpus: transcribedContext
});
assert.equal(blocked.passed, false);
assert.ok(
  blocked.hardFails.some((failure) =>
    failure.includes('r29_transcribed_voice_note_ignored:')
  )
);

const allowedFallback = scoreVoiceQuality(
  'yo bro something glitched on my end with the audio, drop me the key points in text and i got you',
  { mediaContextCorpus: '[Voice note - could not transcribe]' }
);
assert.ok(
  !allowedFallback.hardFails.some((failure) =>
    failure.includes('r29_transcribed_voice_note_ignored:')
  )
);

assert.equal(
  buildVoiceContextText({ transcription: 'alerts and automation' }),
  '[Voice note (transcribed): "alerts and automation"]'
);
assert.equal(
  buildImageContextText({
    extractedText: 'voice note transcript',
    description: 'screenshot of an Instagram transcription',
    contextualNote: 'screenshot of voice note transcription'
  }),
  '[Image: screenshot of an Instagram transcription | Text: "voice note transcript" | Note: screenshot of voice note transcription]'
);
assert.equal(
  detectAttachmentMediaType({
    mediaType: 'audio',
    payload: { url: 'https://cdn.example/audio.m4a' }
  }),
  'audio'
);
assert.equal(
  extractAttachmentDurationSeconds({
    type: 'audio',
    payload: { duration_ms: 34_000 }
  }),
  34
);

console.log('media processing gates passed');
