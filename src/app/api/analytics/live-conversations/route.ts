import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';

// Stage timestamp fields in order for determining current stage.
// Listed in reverse funnel order (latest stage first) so `getCurrentStage`
// returns the deepest stage reached.
const STAGE_FIELDS = [
  // New 7-stage SOP sequence
  { stage: 'booking', field: 'stageBookingAt' },
  { stage: 'financial_screening', field: 'stageFinancialScreeningAt' },
  { stage: 'soft_pitch_commitment', field: 'stageSoftPitchCommitmentAt' },
  { stage: 'urgency', field: 'stageUrgencyAt' },
  { stage: 'goal_emotional_why', field: 'stageGoalEmotionalWhyAt' },
  { stage: 'situation_discovery', field: 'stageSituationDiscoveryAt' },
  { stage: 'opening', field: 'stageOpeningAt' },
  // Legacy fields (backward compat for historical conversations)
  { stage: 'capital_qualification', field: 'stageCapitalQualificationAt' },
  { stage: 'solution_offer', field: 'stageSolutionOfferAt' },
  { stage: 'pain_identification', field: 'stagePainIdentificationAt' },
  { stage: 'vision_building', field: 'stageVisionBuildingAt' },
  { stage: 'qualification', field: 'stageQualificationAt' }
] as const;

type ConversationWithStages = {
  id: string;
  leadId: string;
  createdAt: Date;
  leadIntentTag: string;
  // New 7-stage SOP sequence
  stageOpeningAt: Date | null;
  stageSituationDiscoveryAt: Date | null;
  stageGoalEmotionalWhyAt: Date | null;
  stageUrgencyAt: Date | null;
  stageSoftPitchCommitmentAt: Date | null;
  stageFinancialScreeningAt: Date | null;
  stageBookingAt: Date | null;
  // Legacy fields
  stageQualificationAt: Date | null;
  stageVisionBuildingAt: Date | null;
  stagePainIdentificationAt: Date | null;
  stageSolutionOfferAt: Date | null;
  stageCapitalQualificationAt: Date | null;
  lead: {
    id: string;
    platform: string;
  };
  messages: Array<{
    id: string;
    stage: string | null;
    sender: string;
    timestamp: Date;
  }>;
};

interface VelocityBaseline {
  stage: string;
  avgSecondsBooked: number;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // 1. Fetch all ONGOING conversations with lead and recent messages
    const conversations = (await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        outcome: 'ONGOING'
      },
      include: {
        lead: {
          select: {
            id: true,
            platform: true
          }
        },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 50,
          select: {
            id: true,
            stage: true,
            sender: true,
            timestamp: true
          }
        }
      },
      orderBy: { lastMessageAt: 'desc' }
    })) as unknown as ConversationWithStages[];

    // 2. Get velocity baselines from booked conversations
    const velocityBaselines = await getVelocityBaselines(auth.accountId);
    const baselineMap = new Map(
      velocityBaselines.map((v) => [v.stage, v.avgSecondsBooked])
    );

    // 3. Build response with anonymized data
    const result = conversations.map((convo) => {
      const leadHash = createHash('sha256')
        .update(convo.leadId)
        .digest('hex')
        .slice(0, 6);

      // Current stage: find the latest stage reached via timestamp fields
      const currentStage = getCurrentStage(convo);

      // Message count
      const messageCount = convo.messages.length;

      // Duration since first message
      const firstMessage = convo.messages[convo.messages.length - 1];
      const durationSeconds = firstMessage
        ? Math.round((Date.now() - firstMessage.timestamp.getTime()) / 1000)
        : 0;

      // Velocity score: compare current conversation speed to booked baselines
      const { velocityScore, velocityLabel } = calculateVelocity(
        convo,
        currentStage,
        baselineMap
      );

      return {
        leadId: convo.leadId,
        leadAnonymized: `Lead #${leadHash}`,
        platform: convo.lead.platform,
        currentStage: currentStage ?? 'unknown',
        messageCount,
        duration: durationSeconds,
        velocityScore,
        velocityLabel,
        intentTag: convo.leadIntentTag
      };
    });

    return NextResponse.json({ conversations: result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/analytics/live-conversations error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch live conversations' },
      { status: 500 }
    );
  }
}

// ─── Helper: Determine Current Stage ─────────────────────

function getCurrentStage(convo: ConversationWithStages): string | null {
  // Check stage timestamps in reverse order (latest stage first)
  for (const { stage, field } of STAGE_FIELDS) {
    const timestamp = (convo as unknown as Record<string, unknown>)[field];
    if (timestamp != null) {
      return stage;
    }
  }

  // Fallback: check the latest AI message with a stage field
  const latestAIWithStage = convo.messages.find(
    (m) => m.sender === 'AI' && m.stage != null
  );
  return latestAIWithStage?.stage ?? null;
}

// ─── Helper: Get Velocity Baselines from Booked Conversations ──

async function getVelocityBaselines(
  accountId: string
): Promise<VelocityBaseline[]> {
  // Average response time per stage for BOOKED conversations
  const bookedMessages = await prisma.message.groupBy({
    by: ['stage'],
    where: {
      sender: 'AI',
      stage: { not: null },
      responseTimeSeconds: { not: null },
      conversation: {
        lead: { accountId },
        outcome: 'BOOKED'
      }
    },
    _avg: { responseTimeSeconds: true },
    _count: { id: true }
  });

  return bookedMessages
    .filter((m): m is typeof m & { stage: string } => m.stage !== null)
    .map((m) => ({
      stage: m.stage,
      avgSecondsBooked: m._avg.responseTimeSeconds ?? 0
    }));
}

// ─── Helper: Calculate Velocity Score ────────────────────

function calculateVelocity(
  convo: ConversationWithStages,
  currentStage: string | null,
  baselineMap: Map<string, number>
): { velocityScore: number; velocityLabel: 'fast' | 'normal' | 'slow' } {
  if (!currentStage) {
    return { velocityScore: 0.5, velocityLabel: 'normal' };
  }

  // Get current conversation's average response time for the current stage
  const stageMessages = convo.messages.filter(
    (m) => m.sender === 'AI' && m.stage === currentStage
  );

  if (stageMessages.length === 0) {
    return { velocityScore: 0.5, velocityLabel: 'normal' };
  }

  // Calculate time since conversation started vs expected time based on baselines
  const firstMessage = convo.messages[convo.messages.length - 1];
  if (!firstMessage) {
    return { velocityScore: 0.5, velocityLabel: 'normal' };
  }

  const elapsed = (Date.now() - firstMessage.timestamp.getTime()) / 1000;
  const baseline = baselineMap.get(currentStage);

  if (!baseline || baseline === 0) {
    return { velocityScore: 0.5, velocityLabel: 'normal' };
  }

  // Velocity score: ratio of baseline to actual (higher = faster than baseline)
  // A score > 1 means this conversation is progressing faster than booked average
  const ratio = baseline / Math.max(elapsed, 1);
  const normalizedScore = Math.min(Math.max(ratio, 0), 1);

  let velocityLabel: 'fast' | 'normal' | 'slow';
  if (normalizedScore > 0.7) {
    velocityLabel = 'fast';
  } else if (normalizedScore < 0.3) {
    velocityLabel = 'slow';
  } else {
    velocityLabel = 'normal';
  }

  return {
    velocityScore: parseFloat(normalizedScore.toFixed(4)),
    velocityLabel
  };
}
