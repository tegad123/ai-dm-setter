// ─── Optimization Engine — Phase 3 Self-Optimizing Layer ────────────────────
// Analyzes message effectiveness per stage, generates actionable optimization
// suggestions (PROMOTE, DEMOTE, STAGE_IMPROVEMENT, VELOCITY_INSIGHT), and
// manages the apply/revert lifecycle for optimization suggestions.

import prisma from '@/lib/prisma';

// ─── Types ──────────────────────────────────────────────

export type OptimizationSuggestionType =
  | 'PROMOTE'
  | 'DEMOTE'
  | 'STAGE_IMPROVEMENT'
  | 'VELOCITY_INSIGHT';

export interface OptimizationResult {
  type: OptimizationSuggestionType;
  reasoning: string;
  supportingData: Record<string, unknown>;
}

interface StageStats {
  stage: string;
  totalMessages: number;
  gotResponseCount: number;
  responseRate: number;
}

interface StageVelocity {
  stage: string;
  avgSecondsBooked: number;
  avgSecondsGhosted: number;
  bookedCount: number;
  ghostedCount: number;
}

// ─── Constants ──────────────────────────────────────────

const COLD_START_MINIMUM = 100;
const PROMOTE_THRESHOLD = 1.5; // 1.5x average response rate
const DEMOTE_THRESHOLD = 0.5; // 0.5x average response rate
const PROMOTE_MIN_SAMPLE = 30;
const DEMOTE_MIN_SAMPLE = 30;
const STAGE_IMPROVEMENT_MIN_SAMPLE = 50;
const DROPOFF_THRESHOLD = 0.4; // 40% drop-off
const VELOCITY_MIN_SAMPLE = 30;
const VELOCITY_MULTIPLIER = 2; // 2x faster

// ─── 1. Generate Optimizations ───────────────────────────

/**
 * Analyze message effectiveness per stage and generate optimization suggestions.
 * Gates on cold start: requires at least 100 resolved conversations.
 */
export async function generateOptimizations(
  accountId: string
): Promise<OptimizationResult[]> {
  // Cold start gate: require minimum resolved conversations
  const resolvedCount = await prisma.conversation.count({
    where: {
      lead: { accountId },
      outcome: { not: 'ONGOING' }
    }
  });

  if (resolvedCount < COLD_START_MINIMUM) {
    return [];
  }

  const suggestions: OptimizationResult[] = [];

  // Gather stage-level stats and velocity data in parallel
  const [stageStats, stageVelocities] = await Promise.all([
    getStageStats(accountId),
    getStageVelocities(accountId)
  ]);

  // Calculate overall average response rate
  const totalMessages = stageStats.reduce((sum, s) => sum + s.totalMessages, 0);
  const totalResponses = stageStats.reduce(
    (sum, s) => sum + s.gotResponseCount,
    0
  );
  const avgResponseRate =
    totalMessages > 0 ? totalResponses / totalMessages : 0;

  // ── PROMOTE: stages with response rate > 1.5x average ──
  for (const stat of stageStats) {
    if (
      stat.totalMessages >= PROMOTE_MIN_SAMPLE &&
      avgResponseRate > 0 &&
      stat.responseRate > PROMOTE_THRESHOLD * avgResponseRate
    ) {
      suggestions.push({
        type: 'PROMOTE',
        reasoning: `Stage "${stat.stage}" has a ${(stat.responseRate * 100).toFixed(1)}% response rate, which is ${(stat.responseRate / avgResponseRate).toFixed(1)}x the average (${(avgResponseRate * 100).toFixed(1)}%). Consider using this messaging approach in other stages.`,
        supportingData: {
          stage: stat.stage,
          responseRate: stat.responseRate,
          averageResponseRate: avgResponseRate,
          multiplier: stat.responseRate / avgResponseRate,
          sampleSize: stat.totalMessages
        }
      });
    }

    // ── DEMOTE: stages with response rate < 0.5x average ──
    if (
      stat.totalMessages >= DEMOTE_MIN_SAMPLE &&
      avgResponseRate > 0 &&
      stat.responseRate < DEMOTE_THRESHOLD * avgResponseRate
    ) {
      suggestions.push({
        type: 'DEMOTE',
        reasoning: `Stage "${stat.stage}" has a ${(stat.responseRate * 100).toFixed(1)}% response rate, only ${(stat.responseRate / avgResponseRate).toFixed(1)}x the average (${(avgResponseRate * 100).toFixed(1)}%). This stage needs improvement or replacement.`,
        supportingData: {
          stage: stat.stage,
          responseRate: stat.responseRate,
          averageResponseRate: avgResponseRate,
          multiplier: stat.responseRate / avgResponseRate,
          sampleSize: stat.totalMessages
        }
      });
    }
  }

  // ── STAGE_IMPROVEMENT: drop-off > 40% between consecutive stages ──
  const orderedStages = stageStats
    .filter((s) => s.totalMessages >= STAGE_IMPROVEMENT_MIN_SAMPLE)
    .sort((a, b) => b.totalMessages - a.totalMessages); // Rough ordering by volume

  for (let i = 0; i < orderedStages.length - 1; i++) {
    const current = orderedStages[i];
    const next = orderedStages[i + 1];

    if (current.totalMessages > 0 && next.totalMessages > 0) {
      const dropOff = 1 - next.totalMessages / current.totalMessages;
      if (dropOff > DROPOFF_THRESHOLD) {
        suggestions.push({
          type: 'STAGE_IMPROVEMENT',
          reasoning: `${(dropOff * 100).toFixed(0)}% of leads drop off between "${current.stage}" (${current.totalMessages} messages) and "${next.stage}" (${next.totalMessages} messages). This transition needs optimization.`,
          supportingData: {
            fromStage: current.stage,
            toStage: next.stage,
            dropOffRate: dropOff,
            fromCount: current.totalMessages,
            toCount: next.totalMessages
          }
        });
      }
    }
  }

  // ── VELOCITY_INSIGHT: booked leads move 2x+ faster than ghosted ──
  for (const vel of stageVelocities) {
    if (
      vel.bookedCount >= VELOCITY_MIN_SAMPLE &&
      vel.ghostedCount >= VELOCITY_MIN_SAMPLE &&
      vel.avgSecondsGhosted > 0 &&
      vel.avgSecondsBooked > 0
    ) {
      const speedMultiplier = vel.avgSecondsGhosted / vel.avgSecondsBooked;
      if (speedMultiplier >= VELOCITY_MULTIPLIER) {
        suggestions.push({
          type: 'VELOCITY_INSIGHT',
          reasoning: `Leads that eventually book move through "${vel.stage}" ${speedMultiplier.toFixed(1)}x faster than ghosted leads (${formatDuration(vel.avgSecondsBooked)} vs ${formatDuration(vel.avgSecondsGhosted)}). Quick progression at this stage is a strong booking signal.`,
          supportingData: {
            stage: vel.stage,
            avgSecondsBooked: vel.avgSecondsBooked,
            avgSecondsGhosted: vel.avgSecondsGhosted,
            speedMultiplier,
            bookedSampleSize: vel.bookedCount,
            ghostedSampleSize: vel.ghostedCount
          }
        });
      }
    }
  }

  // Persist suggestions to the database
  if (suggestions.length > 0) {
    for (const s of suggestions) {
      await prisma.optimizationSuggestion.create({
        data: {
          accountId,
          type: 'MESSAGE_VARIATION',
          reasoning: `[${s.type}] ${s.reasoning}`,
          supportingData: s.supportingData as object,
          status: 'PENDING_APPROVAL'
        }
      });
    }
  }

  return suggestions;
}

// ─── 2. Apply Optimization ───────────────────────────────

/**
 * Mark an optimization suggestion as APPLIED and create a new PromptVersion record.
 */
export async function applyOptimization(
  accountId: string,
  optimizationId: string
): Promise<void> {
  const suggestion = await prisma.optimizationSuggestion.findFirst({
    where: { id: optimizationId, accountId }
  });

  if (!suggestion) {
    throw new Error(`Optimization suggestion ${optimizationId} not found`);
  }

  // Mark as applied
  await prisma.optimizationSuggestion.update({
    where: { id: optimizationId },
    data: {
      status: 'APPLIED',
      resolvedAt: new Date()
    }
  });

  // Find the latest prompt version to increment from
  const latestVersion = await prisma.promptVersion.findFirst({
    where: { accountId },
    orderBy: { createdAt: 'desc' }
  });

  let nextVersion: string;
  if (latestVersion?.version) {
    const parts = latestVersion.version.split('.').map(Number);
    // Minor version bump for optimization changes
    parts[1] = (parts[1] || 0) + 1;
    parts[2] = 0;
    nextVersion = parts.join('.');
  } else {
    nextVersion = '1.1.0';
  }

  // Create a new PromptVersion linked to this optimization
  await prisma.promptVersion.create({
    data: {
      accountId,
      version: nextVersion,
      promptHash: `opt-${optimizationId.slice(0, 12)}`,
      description: `Applied optimization: ${suggestion.reasoning.slice(0, 200)}`,
      changeType: 'MINOR',
      appliedBy: 'STAGING_AUTO',
      optimizationId
    }
  });
}

// ─── 3. Revert Optimization ─────────────────────────────

/**
 * Mark an optimization suggestion as REVERTED.
 */
export async function revertOptimization(
  accountId: string,
  optimizationId: string
): Promise<void> {
  const suggestion = await prisma.optimizationSuggestion.findFirst({
    where: { id: optimizationId, accountId }
  });

  if (!suggestion) {
    throw new Error(`Optimization suggestion ${optimizationId} not found`);
  }

  await prisma.optimizationSuggestion.update({
    where: { id: optimizationId },
    data: {
      status: 'REVERTED',
      resolvedAt: new Date()
    }
  });
}

// ─── Helper: Stage Response Statistics ───────────────────

async function getStageStats(accountId: string): Promise<StageStats[]> {
  // Use raw SQL since gotResponse is a Boolean field (can't use _sum on booleans).
  // Count total AI messages and those where gotResponse = true, grouped by stage.
  const rows = await prisma.$queryRaw<
    Array<{ stage: string; total_messages: bigint; got_response_count: bigint }>
  >`
    SELECT
      m."stage",
      COUNT(m."id") AS total_messages,
      COUNT(CASE WHEN m."gotResponse" = true THEN 1 END) AS got_response_count
    FROM "Message" m
    JOIN "Conversation" c ON c."id" = m."conversationId"
    JOIN "Lead" l ON l."id" = c."leadId"
    WHERE m."sender" = 'AI'
      AND m."stage" IS NOT NULL
      AND l."accountId" = ${accountId}
    GROUP BY m."stage"
  `;

  return rows.map((row) => {
    const total = Number(row.total_messages);
    const responses = Number(row.got_response_count);
    return {
      stage: row.stage,
      totalMessages: total,
      gotResponseCount: responses,
      responseRate: total > 0 ? responses / total : 0
    };
  });
}

// ─── Helper: Stage Velocity (Booked vs Ghosted) ─────────

async function getStageVelocities(accountId: string): Promise<StageVelocity[]> {
  // Get average response time per stage, split by outcome
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

  const ghostedMessages = await prisma.message.groupBy({
    by: ['stage'],
    where: {
      sender: 'AI',
      stage: { not: null },
      responseTimeSeconds: { not: null },
      conversation: {
        lead: { accountId },
        outcome: 'LEFT_ON_READ'
      }
    },
    _avg: { responseTimeSeconds: true },
    _count: { id: true }
  });

  // Build lookup maps for ghosted data by stage
  const ghostedAvgMap = new Map<string, number>();
  const ghostedCountMap = new Map<string, number>();
  for (const g of ghostedMessages) {
    if (g.stage) {
      ghostedAvgMap.set(g.stage, g._avg.responseTimeSeconds ?? 0);
      ghostedCountMap.set(g.stage, g._count.id);
    }
  }

  return bookedMessages
    .filter((b): b is typeof b & { stage: string } => b.stage !== null)
    .map((b) => ({
      stage: b.stage,
      avgSecondsBooked: b._avg.responseTimeSeconds ?? 0,
      avgSecondsGhosted: ghostedAvgMap.get(b.stage) ?? 0,
      bookedCount: b._count.id,
      ghostedCount: ghostedCountMap.get(b.stage) ?? 0
    }))
    .filter((v) => v.avgSecondsBooked > 0 && v.avgSecondsGhosted > 0);
}

// ─── Helper: Duration Formatting ─────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}
