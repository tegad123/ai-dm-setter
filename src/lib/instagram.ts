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
  // Try Instagram app secret first (for IG webhooks), then Meta app secret
  const secrets = [
    process.env.INSTAGRAM_APP_SECRET,
    process.env.META_APP_SECRET
  ].filter(Boolean) as string[];

  if (secrets.length === 0) {
    console.warn('[instagram] No INSTAGRAM_APP_SECRET or META_APP_SECRET set');
    return false;
  }

  // Try each secret — IG webhooks use IG secret, FB webhooks use Meta secret
  for (const secret of secrets) {
    const expectedSig =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    try {
      if (
        crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))
      ) {
        return true;
      }
    } catch {
      // Length mismatch — try next secret
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Send DM (Instagram Direct Message)
// ---------------------------------------------------------------------------

/**
 * Send a DM to an Instagram user via the Graph API.
 * Uses the Instagram Messaging API (IGME).
 */
export async function sendDM(
  accountId: string,
  recipientId: string,
  messageText: string
): Promise<{ messageId: string }> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured for this account');
  }

  // Instagram uses the page-scoped user ID for messaging
  const pageId = process.env.INSTAGRAM_PAGE_ID || process.env.FACEBOOK_PAGE_ID;

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
          `Instagram send DM failed: ${response.status} ${error}`
        );
      }

      const data = await response.json();
      return { messageId: data.message_id || data.id || '' };
    } catch (err: any) {
      lastError = err;
      console.error(
        `[instagram] Send DM attempt ${attempt}/${MAX_RETRIES} failed:`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        // Exponential backoff: 1s, 2s, 4s
        await new Promise((r) =>
          setTimeout(r, Math.pow(2, attempt - 1) * 1000)
        );
      }
    }
  }

  throw lastError || new Error('Instagram send DM failed after retries');
}

// ---------------------------------------------------------------------------
// Fetch User Profile
// ---------------------------------------------------------------------------

export interface IGUserProfile {
  id: string;
  name: string;
  username: string;
  profilePicUrl?: string;
}

/**
 * Fetch an Instagram user's profile via the Graph API.
 */
export async function getUserProfile(
  accountId: string,
  userId: string
): Promise<IGUserProfile> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  // Instagram-Scoped IDs (IGSIDs) from the Messaging API require a different
  // approach — the standard Graph API /{user-id} doesn't work with them.
  // Try multiple strategies:

  // Strategy 1: Direct user lookup (works for some token types)
  try {
    const url = `${GRAPH_API_BASE}/${userId}?fields=id,name,username,profile_pic&access_token=${accessToken}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.username || data.name) {
        console.log(
          `[instagram] Profile resolved via direct lookup: ${data.username || data.name}`
        );
        return {
          id: data.id,
          name: data.name || data.username || userId,
          username: data.username || userId,
          profilePicUrl: data.profile_pic
        };
      }
    }
  } catch {
    // Direct lookup failed — try next strategy
  }

  // Strategy 2: Look up via Instagram conversations API
  // Get the IG business account ID from credentials
  try {
    const { getCredentials } = await import('@/lib/credential-store');
    const metaCreds = await getCredentials(accountId, 'META');
    const igCreds = await getCredentials(accountId, 'INSTAGRAM');
    const igAccountId =
      (metaCreds as any)?.instagramAccountId || (igCreds as any)?.igUserId;

    if (igAccountId) {
      // Fetch conversations with this participant
      const convUrl = `${GRAPH_API_BASE}/${igAccountId}/conversations?fields=participants&user_id=${userId}&access_token=${accessToken}`;
      const convResponse = await fetch(convUrl);
      if (convResponse.ok) {
        const convData = await convResponse.json();
        const conversations = convData.data || [];
        if (conversations.length > 0) {
          const participants = conversations[0].participants?.data || [];
          const sender = participants.find((p: any) => p.id === userId);
          if (sender?.username) {
            console.log(
              `[instagram] Profile resolved via conversations API: @${sender.username}`
            );
            return {
              id: userId,
              name: sender.name || sender.username || userId,
              username: sender.username || userId,
              profilePicUrl: undefined
            };
          }
        }
      } else {
        const errBody = await convResponse.text().catch(() => '');
        console.warn(
          `[instagram] Conversations API failed: ${convResponse.status} ${errBody.slice(0, 200)}`
        );
      }
    }
  } catch (err) {
    console.warn(`[instagram] Conversations API strategy failed:`, err);
  }

  // All strategies failed
  console.warn(
    `[instagram] Could not resolve profile for ${userId} — using ID as fallback`
  );
  throw new Error(`Failed to fetch Instagram profile for ${userId}`);
}

// ---------------------------------------------------------------------------
// Fetch Conversations (Instagram DMs)
// ---------------------------------------------------------------------------

export interface IGConversation {
  id: string;
  participants: Array<{ id: string; name?: string; username?: string }>;
  updatedTime: string;
}

/**
 * Fetch recent Instagram DM conversations via the Graph API.
 * Used as fallback when local DB doesn't have full history.
 */
export async function getConversations(
  accountId: string,
  limit = 20
): Promise<IGConversation[]> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  const pageId = process.env.INSTAGRAM_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const url = `${GRAPH_API_BASE}/${pageId}/conversations?fields=participants,updated_time&limit=${limit}&platform=instagram&access_token=${accessToken}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch IG conversations: ${response.status}`);
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

export interface IGMessage {
  id: string;
  message: string;
  from: { id: string; name?: string; username?: string };
  createdTime: string;
}

/**
 * Fetch messages from an Instagram conversation via the Graph API.
 * Used as a fallback to back-fill conversation history from Meta.
 */
export async function getMessages(
  accountId: string,
  conversationId: string,
  limit = 50
): Promise<IGMessage[]> {
  const accessToken = await getMetaAccessToken(accountId);
  if (!accessToken) {
    throw new Error('No Meta access token configured');
  }

  const url = `${GRAPH_API_BASE}/${conversationId}/messages?fields=id,message,from,created_time&limit=${limit}&access_token=${accessToken}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch IG messages: ${response.status}`);
  }

  const data = await response.json();
  return (data.data || []).map((m: any) => ({
    id: m.id,
    message: m.message || '',
    from: m.from || {},
    createdTime: m.created_time
  }));
}
