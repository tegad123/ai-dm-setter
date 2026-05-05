import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveAndUpgradeInstagramNumericId } from '@/lib/manychat-resolve-ig-id';

// Sequence-completion handoff. Daniel's ManyChat flow fires this as the
// FINAL action (after the Smart Delay + Condition) to signal "sequence
// done, AI take over." The `manychat-handoff` endpoint runs EARLY when
// the lead clicks the opener button — by design it doesn't flip the
// AI-eligibility flags because the operator's automation is still
// running. This endpoint flips them.
//
// If the operator forgets to wire this final step, the time-based
// fallback in silent-stop-recovery.ts kicks in within 5 min and flips
// the same flags. Either path lands in the same state.

export const manyChatCompleteSchema = z.object({
  // Same coercion behavior as the handoff endpoint — ManyChat's variable
  // picker emits numeric IDs as JSON numbers.
  instagramUserId: z.coerce.string().min(1),
  instagramUsername: z.string().optional(),
  manyChatSubscriberId: z.coerce.string().optional()
});

export type ManyChatCompletePayload = z.infer<typeof manyChatCompleteSchema>;

export interface ManyChatCompleteResult {
  ok: true;
  conversationId: string;
  alreadyHandedOff: boolean;
}

export class ManyChatCompleteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManyChatCompleteError';
    this.status = status;
  }
}

function cleanInstagramUsername(username: string): string {
  return username.replace(/^@+/, '').trim();
}

export async function processManyChatComplete(params: {
  webhookKey: string | null;
  payload: unknown;
}): Promise<ManyChatCompleteResult> {
  const webhookKey = params.webhookKey?.trim();
  if (!webhookKey) {
    throw new ManyChatCompleteError('Missing X-QualifyDMs-Key', 401);
  }

  const account = await prisma.account.findUnique({
    where: { manyChatWebhookKey: webhookKey },
    select: { id: true }
  });
  if (!account) {
    throw new ManyChatCompleteError('Invalid webhook key', 401);
  }

  const parsed = manyChatCompleteSchema.safeParse(params.payload);
  if (!parsed.success) {
    throw new ManyChatCompleteError('Invalid ManyChat payload', 400);
  }
  const payload = parsed.data;
  const handle = payload.instagramUsername
    ? cleanInstagramUsername(payload.instagramUsername)
    : '';

  // Mirror the lookup pattern from manychat-handoff.ts so legacy leads
  // (where the IG numeric ID was never captured and `platformUserId`
  // holds the handle) still match.
  const lead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      platform: 'INSTAGRAM',
      OR: [
        { platformUserId: payload.instagramUserId },
        ...(handle
          ? [{ handle: { equals: handle, mode: 'insensitive' as const } }]
          : [])
      ]
    },
    include: { conversation: true }
  });

  if (!lead?.conversation) {
    throw new ManyChatCompleteError('lead_not_found', 404);
  }

  const conversation = lead.conversation;

  // Resolve & upgrade `Lead.platformUserId` to the IG numeric user ID
  // (`ig_id`). ManyChat's variable picker doesn't expose `ig_id` for
  // IG accounts — `{{contact.id}}` returns the ManyChat-internal
  // subscriber ID. The shared resolver calls ManyChat's REST API
  // (`/fb/subscriber/getInfo`) to translate subscriber ID → ig_id and
  // updates the lead in one shot. Without this, the silent-stop
  // heartbeat's `hasUsablePlatformRecipient` rejects the lead and the
  // AI reply never ships.
  await resolveAndUpgradeInstagramNumericId({
    accountId: account.id,
    leadId: lead.id,
    existingPlatformUserId: lead.platformUserId,
    incomingInstagramUserId: payload.instagramUserId,
    manyChatSubscriberId: payload.manyChatSubscriberId
  });

  // Idempotent: a re-fire after the operator already handed off (or
  // after the time-based fallback already flipped) returns success
  // with a flag so ManyChat-side debugging can see the state.
  if (conversation.aiActive && conversation.awaitingAiResponse) {
    return {
      ok: true,
      conversationId: conversation.id,
      alreadyHandedOff: true
    };
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      aiActive: true,
      awaitingAiResponse: true,
      awaitingSince: new Date()
    }
  });

  return {
    ok: true,
    conversationId: conversation.id,
    alreadyHandedOff: false
  };
}
