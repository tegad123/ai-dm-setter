export const META_STANDARD_MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

export const OUTSIDE_STANDARD_WINDOW_MARKER =
  'skipped:outside_standard_messaging_window';

export interface AutomatedMessageWindowDecision {
  action: 'send_standard' | 'cancel_outside_window';
  latestLeadInboundAt: Date | null;
  ageMs: number | null;
}

/**
 * Automated Convlo messages may use Meta's standard response path only while
 * the lead's 24-hour messaging window is open. HUMAN_AGENT is reserved for a
 * genuine human reply and must never be used to extend an automated cascade.
 */
export function decideAutomatedMessageWindow(params: {
  messages: Array<{ sender: string; timestamp: Date }>;
  now?: Date;
}): AutomatedMessageWindowDecision {
  const now = params.now ?? new Date();
  const latestLeadInboundAt = params.messages.reduce<Date | null>(
    (latest, message) => {
      if (message.sender !== 'LEAD') return latest;
      if (!latest || message.timestamp.getTime() > latest.getTime()) {
        return message.timestamp;
      }
      return latest;
    },
    null
  );

  if (!latestLeadInboundAt) {
    return {
      action: 'cancel_outside_window',
      latestLeadInboundAt: null,
      ageMs: null
    };
  }

  const ageMs = Math.max(0, now.getTime() - latestLeadInboundAt.getTime());
  return {
    action:
      ageMs < META_STANDARD_MESSAGING_WINDOW_MS
        ? 'send_standard'
        : 'cancel_outside_window',
    latestLeadInboundAt,
    ageMs
  };
}

export function assertHumanAgentTagIsOperatorInitiated(params: {
  tag?: 'HUMAN_AGENT';
  operatorInitiated?: boolean;
}): void {
  if (params.tag === 'HUMAN_AGENT' && params.operatorInitiated !== true) {
    throw new Error(
      'HUMAN_AGENT tag is restricted to a genuine operator-initiated reply'
    );
  }
}
