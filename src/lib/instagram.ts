import crypto from 'crypto';
import { getMetaAccessToken } from '@/lib/credential-store';
import prisma from '@/lib/prisma';

const GRAPH_API_VERSION = 'v21.0';
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const IG_GRAPH_API_BASE = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

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
  // For Instagram DMs, prefer the Instagram token (IGAA...) over the Facebook Page token
  const { getCredentials } = await import('@/lib/credential-store');
  const igCreds = await getCredentials(accountId, 'INSTAGRAM');
  const igToken = igCreds?.accessToken as string | undefined;
  const metaToken = await getMetaAccessToken(accountId);
  const accessToken = igToken || metaToken;

  if (!accessToken) {
    throw new Error(
      'No Meta/Instagram access token configured for this account'
    );
  }

  // Resolve the IG Business Account ID from stored credential METADATA (not credentials)
  const metaRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'META' as any, isActive: true },
    select: { metadata: true }
  });
  const igRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'INSTAGRAM' as any, isActive: true },
    select: { metadata: true }
  });

  const metaMeta = (metaRecord?.metadata as any) || {};
  const igMeta = (igRecord?.metadata as any) || {};

  const igBusinessAccountId =
    metaMeta.instagramAccountId ||
    igMeta.igBusinessAccountId ||
    igMeta.igUserId ||
    process.env.INSTAGRAM_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID;

  console.log(
    `[instagram] DEBUG token starts: ${accessToken?.slice(0, 8)}... igBusinessAccountId: ${igBusinessAccountId}`
  );

  if (!igBusinessAccountId) {
    throw new Error('No Instagram Business Account ID found for this account');
  }

  // Instagram tokens (IGAA...) must use graph.instagram.com
  // Facebook page tokens (EAA...) use graph.facebook.com
  const isIGToken = accessToken.startsWith('IGAA');
  const apiBase = isIGToken ? IG_GRAPH_API_BASE : GRAPH_API_BASE;
  const url = `${apiBase}/${igBusinessAccountId}/messages`;

  console.log(
    `[instagram] Sending DM via ${isIGToken ? 'instagram' : 'facebook'} graph: /${igBusinessAccountId}/messages to ${recipientId}`
  );

  const MAX_RETRIES = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // IG tokens: pass access_token in body; FB tokens: use Authorization header
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isIGToken ? {} : { Authorization: `Bearer ${accessToken}` })
        },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: messageText },
          ...(isIGToken
            ? { access_token: accessToken }
            : { messaging_type: 'RESPONSE' })
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
// Send Audio DM (Instagram Voice Note)
// ---------------------------------------------------------------------------

/**
 * Send an audio message (voice note) to an Instagram user via the Graph API.
 * The audioUrl must be a publicly accessible URL (e.g., from Vercel Blob).
 */
export async function sendAudioDM(
  accountId: string,
  recipientId: string,
  audioUrl: string
): Promise<{ messageId: string }> {
  const { getCredentials } = await import('@/lib/credential-store');
  const igCreds = await getCredentials(accountId, 'INSTAGRAM');
  const igToken = igCreds?.accessToken as string | undefined;
  const metaToken = await getMetaAccessToken(accountId);
  const accessToken = igToken || metaToken;

  if (!accessToken) {
    throw new Error(
      'No Meta/Instagram access token configured for this account'
    );
  }

  // Resolve IG Business Account ID
  const metaRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'META' as any, isActive: true },
    select: { metadata: true }
  });
  const igRecord = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'INSTAGRAM' as any, isActive: true },
    select: { metadata: true }
  });

  const metaMeta = (metaRecord?.metadata as any) || {};
  const igMeta = (igRecord?.metadata as any) || {};
  const igBusinessAccountId =
    metaMeta.instagramAccountId ||
    igMeta.igBusinessAccountId ||
    igMeta.igUserId ||
    process.env.INSTAGRAM_PAGE_ID ||
    process.env.FACEBOOK_PAGE_ID;

  if (!igBusinessAccountId) {
    throw new Error('No Instagram Business Account ID found for this account');
  }

  const isIGToken = accessToken.startsWith('IGAA');
  const apiBase = isIGToken ? IG_GRAPH_API_BASE : GRAPH_API_BASE;
  const url = `${apiBase}/${igBusinessAccountId}/messages`;

  console.log(
    `[instagram] Sending audio DM to ${recipientId} via ${isIGToken ? 'instagram' : 'facebook'} graph`
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(isIGToken ? {} : { Authorization: `Bearer ${accessToken}` })
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'audio',
          payload: { url: audioUrl }
        }
      },
      ...(isIGToken
        ? { access_token: accessToken }
        : { messaging_type: 'RESPONSE' })
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Instagram send audio DM failed: ${response.status} ${error}`
    );
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
 *
 * IMPORTANT: Token-host routing matters here.
 *   - IGAA* tokens (Instagram Login flow, instagram_business_*) →
 *     graph.instagram.com — fields are `name,username,profile_picture_url`
 *   - EAA* tokens (Facebook Login flow, instagram_basic) →
 *     graph.facebook.com — fields are `name,username,profile_pic`
 *
 * Calling graph.facebook.com with an IGAA token returns IGApiException
 * 100/33, which used to crash silently in the catch block and leave the
 * lead saved with `name = senderId` (the numeric IGSID).
 */
export async function getUserProfile(
  accountId: string,
  userId: string
): Promise<IGUserProfile> {
  // Prefer Instagram token for profile lookups (has instagram_business_manage_messages)
  const { getCredentials } = await import('@/lib/credential-store');
  const igCreds = await getCredentials(accountId, 'INSTAGRAM');
  const igToken = igCreds?.accessToken as string | undefined;
  const metaToken = await getMetaAccessToken(accountId);
  const accessToken = igToken || metaToken;

  if (!accessToken) {
    throw new Error('No Meta/Instagram access token configured');
  }

  // Route to the right host based on token type. IGAA tokens go to
  // graph.instagram.com, EAA tokens go to graph.facebook.com.
  const isIGToken = String(accessToken).startsWith('IGAA');
  const apiBase = isIGToken ? IG_GRAPH_API_BASE : GRAPH_API_BASE;
  // Instagram Login API uses `profile_picture_url`, Facebook Login API
  // uses `profile_pic`. The other field names (name, username) are the same.
  const picField = isIGToken ? 'profile_picture_url' : 'profile_pic';

  // Strategy 1: Direct user lookup against the correct host
  try {
    const url = `${apiBase}/${userId}?fields=name,username,${picField}&access_token=${accessToken}`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data.username || data.name) {
        console.log(
          `[instagram] Profile resolved via direct lookup (${isIGToken ? 'IG' : 'FB'} host): ${data.username || data.name}`
        );
        return {
          id: data.id || userId,
          name: data.name || data.username || userId,
          username: data.username || userId,
          profilePicUrl: data[picField]
        };
      }
    } else {
      const errBody = await response.text().catch(() => '');
      console.warn(
        `[instagram] Direct lookup failed (${response.status}) on ${isIGToken ? 'IG' : 'FB'} host: ${errBody.slice(0, 200)}`
      );
    }
  } catch (err) {
    console.warn(`[instagram] Direct lookup threw:`, err);
  }

  // Strategy 2: Conversations API — find the participant by ID
  // This is the most reliable path for IGSIDs from incoming webhooks
  // because Meta only exposes the username via the conversation context.
  try {
    const metaRec = await prisma.integrationCredential.findFirst({
      where: { accountId, provider: 'META' as any, isActive: true },
      select: { metadata: true }
    });
    const igRec = await prisma.integrationCredential.findFirst({
      where: { accountId, provider: 'INSTAGRAM' as any, isActive: true },
      select: { metadata: true }
    });
    const igAccountId =
      (igRec?.metadata as any)?.igUserId ||
      (metaRec?.metadata as any)?.instagramAccountId;

    if (igAccountId) {
      // For IG Login flow, the conversations endpoint lives at
      // graph.instagram.com/{ig-user-id}/conversations
      const convUrl = `${apiBase}/${igAccountId}/conversations?fields=participants&user_id=${userId}&access_token=${accessToken}`;
      const convResponse = await fetch(convUrl);
      if (convResponse.ok) {
        const convData = await convResponse.json();
        const conversations = convData.data || [];
        if (conversations.length > 0) {
          const participants = conversations[0].participants?.data || [];
          const sender = participants.find((p: any) => p.id === userId);
          if (sender?.username || sender?.name) {
            console.log(
              `[instagram] Profile resolved via conversations API: @${sender.username || sender.name}`
            );
            return {
              id: userId,
              name: sender.name || sender.username || userId,
              username: sender.username || userId,
              profilePicUrl: undefined
            };
          }
        }
        console.warn(
          `[instagram] Conversations API returned no matching participant for ${userId}`
        );
      } else {
        const errBody = await convResponse.text().catch(() => '');
        console.warn(
          `[instagram] Conversations API failed (${convResponse.status}): ${errBody.slice(0, 200)}`
        );
      }
    } else {
      console.warn(
        `[instagram] No igAccountId found in credentials — cannot use conversations API`
      );
    }
  } catch (err) {
    console.warn(`[instagram] Conversations API strategy threw:`, err);
  }

  // All strategies failed — caller will catch and use ID as fallback
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
