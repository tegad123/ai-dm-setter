import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Voice Note Timing — independent from AI Persona text response delay
// ---------------------------------------------------------------------------

const DEFAULTS = {
  minDelay: 10,
  maxDelay: 60
};

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export interface VoiceNoteTimingConfig {
  minDelay: number;
  maxDelay: number;
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
    minDelay: row.minDelay,
    maxDelay: row.maxDelay
  };
}

// ---------------------------------------------------------------------------
// Delay calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the voice note delay in seconds.
 * Simply picks a random value between minDelay and maxDelay.
 */
export function calculateVoiceNoteDelay(
  settings: VoiceNoteTimingConfig
): number {
  const raw =
    settings.minDelay + Math.random() * (settings.maxDelay - settings.minDelay);
  return Math.round(raw);
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
    voiceNoteAction: result.voiceNoteAction ?? null,
    _libraryVoiceNote: result._libraryVoiceNote ?? null
  };
}
