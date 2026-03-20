import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Message Effectiveness Scoring Engine (Phase 4 - Self-Optimizing Layer)
// ---------------------------------------------------------------------------

export interface MessageScore {
  stage: string;
  segment: string; // lead intent tag
  effectivenessScore: number; // 0-1
  responseRate: number;
  continuedRate: number;
  stageAdvancementRate: number;
  bookingRate: number;
  sampleSize: number;
}

/**
 * Ordered conversation stages matching the Conversation model timestamp fields.
 * Used to determine whether a conversation advanced past a given stage.
 */
const STAGE_ORDER: readonly string[] = [
  'qualification',
  'vision_building',
  'pain_identification',
  'urgency',
  'solution_offer',
  'capital_qualification',
  'booking'
] as const;

/**
 * Map from stage name to the corresponding Conversation timestamp field.
 */
const STAGE_TIMESTAMP_FIELD: Record<string, string> = {
  qualification: 'stageQualificationAt',
  vision_building: 'stageVisionBuildingAt',
  pain_identification: 'stagePainIdentificationAt',
  urgency: 'stageUrgencyAt',
  solution_offer: 'stageSolutionOfferAt',
  capital_qualification: 'stageCapitalQualificationAt',
  booking: 'stageBookingAt'
};

/**
 * Return the next stage name given the current stage, or null if it's the last.
 */
function getNextStage(stage: string): string | null {
  const normalized = stage.toLowerCase().replace(/\s+/g, '_');
  const idx = STAGE_ORDER.indexOf(normalized);
  if (idx === -1 || idx >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

/**
 * Calculate message effectiveness scores per stage per lead-intent segment.
 *
 * Formula:
 *   effectiveness_score =
 *     response_rate        * 0.30 +
 *     lead_continued_rate  * 0.15 +
 *     stage_advancement    * 0.35 +
 *     eventual_booking     * 0.20
 *
 * Only returns results with sampleSize >= 5.
 */
export async function calculateMessageEffectiveness(
  accountId: string
): Promise<MessageScore[]> {
  // 1. Fetch all AI messages with a stage, scoped to this account
  const aiMessages = await prisma.message.findMany({
    where: {
      sender: 'AI',
      stage: { not: null },
      conversation: { lead: { accountId } }
    },
    select: {
      id: true,
      conversationId: true,
      stage: true,
      gotResponse: true,
      leadContinuedConversation: true,
      conversation: {
        select: {
          id: true,
          outcome: true,
          leadIntentTag: true,
          stageQualificationAt: true,
          stageVisionBuildingAt: true,
          stagePainIdentificationAt: true,
          stageUrgencyAt: true,
          stageSolutionOfferAt: true,
          stageCapitalQualificationAt: true,
          stageBookingAt: true
        }
      }
    }
  });

  // 2. Group by (stage, segment)
  type ConvoData = (typeof aiMessages)[number]['conversation'];
  interface BucketEntry {
    gotResponse: boolean | null;
    leadContinued: boolean | null;
    conversation: ConvoData;
    stage: string;
  }

  const buckets = new Map<string, BucketEntry[]>();

  for (const msg of aiMessages) {
    const stage = msg.stage!;
    const segment = msg.conversation.leadIntentTag; // LeadIntentTag enum value
    const key = `${stage}::${segment}`;

    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push({
      gotResponse: msg.gotResponse,
      leadContinued: msg.leadContinuedConversation,
      conversation: msg.conversation,
      stage
    });
  }

  // 3. Compute metrics per bucket
  const scores: MessageScore[] = [];

  for (const [key, entries] of Array.from(buckets.entries())) {
    const sampleSize = entries.length;
    if (sampleSize < 5) continue;

    const [stage, segment] = key.split('::');

    // response_rate: % of AI messages where gotResponse = true
    const responseCount = entries.filter(
      (e: BucketEntry) => e.gotResponse === true
    ).length;
    const responseRate = responseCount / sampleSize;

    // lead_continued_rate: % where leadContinuedConversation = true
    const continuedCount = entries.filter(
      (e: BucketEntry) => e.leadContinued === true
    ).length;
    const continuedRate = continuedCount / sampleSize;

    // stage_advancement_rate: % where the conversation reached the NEXT stage
    const nextStage = getNextStage(stage);
    let stageAdvancementRate = 0;
    if (nextStage) {
      const nextTimestampField = STAGE_TIMESTAMP_FIELD[nextStage];
      // Deduplicate by conversation ID to avoid counting a conversation multiple times
      const seenConvoIds = new Set<string>();
      let advancedCount = 0;
      let uniqueConvoCount = 0;

      for (const entry of entries) {
        const convoId = entry.conversation.id;
        if (seenConvoIds.has(convoId)) continue;
        seenConvoIds.add(convoId);
        uniqueConvoCount++;

        // Check if the next stage timestamp is set on this conversation
        const timestamp = (
          entry.conversation as unknown as Record<string, unknown>
        )[nextTimestampField];
        if (timestamp != null) {
          advancedCount++;
        }
      }

      stageAdvancementRate =
        uniqueConvoCount > 0 ? advancedCount / uniqueConvoCount : 0;
    }

    // eventual_booking_rate: % of unique conversations with this stage that had outcome = BOOKED
    const convoOutcomes = new Map<string, string>();
    for (const entry of entries) {
      if (!convoOutcomes.has(entry.conversation.id)) {
        convoOutcomes.set(entry.conversation.id, entry.conversation.outcome);
      }
    }
    const uniqueConvos = convoOutcomes.size;
    const bookedCount = Array.from(convoOutcomes.values()).filter(
      (o) => o === 'BOOKED'
    ).length;
    const bookingRate = uniqueConvos > 0 ? bookedCount / uniqueConvos : 0;

    // Weighted effectiveness score
    const effectivenessScore =
      responseRate * 0.3 +
      continuedRate * 0.15 +
      stageAdvancementRate * 0.35 +
      bookingRate * 0.2;

    scores.push({
      stage,
      segment,
      effectivenessScore: parseFloat(effectivenessScore.toFixed(4)),
      responseRate: parseFloat(responseRate.toFixed(4)),
      continuedRate: parseFloat(continuedRate.toFixed(4)),
      stageAdvancementRate: parseFloat(stageAdvancementRate.toFixed(4)),
      bookingRate: parseFloat(bookingRate.toFixed(4)),
      sampleSize
    });
  }

  // Sort by effectiveness score descending for readability
  scores.sort((a, b) => b.effectivenessScore - a.effectivenessScore);

  return scores;
}
