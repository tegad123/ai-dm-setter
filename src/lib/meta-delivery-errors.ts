export const SCHEDULED_REPLY_MAX_ATTEMPTS = 5;

const RETRY_DELAYS_MS_BY_NEXT_ATTEMPT: Record<number, number> = {
  2: 30 * 1000,
  3: 2 * 60 * 1000,
  4: 10 * 60 * 1000,
  5: 30 * 60 * 1000
};

const PERMANENT_META_CODES = new Set([10, 190, 200]);
const TRANSIENT_META_CODES = new Set([2]);

export interface MetaDeliveryErrorInfo {
  rawMessage: string;
  httpStatus: number | null;
  metaCode: number | null;
  metaType: string | null;
  isTransientFlag: boolean | null;
  retryable: boolean;
  permanent: boolean;
  meaning: string;
}

export function getScheduledReplyRetryDelayMs(
  nextAttempt: number
): number | null {
  return RETRY_DELAYS_MS_BY_NEXT_ATTEMPT[nextAttempt] ?? null;
}

export function getScheduledReplyRetryAt(
  failedAttempt: number,
  now = new Date()
): Date | null {
  const nextAttempt = failedAttempt + 1;
  const delayMs = getScheduledReplyRetryDelayMs(nextAttempt);
  if (delayMs === null) return null;
  return new Date(now.getTime() + delayMs);
}

export function classifyMetaDeliveryError(
  error: unknown
): MetaDeliveryErrorInfo {
  const rawMessage =
    error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const httpStatus = extractHttpStatus(rawMessage);
  const parsed = extractMetaErrorPayload(rawMessage);
  const metaCode = parsed?.code ?? extractMetaCode(rawMessage);
  const metaType = parsed?.type ?? extractMetaType(rawMessage);
  const isTransientFlag =
    typeof parsed?.is_transient === 'boolean'
      ? parsed.is_transient
      : extractTransientFlag(rawMessage);

  const permanent =
    typeof metaCode === 'number' && PERMANENT_META_CODES.has(metaCode);
  const transient =
    (typeof metaCode === 'number' && TRANSIENT_META_CODES.has(metaCode)) ||
    isTransientFlag === true ||
    (typeof httpStatus === 'number' && httpStatus >= 500);

  const retryable = !permanent && transient;
  return {
    rawMessage,
    httpStatus,
    metaCode,
    metaType,
    isTransientFlag,
    retryable,
    permanent,
    meaning: describeMetaDeliveryError({
      httpStatus,
      metaCode,
      metaType,
      isTransientFlag,
      permanent,
      transient
    })
  };
}

function describeMetaDeliveryError(params: {
  httpStatus: number | null;
  metaCode: number | null;
  metaType: string | null;
  isTransientFlag: boolean | null;
  permanent: boolean;
  transient: boolean;
}): string {
  if (params.metaCode === 190) {
    return 'Instagram token is invalid or expired. Reconnect Instagram before retrying.';
  }
  if (params.metaCode === 10 || params.metaCode === 200) {
    return 'Instagram permissions are missing or revoked. Reconnect Instagram and confirm messaging permissions.';
  }
  if (params.metaCode === 2 || params.httpStatus === 500) {
    return 'Meta returned a transient server error. QualifyDMs will retry automatically.';
  }
  if (params.permanent) {
    return 'Meta rejected delivery permanently. Operator action is required.';
  }
  if (params.transient) {
    return 'Meta marked this as temporary. QualifyDMs will retry automatically.';
  }
  if (
    typeof params.httpStatus === 'number' &&
    params.httpStatus >= 400 &&
    params.httpStatus < 500
  ) {
    return 'Meta returned a non-retryable client error. Operator action is required.';
  }
  return 'Delivery failed without a retryable Meta signal. Operator action is required.';
}

function extractHttpStatus(message: string): number | null {
  const match =
    message.match(/\bfailed:\s*(\d{3})\b/i) ??
    message.match(/\bHTTP\s*(\d{3})\b/i) ??
    message.match(/\bstatus\s*[:=]\s*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function extractMetaCode(message: string): number | null {
  const match = message.match(/["']?code["']?\s*[:=]\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function extractMetaType(message: string): string | null {
  const match = message.match(/["']?type["']?\s*[:=]\s*["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

function extractTransientFlag(message: string): boolean | null {
  const match = message.match(/["']?is_transient["']?\s*[:=]\s*(true|false)/i);
  if (!match) return null;
  return match[1].toLowerCase() === 'true';
}

function extractMetaErrorPayload(
  message: string
): { code?: number; type?: string; is_transient?: boolean } | null {
  const firstBrace = message.indexOf('{');
  if (firstBrace < 0) return null;
  const jsonText = message.slice(firstBrace);
  try {
    const parsed = JSON.parse(jsonText) as {
      error?: { code?: number; type?: string; is_transient?: boolean };
    };
    return parsed.error ?? null;
  } catch {
    return null;
  }
}
