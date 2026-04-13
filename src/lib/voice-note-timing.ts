import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Voice Note Timing — independent from AI Persona text response delay
// ---------------------------------------------------------------------------

const DEFAULTS = {
  recordingSpeedMin: 0.7,
  recordingSpeedMax: 1.0,
  thinkingBufferMin: 3,
  thinkingBufferMax: 8
};

const FLOOR_SECONDS = 10;
const CEILING_SECONDS = 180;

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export interface VoiceNoteTimingConfig {
  recordingSpeedMin: number;
  recordingSpeedMax: number;
  thinkingBufferMin: number;
  thinkingBufferMax: number;
}

/**
 * Fetch per-account timing settings, falling back to defaults if no row exists.
 */
export async function getVoiceNoteTimingSettings(
  accountId: string
): Promise<VoiceNoteTimingConfig> {
  const row = await prisma.voiceNoteTimingSettings.findUnique({
    where: { accountId }
  });
  if (!row) return DEFAULTS;
  return {
    recordingSpeedMin: row.recordingSpeedMin,
    recordingSpeedMax: row.recordingSpeedMax,
    thinkingBufferMin: row.thinkingBufferMin,
    thinkingBufferMax: row.thinkingBufferMax
  };
}

// ---------------------------------------------------------------------------
// Delay calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the voice note delay in seconds.
 *
 * Formula: (duration × random(speedMin, speedMax)) + random(thinkingMin, thinkingMax)
 * Clamped to [10, 180] seconds.
 */
export function calculateVoiceNoteDelay(
  durationSeconds: number,
  settings: VoiceNoteTimingConfig
): number {
  const speed =
    settings.recordingSpeedMin +
    Math.random() * (settings.recordingSpeedMax - settings.recordingSpeedMin);
  const thinking =
    settings.thinkingBufferMin +
    Math.random() * (settings.thinkingBufferMax - settings.thinkingBufferMin);
  const raw = durationSeconds * speed + thinking;
  return Math.max(FLOOR_SECONDS, Math.min(CEILING_SECONDS, Math.round(raw)));
}

// ---------------------------------------------------------------------------
// Duration estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the voice note duration based on the AI result.
 *
 * - Pre-recorded slot → look up VoiceNoteSlot.audioDurationSecs
 * - TTS fallback → estimate from text word count (~2.5 words/sec)
 */
export async function estimateVoiceNoteDuration(
  result: {
    voiceNoteAction?: { slot_id: string } | null;
    reply: string;
  },
  accountId: string
): Promise<number> {
  if (result.voiceNoteAction?.slot_id) {
    const slot = await prisma.voiceNoteSlot.findFirst({
      where: { id: result.voiceNoteAction.slot_id, accountId },
      select: { audioDurationSecs: true }
    });
    if (slot?.audioDurationSecs) return slot.audioDurationSecs;
  }
  // TTS estimate: ~2.5 words/sec at normal speech rate
  const wordCount = result.reply.split(/\s+/).length;
  return Math.max(5, wordCount / 2.5);
}

// ---------------------------------------------------------------------------
// Result serialization for ScheduledReply.generatedResult
// ---------------------------------------------------------------------------

/**
 * Serialize the GenerateReplyResult into a JSON-safe object for storage
 * in ScheduledReply.generatedResult. Only includes fields needed for delivery.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeResult(result: Record<string, any>): object {
  return {
    reply: result.reply,
    format: result.format,
    stage: result.stage,
    subStage: result.subStage ?? null,
    stageConfidence: result.stageConfidence,
    sentimentScore: result.sentimentScore,
    experiencePath: result.experiencePath ?? null,
    objectionDetected: result.objectionDetected ?? null,
    stallType: result.stallType ?? null,
    affirmationDetected: result.affirmationDetected ?? false,
    followUpNumber: result.followUpNumber ?? null,
    softExit: result.softExit ?? false,
    leadTimezone: result.leadTimezone ?? null,
    selectedSlotIso: result.selectedSlotIso ?? null,
    leadEmail: result.leadEmail ?? null,
    suggestedTag: result.suggestedTag ?? '',
    suggestedTags: result.suggestedTags ?? [],
    shouldVoiceNote: result.shouldVoiceNote ?? false,
    voiceNoteAction: result.voiceNoteAction ?? null
  };
}
