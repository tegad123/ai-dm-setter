import crypto from 'crypto';
import { getMetaAccessToken } from '@/lib/credential-store';

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
 * Send a message to a Facebook Messenger user via the Graph API.
 */
export async function sendMessage(
  accountId: string,
  recipientId: string,
  messageText: string
): Promise<{ messageId: string }> {
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
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: messageText },
          messaging_type: 'RESPONSE'
        })
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
  audioUrl: string
): Promise<{ messageId: string }> {
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

  const pageId = process.env.FACEBOOK_PAGE_ID;
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
