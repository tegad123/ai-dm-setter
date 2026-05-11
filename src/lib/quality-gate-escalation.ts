import { Prisma } from '@prisma/client';

export const FAILED_QUALITY_GATE_STATUS = 'FAILED_QUALITY_GATE' as const;

export const QUALITY_GATE_FAILURE_REASON =
  'AI generation failed quality gate after retries, manual response required';

export const QUALITY_GATE_FAILURE_LAST_ERROR = `${FAILED_QUALITY_GATE_STATUS}: ${QUALITY_GATE_FAILURE_REASON}`;

export interface QualityGateFailureResultLike {
  reply?: string | null;
  messages?: string[] | null;
  stage?: string | null;
  subStage?: string | null;
  stageConfidence?: number | null;
  sentimentScore?: number | null;
  suggestedTag?: string | null;
  suggestedTags?: string[] | null;
  suggestedDelay?: number | null;
  systemPromptVersion?: string | null;
  suggestionId?: string | null;
  qualityGateTerminalFailure?: boolean | null;
  qualityGateFailureReason?: string | null;
  qualityGateHardFails?: string[] | null;
  qualityGateAttempts?: number | null;
  qualityScore?: number | null;
}

export function isTerminalQualityGateResult(
  result: QualityGateFailureResultLike | null | undefined
): boolean {
  return result?.qualityGateTerminalFailure === true;
}

export function buildQualityGateGeneratedResult(
  result: QualityGateFailureResultLike
): Prisma.InputJsonValue {
  const messages =
    Array.isArray(result.messages) && result.messages.length > 0
      ? result.messages.filter(
          (message): message is string =>
            typeof message === 'string' && message.trim().length > 0
        )
      : [];
  const reply =
    typeof result.reply === 'string' && result.reply.trim().length > 0
      ? result.reply
      : (messages[0] ?? '');

  return {
    reply,
    messages: messages.length > 0 ? messages : reply ? [reply] : [],
    stage: result.stage ?? 'UNKNOWN',
    subStage: result.subStage ?? null,
    stageConfidence: result.stageConfidence ?? result.qualityScore ?? 0,
    sentimentScore: result.sentimentScore ?? 0,
    suggestedTag: result.suggestedTag ?? 'NEUTRAL',
    suggestedTags: result.suggestedTags ?? [],
    suggestedDelay: result.suggestedDelay ?? 0,
    systemPromptVersion: result.systemPromptVersion ?? 'quality-gate-failed',
    suggestionId: result.suggestionId ?? null,
    qualityGateTerminalFailure: true,
    qualityGateFailureReason:
      result.qualityGateFailureReason ?? QUALITY_GATE_FAILURE_REASON,
    qualityGateHardFails: result.qualityGateHardFails ?? [],
    qualityGateAttempts: result.qualityGateAttempts ?? null
  };
}

export class QualityGateEscalationError extends Error {
  readonly code = FAILED_QUALITY_GATE_STATUS;
  readonly conversationId?: string;
  readonly accountId?: string;
  readonly suggestionId: string | null;
  readonly generatedResult?: Prisma.InputJsonValue;
  readonly hardFails: string[];
  readonly awaitingSince: Date | null;

  constructor(input: {
    conversationId?: string;
    accountId?: string;
    suggestionId?: string | null;
    generatedResult?: Prisma.InputJsonValue;
    hardFails?: string[] | null;
    awaitingSince?: Date | null;
    message?: string;
  }) {
    super(input.message ?? QUALITY_GATE_FAILURE_LAST_ERROR);
    this.name = 'QualityGateEscalationError';
    this.conversationId = input.conversationId;
    this.accountId = input.accountId;
    this.suggestionId = input.suggestionId ?? null;
    this.generatedResult = input.generatedResult;
    this.hardFails = input.hardFails ?? [];
    this.awaitingSince = input.awaitingSince ?? null;
  }
}

export function isQualityGateEscalationError(
  error: unknown
): error is QualityGateEscalationError {
  return (
    error instanceof QualityGateEscalationError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === FAILED_QUALITY_GATE_STATUS)
  );
}
