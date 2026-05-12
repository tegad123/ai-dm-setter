// Payload builders. Two shapes:
//   1. IncomingMessageParams — the post-parse shape consumed by
//      processIncomingMessage in src/lib/webhook-processor.ts. This is
//      what invoke-pipeline.ts feeds into prod code.
//   2. Raw Instagram webhook JSON — the pre-parse shape the
//      /api/webhooks/instagram route receives from Meta. Built here for
//      shape verification and future tests that exercise the route
//      handler itself.
//
// ManyChat support is a stub — the IG path is the primary inbound
// channel today.

export interface BuildInstagramInput {
  accountId: string;
  platformUserId: string;
  messageText: string;
  senderName?: string;
  senderHandle?: string;
  platformMessageId?: string;
}

import type { IncomingMessageParams } from '../../../src/lib/webhook-processor';

export function buildIncomingMessageParams(
  input: BuildInstagramInput
): IncomingMessageParams {
  return {
    accountId: input.accountId,
    platformUserId: input.platformUserId,
    platform: 'INSTAGRAM',
    senderName:
      input.senderName ?? `Test Lead ${input.platformUserId.slice(-6)}`,
    senderHandle: input.senderHandle ?? input.platformUserId,
    messageText: input.messageText,
    triggerType: 'DM',
    triggerSource: 'persona-harness',
    platformMessageId:
      input.platformMessageId ??
      `mid_test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  };
}

export interface InstagramWebhookEvent {
  object: 'instagram';
  entry: Array<{
    id: string;
    time: number;
    messaging: Array<{
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message: {
        mid: string;
        text?: string;
        is_echo?: boolean;
      };
    }>;
  }>;
}

export interface BuildRawInstagramInput extends BuildInstagramInput {
  accountIgId: string;
}

export function buildInstagramWebhookPayload(
  input: BuildRawInstagramInput
): InstagramWebhookEvent {
  const now = Date.now();
  return {
    object: 'instagram',
    entry: [
      {
        id: input.accountIgId,
        time: now,
        messaging: [
          {
            sender: { id: input.platformUserId },
            recipient: { id: input.accountIgId },
            timestamp: now,
            message: {
              mid:
                input.platformMessageId ??
                `mid_test_${now}_${Math.random().toString(36).slice(2, 10)}`,
              text: input.messageText
            }
          }
        ]
      }
    ]
  };
}

export interface ManychatPayload {
  subscriber: { id: string; first_name?: string; last_name?: string };
  last_input_text: string;
  triggered_at: string;
}

export function buildManychatWebhookPayload(input: {
  platformUserId: string;
  messageText: string;
  firstName?: string;
}): ManychatPayload {
  return {
    subscriber: {
      id: input.platformUserId,
      first_name: input.firstName ?? 'Test',
      last_name: 'Lead'
    },
    last_input_text: input.messageText,
    triggered_at: new Date().toISOString()
  };
}
