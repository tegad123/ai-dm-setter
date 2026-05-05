import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { extractInstagramNumericId, findSubscriberById } from '@/lib/manychat';

// Shared helper for the three ManyChat webhook endpoints (handoff,
// message, complete). When ManyChat sends `{{contact.id}}` it gives
// us the ManyChat-internal subscriber ID (typically 9-11 digits), not
// the IG numeric ID Meta's Send API requires. We call ManyChat's REST
// API to resolve `ig_id` and upgrade `Lead.platformUserId` so the
// silent-stop heartbeat can actually deliver an AI reply to this lead.
//
// Idempotent: a no-op when the lead already has a usable numeric ID,
// when the input value already looks like an IG numeric ID, or when
// the API lookup fails (we just leave whatever's stored — better than
// blowing up the webhook over a soft dependency).

const NUMERIC_IG_ID = /^\d{12,}$/;

export async function resolveAndUpgradeInstagramNumericId(params: {
  accountId: string;
  leadId: string;
  existingPlatformUserId: string | null;
  // The value sent in the webhook body — could be a real IG numeric
  // ID, a ManyChat subscriber ID, or even a handle, depending on how
  // the operator wired the External Request body.
  incomingInstagramUserId: string | null | undefined;
  // Always-numeric ManyChat subscriber ID — the handoff webhook always
  // includes it as a separate field; the message/complete webhooks
  // accept it optionally.
  manyChatSubscriberId: string | null | undefined;
}): Promise<string | null> {
  const existingIsNumeric = NUMERIC_IG_ID.test(
    (params.existingPlatformUserId || '').trim()
  );
  const incomingIsNumeric = NUMERIC_IG_ID.test(
    (params.incomingInstagramUserId || '').trim()
  );

  // Already in the right shape — nothing to do.
  if (existingIsNumeric) return params.existingPlatformUserId;

  // Operator wired a real IG numeric ID into the body — use it
  // directly without an API hop.
  if (incomingIsNumeric && params.incomingInstagramUserId) {
    await prisma.lead.update({
      where: { id: params.leadId },
      data: { platformUserId: params.incomingInstagramUserId }
    });
    return params.incomingInstagramUserId;
  }

  // Pick whichever input looks most like a ManyChat subscriber ID for
  // the API lookup. Prefer the explicit `manyChatSubscriberId` field
  // (always present on the handoff payload). Fall back to the
  // `instagramUserId` value, which for IG-only flows is also the
  // subscriber ID per ManyChat's `{{contact.id}}` semantics.
  const lookupId =
    (params.manyChatSubscriberId && params.manyChatSubscriberId.trim()) ||
    (params.incomingInstagramUserId &&
    /^\d+$/.test(params.incomingInstagramUserId.trim())
      ? params.incomingInstagramUserId.trim()
      : null);
  if (!lookupId) return params.existingPlatformUserId;

  const creds = await getCredentials(params.accountId, 'MANYCHAT');
  if (!creds?.apiKey || typeof creds.apiKey !== 'string') {
    return params.existingPlatformUserId;
  }

  const sub = await findSubscriberById(creds.apiKey, lookupId);
  const igNumeric = extractInstagramNumericId(sub);
  if (!igNumeric) return params.existingPlatformUserId;

  await prisma.lead.update({
    where: { id: params.leadId },
    data: { platformUserId: igNumeric }
  });
  console.log(
    `[manychat] resolved ig_id=${igNumeric} for lead ${params.leadId} via subscriber ${lookupId} (was platformUserId=${params.existingPlatformUserId ?? 'null'})`
  );
  return igNumeric;
}
