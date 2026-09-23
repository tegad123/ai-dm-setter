import prisma from '@/lib/prisma';
import { Prisma, ScheduledReplyStatus } from '@prisma/client';

export const SCHEDULED_REPLY_TERMINAL_REASONS = {
  DELIVERED: 'DELIVERED',
  DELIVERED_BY_OTHER_PATH: 'DELIVERED_BY_OTHER_PATH',
  SUGGESTION_ONLY: 'SUGGESTION_ONLY',
  NEAR_DUPLICATE_ANSWERED: 'NEAR_DUPLICATE_ANSWERED',
  VERBATIM_REPEAT: 'VERBATIM_REPEAT',
  SUPERSEDED_NEWER_INBOUND: 'SUPERSEDED_NEWER_INBOUND',
  SUPERSEDED_PENDING_REPLY: 'SUPERSEDED_PENDING_REPLY',
  AI_PAUSED: 'AI_PAUSED',
  HUMAN_TAKEOVER: 'HUMAN_TAKEOVER',
  CONVERSATION_RESET: 'CONVERSATION_RESET',
  MANYCHAT_OUTBOUND_ECHO: 'MANYCHAT_OUTBOUND_ECHO',
  DISTRESS_HOLD: 'DISTRESS_HOLD',
  SCHEDULING_CONFLICT_HOLD: 'SCHEDULING_CONFLICT_HOLD',
  NO_TRAINING_HOLD: 'NO_TRAINING_HOLD',
  TYPEFORM_SCREENED_OUT: 'TYPEFORM_SCREENED_OUT',
  QUALITY_GATE_HOLD: 'QUALITY_GATE_HOLD',
  OUTSIDE_MESSAGING_WINDOW: 'OUTSIDE_MESSAGING_WINDOW',
  META_PERMANENT_FAILURE: 'META_PERMANENT_FAILURE',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  PROCESSING_NO_DELIVERY: 'PROCESSING_NO_DELIVERY'
} as const;

export type ScheduledReplyTerminalReason =
  (typeof SCHEDULED_REPLY_TERMINAL_REASONS)[keyof typeof SCHEDULED_REPLY_TERMINAL_REASONS];

export type ScheduledReplyTerminalStatus = Extract<
  ScheduledReplyStatus,
  'SENT' | 'CANCELLED' | 'FAILED' | 'FAILED_QUALITY_GATE'
>;

export function terminalScheduledReplyData(input: {
  status: ScheduledReplyTerminalStatus;
  reasonCode: ScheduledReplyTerminalReason;
  terminalAt?: Date;
  lastError?: string | null;
  attempts?: number;
  scheduledFor?: Date;
  generatedResult?: Prisma.InputJsonValue;
}): Prisma.ScheduledReplyUpdateManyMutationInput {
  const terminalAt = input.terminalAt ?? new Date();
  return {
    status: input.status,
    terminalReasonCode: input.reasonCode,
    terminalAt,
    processedAt: terminalAt,
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.scheduledFor !== undefined
      ? { scheduledFor: input.scheduledFor }
      : {}),
    ...(input.generatedResult !== undefined
      ? { generatedResult: input.generatedResult }
      : {})
  };
}

export function retryScheduledReplyData(input: {
  attempts?: number;
  scheduledFor?: Date;
  lastError?: string | null;
}): Prisma.ScheduledReplyUpdateManyMutationInput {
  return {
    status: 'PENDING',
    terminalReasonCode: null,
    terminalAt: null,
    processedAt: null,
    ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
    ...(input.scheduledFor !== undefined
      ? { scheduledFor: input.scheduledFor }
      : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {})
  };
}

function selectedBranchAtClaim(
  capturedDataPoints: Prisma.JsonValue
): string | null {
  if (
    !capturedDataPoints ||
    typeof capturedDataPoints !== 'object' ||
    Array.isArray(capturedDataPoints)
  ) {
    return null;
  }
  const points = capturedDataPoints as Record<string, unknown>;
  const history = points.branchHistory;
  if (!Array.isArray(history)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const label = (event as Record<string, unknown>).selectedBranchLabel;
    if (typeof label === 'string' && label.trim()) return label.trim();
  }
  return null;
}

export interface ScheduledReplyClaimSnapshot {
  claimedAt: string;
  conversationUpdatedAt: string;
  latestLeadMessageId: string | null;
  latestLeadMessageAt: string | null;
  currentScriptStep: number;
  systemStage: string | null;
  selectedBranchLabel: string | null;
}

export function buildScheduledReplyClaimSnapshot(input: {
  claimedAt: Date;
  conversationUpdatedAt: Date;
  latestLeadMessageId: string | null;
  latestLeadMessageAt: Date | null;
  currentScriptStep: number;
  systemStage: string | null;
  capturedDataPoints: Prisma.JsonValue;
}): ScheduledReplyClaimSnapshot {
  return {
    claimedAt: input.claimedAt.toISOString(),
    conversationUpdatedAt: input.conversationUpdatedAt.toISOString(),
    latestLeadMessageId: input.latestLeadMessageId,
    latestLeadMessageAt: input.latestLeadMessageAt?.toISOString() ?? null,
    currentScriptStep: input.currentScriptStep,
    systemStage: input.systemStage,
    selectedBranchLabel: selectedBranchAtClaim(input.capturedDataPoints)
  };
}

/** Atomically claims one row and records the conversation state it claimed. */
export async function claimScheduledReply(input: {
  id: string;
  conversationId: string;
  fromStatuses?: Array<'PENDING' | 'FAILED'>;
}): Promise<boolean> {
  const claimedAt = new Date();
  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      updatedAt: true,
      currentScriptStep: true,
      systemStage: true,
      capturedDataPoints: true,
      messages: {
        where: { sender: 'LEAD', deletedAt: null },
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { id: true, timestamp: true }
      }
    }
  });
  if (!conversation) return false;

  const latestLead = conversation.messages[0] ?? null;
  const snapshot = buildScheduledReplyClaimSnapshot({
    claimedAt,
    conversationUpdatedAt: conversation.updatedAt,
    latestLeadMessageId: latestLead?.id ?? null,
    latestLeadMessageAt: latestLead?.timestamp ?? null,
    currentScriptStep: conversation.currentScriptStep,
    systemStage: conversation.systemStage,
    capturedDataPoints: conversation.capturedDataPoints
  });
  const claimed = await prisma.scheduledReply.updateMany({
    where: {
      id: input.id,
      status: { in: input.fromStatuses ?? ['PENDING'] }
    },
    data: {
      status: 'PROCESSING',
      claimSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      terminalReasonCode: null,
      terminalAt: null,
      processedAt: null
    }
  });
  return claimed.count === 1;
}
