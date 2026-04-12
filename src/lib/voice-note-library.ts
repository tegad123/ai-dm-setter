// ---------------------------------------------------------------------------
// Voice Note Library — shared constants and helpers
// ---------------------------------------------------------------------------

export const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm'
];

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const DURATION_WARN_LONG = 180; // 3 minutes
export const DURATION_WARN_SHORT = 5; // 5 seconds

/**
 * Estimate audio duration from raw byte length assuming 128 kbps MP3 bitrate.
 * Returns seconds. Matches the pattern in voice-slots/upload/route.ts.
 */
export function estimateAudioDuration(byteLength: number): number {
  return (byteLength * 8) / 128_000;
}

/** File extension from MIME type */
export function audioExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/wav': 'wav',
    'audio/wave': 'wav',
    'audio/x-wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm'
  };
  return map[mime] || 'mp3';
}

/** Estimate processing cost (informational only — no credit enforcement). */
export function estimateProcessingCost(durationSeconds: number) {
  const minutes = durationSeconds / 60;
  const whisper = +(minutes * 0.006).toFixed(4); // ~$0.006/min
  const llm = 0.01; // Sonnet labeling pass — flat estimate
  const embedding = 0.001; // text-embedding-3-small — tiny
  const total = +(whisper + llm + embedding).toFixed(4);
  return { whisper, llm, embedding, total };
}
