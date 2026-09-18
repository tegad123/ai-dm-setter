import crypto from 'crypto';
import { getMetaAccessToken } from '@/lib/credential-store';
import { EgressBlockedError } from '@/lib/state-machine/can-send';
import { assertHumanAgentTagIsOperatorInitiated } from '@/lib/meta-messaging-window';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// ---------------------------------------------------------------------------
// Webhook Signature Verification
// ---------------------------------------------------------------------------

/**
 * Verify the X-Hub-Signature-256 header from Meta's webhook payload.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string
): boolean {
  const appSecret =
    process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;
  if (!appSecret) {
    console.warn('[facebook] No META_APP_SECRET set, cannot verify signature');
    return false;
  }

  const expectedSig =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSig)
  );
}

// ---------------------------------------------------------------------------
// Send Message (Facebook Messenger)
// ---------------------------------------------------------------------------

/**
 * Options for outbound sends. Automated messages use Meta's normal response
 * path inside the standard messaging window. HUMAN_AGENT is reserved for a
 * genuine operator reply and also requires Meta approval; the send choke point
 * rejects any attempt to attach that tag to an automated job.
 */
export interface MetaSendOptions {
  tag?: 'HUMAN_AGENT';
  // Fix D cutover condition 1: true when a human operator initiated this send
  // (manual reply / approved suggestion). At authoritative, canSend lets
  // operator sends through even on a HELD conversation — replying manually IS
  // the resolution of a hold. Crons / webhook-processor pass false (or omit),
  // so automated sends stay gated. Threads to the egress shadow / gate.
  operatorInitiated?: boolean;
  // The conversation this send targets. Passed to the egress gate so it
  // checks THIS conversation's hold state, not a heuristically-guessed one
  // (Test 4 fix — a lead with multiple conversations was mis-resolved).
  conversationId?: string | null;
  // The one F1 distress supportive reply (may pass a HELD_DISTRESS hold when
  // FIX_D_DISTRESS_SUPPORTIVE_EXEMPT=true). See can-send.ts.
  distressSupportive?: boolean;
}

/**
 * Send a message to a Facebook Messenger user via the Graph API.
 */
export async function sendMessage(
  accountId: string,
  recipientId: string,
  messageText: string,
  opts?: MetaSendOptions
): Promise<{ messageId: string }> {
  assertHumanAgentTagIsOperatorInitiated({
    tag: opts?.tag,
    operatorInitiated: opts?.operatorInitiated
  });

  // Fix D Phase 0: shadow-compare the canSend machine at the physical send
  // choke point. Awaited so the write survives serverless teardown; the
  // try/catch keeps it from ever breaking a send. This is the FACEBOOK
  // choke point — daetradez is a FB funnel, so this is where the real
  // traffic flows (the IG hook alone logged almost nothing).
  // Fix D egress gate. In shadow mode this only logs; when
  // FIX_D_CANSEND_AUTHORITATIVE includes FACEBOOK it ENFORCES — a blocked
  // send throws EgressBlockedError and this send is aborted. The gate itself
  // fails open on internal error, so a throw here is a real policy block.
  {
    let gate: { block: boolean; reason?: string; detail?: string } = {
      block: false
    };
    try {
      const { shadowEgressCheck } = await import('@/lib/state-machine/shadow');
      gate = await shadowEgressCheck({
        accountId,
        recipientId,
        messageText,
        platform: 'FACEBOOK',
        conversationId: opts?.conversationId ?? null,
        operatorInitiated: opts?.operatorInitiated ?? false,
        distressSupportive: opts?.distressSupportive ?? false
      });
    } catch {
      // gate infra error must never break a send — treat as allow
      gate = { block: false };
    }
    if (gate.block) {
      throw new EgressBlockedError(
        `Egress gate blocked send: ${gate.reason ?? 'blocked'}${gate.detail ? ` — ${gate.detail}` : ''}`,
        gate.reason ?? 'BLOCKED'
      );
    }
  }

  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured for this account');
  }

  const { getMetaPageId } = await import('@/lib/credential-store');
  const pageId =
    (await getMetaPageId(accountId)) || process.env.FACEBOOK_PAGE_ID;
  if (!pageId) {
    throw new Error('No Facebook Page ID configured for this account');
  }
  const url = `${GRAPH_API_BASE}/${pageId}/messages`;

  // Dev-only harness knob: everything up to here (gate, guards, hold state)
  // has run for real; skip only the Meta call so multi-turn local flows can
  // progress without an open 24h window. Never set in production.
  if (
    process.env.META_SEND_DRY_RUN === 'true' &&
    process.env.NODE_ENV !== 'production'
  ) {
    console.warn(
      `[facebook] META_SEND_DRY_RUN: not calling Meta for ${recipientId}; synthetic message id returned`
    );
    return {
      messageId: `dryrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    };
  }

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(
          opts?.tag === 'HUMAN_AGENT'
            ? {
                recipient: { id: recipientId },
                message: { text: messageText },
                messaging_type: 'MESSAGE_TAG',
                tag: 'HUMAN_AGENT'
              }
            : {
                recipient: { id: recipientId },
                message: { text: messageText },
                messaging_type: 'RESPONSE'
              }
        )
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(
          `Facebook send message failed: ${response.status} ${error}`
        );
      }

      const data = await response.json();
      return { messageId: data.message_id || data.id || '' };
    } catch (err: any) {
      lastError = err;
      console.error(
        `[facebook] Send message attempt ${attempt}/${MAX_RETRIES} failed:`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        await new Promise((r) =>
          setTimeout(r, Math.pow(2, attempt - 1) * 1000)
        );
      }
    }
  }

  throw lastError || new Error('Facebook send message failed after retries');
}

// ---------------------------------------------------------------------------
// Send Audio Message (Facebook Messenger Voice Note)
// ---------------------------------------------------------------------------

/**
 * Send an audio message to a Facebook Messenger user via the Graph API.
 * The audioUrl must be a publicly accessible URL.
 */
export async function sendAudioMessage(
  accountId: string,
  recipientId: string,
  audioUrl: string,
  opts?: {
    operatorInitiated?: boolean;
    conversationId?: string | null;
    distressSupportive?: boolean;
  }
): Promise<{ messageId: string }> {
  // Voice notes must pass the SAME authoritative egress gate as text sends
  // (Tega 2026-08-18: audio previously bypassed it). Block honored outside
  // the fail-open try, same asymmetry as sendMessage.
  {
    let gate: { block: boolean; reason?: string; detail?: string } = {
      block: false
    };
    try {
      const { shadowEgressCheck } = await import('@/lib/state-machine/shadow');
      gate = await shadowEgressCheck({
        accountId,
        recipientId,
        messageText: `[audio] ${audioUrl}`,
        platform: 'FACEBOOK',
        conversationId: opts?.conversationId ?? null,
        operatorInitiated: opts?.operatorInitiated ?? false,
        distressSupportive: opts?.distressSupportive ?? false
      });
    } catch {
      gate = { block: false };
    }
    if (gate.block) {
      throw new EgressBlockedError(
        `Egress gate blocked audio send: ${gate.reason ?? 'blocked'}${gate.detail ? ` — ${gate.detail}` : ''}`,
        gate.reason ?? 'BLOCKED'
      );
    }
  }

  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured for this account');
  }

  const { getMetaPageId } = await import('@/lib/credential-store');
  const pageId =
    (await getMetaPageId(accountId)) || process.env.FACEBOOK_PAGE_ID;
  if (!pageId) {
    throw new Error('No Facebook Page ID configured for this account');
  }
  const url = `${GRAPH_API_BASE}/${pageId}/messages`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'audio',
          payload: { url: audioUrl }
        }
      },
      messaging_type: 'RESPONSE'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Facebook send audio message failed: ${response.status} ${error}`
    );
  }

  const data = await response.json();
  return { messageId: data.message_id || data.id || '' };
}

// ---------------------------------------------------------------------------
// Fetch User Profile
// ---------------------------------------------------------------------------

export interface FBUserProfile {
  id: string;
  name: string;
  profilePicUrl?: string;
}

/**
 * Fetch a Facebook user's profile via the Graph API.
 * Strategy 1: Direct PSID lookup (works when Page Access Token has pages_messaging).
 * Strategy 2: Conversations API — find the participant by ID in the page's
 *             conversation list (more reliable when direct lookup is restricted).
 */
export async function getUserProfile(
  accountId: string,
  userId: string,
  /** The Facebook Page ID from the webhook entry — avoids re-deriving from credentials */
  knownPageId?: string
): Promise<FBUserProfile> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  // Strategy 1: Direct user lookup
  try {
    const url = `${GRAPH_API_BASE}/${userId}?fields=id,name,profile_pic&access_token=${accessToken}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.name) {
        console.log(
          `[facebook] Profile resolved via direct lookup: ${data.name}`
        );
        return {
          id: data.id || userId,
          name: data.name,
          profilePicUrl: data.profile_pic
        };
      }
      // 2xx with no `name` in payload — Meta returned data but without
      // the field. Full body logged so we can tell whether it's an
      // empty object, a partial profile, or data under a different key.
      console.error(
        `[FB_PROFILE_FETCH_FAILED] strategy=direct status=${response.status} error=${JSON.stringify(data)} userId=${userId}`
      );
    } else {
      const errBody = await response.text().catch(() => '');
      console.error(
        `[FB_PROFILE_FETCH_FAILED] strategy=direct status=${response.status} error=${errBody} userId=${userId}`
      );
    }
  } catch (err: any) {
    console.error(
      `[FB_PROFILE_FETCH_FAILED] strategy=direct status=threw error=${err?.stack || err?.message || String(err)} userId=${userId}`
    );
  }

  // Strategy 2: Conversations API — find participant by user ID
  try {
    const { getMetaPageId } = await import('@/lib/credential-store');
    const pageId =
      knownPageId ||
      (await getMetaPageId(accountId)) ||
      process.env.FACEBOOK_PAGE_ID;

    if (pageId) {
      const convUrl = `${GRAPH_API_BASE}/${pageId}/conversations?fields=participants&user_id=${userId}&access_token=${accessToken}`;
      const convResponse = await fetch(convUrl);
      if (convResponse.ok) {
        const convData = await convResponse.json();
        const conversations = convData.data || [];
        if (conversations.length > 0) {
          const participants = conversations[0].participants?.data || [];
          const sender = participants.find((p: any) => p.id === userId);
          if (sender?.name) {
            console.log(
              `[facebook] Profile resolved via conversations API: ${sender.name}`
            );
            return {
              id: userId,
              name: sender.name,
              profilePicUrl: undefined
            };
          }
        }
        // Either zero conversations or no participant with a name —
        // log the full response so we can distinguish "user has never
        // messaged this page" vs "participants entry exists but has
        // no `name` field" vs "response shape Meta changed on us".
        console.error(
          `[FB_PROFILE_FETCH_FAILED] strategy=conversations status=${convResponse.status} error=no-participant-match body=${JSON.stringify(convData)} userId=${userId}`
        );
      } else {
        const errBody = await convResponse.text().catch(() => '');
        console.error(
          `[FB_PROFILE_FETCH_FAILED] strategy=conversations status=${convResponse.status} error=${errBody} userId=${userId}`
        );
      }
    } else {
      console.error(
        `[FB_PROFILE_FETCH_FAILED] strategy=conversations status=no-pageid error=no-pageid-available userId=${userId}`
      );
    }
  } catch (err: any) {
    console.error(
      `[FB_PROFILE_FETCH_FAILED] strategy=conversations status=threw error=${err?.stack || err?.message || String(err)} userId=${userId}`
    );
  }

  // All strategies failed
  throw new Error(`Failed to fetch Facebook profile for ${userId}`);
}

// ---------------------------------------------------------------------------
// Fetch Conversations (Facebook Messenger)
// ---------------------------------------------------------------------------

export interface FBConversation {
  id: string;
  participants: Array<{ id: string; name?: string }>;
  updatedTime: string;
}

/**
 * Fetch recent Messenger conversations via the Graph API.
 */
export async function getConversations(
  accountId: string,
  limit = 20
): Promise<FBConversation[]> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  const { getMetaPageId } = await import('@/lib/credential-store');
  const pageId =
    (await getMetaPageId(accountId)) || process.env.FACEBOOK_PAGE_ID;
  if (!pageId) {
    throw new Error('No Facebook Page ID configured for this account');
  }
  const url = `${GRAPH_API_BASE}/${pageId}/conversations?fields=participants,updated_time&limit=${limit}&access_token=${accessToken}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch FB conversations: ${response.status}`);
  }

  const data = await response.json();
  return (data.data || []).map((c: any) => ({
    id: c.id,
    participants: c.participants?.data || [],
    updatedTime: c.updated_time
  }));
}

// ---------------------------------------------------------------------------
// Fetch Messages from a Conversation
// ---------------------------------------------------------------------------

export interface FBMessage {
  id: string;
  message: string;
  from: { id: string; name?: string };
  createdTime: string;
}

/**
 * Fetch messages from a Facebook Messenger conversation via the Graph API.
 * Used as a fallback to back-fill conversation history from Meta.
 */
export async function getMessages(
  accountId: string,
  conversationId: string,
  limit = 50
): Promise<FBMessage[]> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  const url = `${GRAPH_API_BASE}/${conversationId}/messages?fields=id,message,from,created_time&limit=${limit}&access_token=${accessToken}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch FB messages: ${response.status}`);
  }

  const data = await response.json();
  return (data.data || []).map((m: any) => ({
    id: m.id,
    message: m.message || '',
    from: m.from || {},
    createdTime: m.created_time
  }));
}
