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
  const appSecret = process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET;
  if (!appSecret) {
    console.warn('[instagram] No META_APP_SECRET set, cannot verify signature');
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
    console.error('[instagram] Send DM failed:', error);
    throw new Error(`Instagram send DM failed: ${response.status} ${error}`);
  }

  const data = await response.json();
  return { messageId: data.message_id || data.id || '' };
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

  const url = `${GRAPH_API_BASE}/${userId}?fields=id,name,username,profile_pic&access_token=${accessToken}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch Instagram profile: ${response.status}`);
  }

  const data = await response.json();
  return {
    id: data.id,
    name: data.name || data.username || userId,
    username: data.username || userId,
    profilePicUrl: data.profile_pic
  };
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
