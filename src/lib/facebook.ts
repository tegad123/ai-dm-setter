import crypto from 'crypto';
import { getCredentials } from '@/lib/credential-store';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Facebook Messenger API Client — Meta Graph API v21.0
// ---------------------------------------------------------------------------

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

function getAppSecret(): string {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error('META_APP_SECRET is not set');
  return secret;
}

// ---------------------------------------------------------------------------
// Resolve per-account Meta credentials (Page Access Token + Page ID)
// Falls back to env vars for backwards compatibility / dev usage
// ---------------------------------------------------------------------------

async function resolveMetaCredentials(
  accountId: string
): Promise<{ accessToken: string; pageId: string }> {
  // Try credential store first
  const cred = await prisma.integrationCredential.findFirst({
    where: { accountId, provider: 'META', isActive: true }
  });

  if (cred) {
    const credentials = await getCredentials(accountId, 'META');
    const accessToken = credentials?.accessToken;
    const pageId = (cred.metadata as any)?.pageId;

    if (accessToken && pageId) {
      return { accessToken, pageId };
    }
  }

  // Fallback to env vars
  const accessToken = process.env.META_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!accessToken || !pageId) {
    throw new Error(
      `No Meta credentials found for account ${accountId}. ` +
        'Provide credentials via the credential store or set META_ACCESS_TOKEN and FACEBOOK_PAGE_ID env vars.'
    );
  }

  return { accessToken, pageId };
}

// ---------------------------------------------------------------------------
// Send a text message via Facebook Messenger
// ---------------------------------------------------------------------------

export async function sendMessage(
  accountId: string,
  recipientId: string,
  message: string
): Promise<void> {
  const { accessToken, pageId } = await resolveMetaCredentials(accountId);

  const res = await fetch(`${GRAPH_API_BASE}/${pageId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text: message },
      access_token: accessToken
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Facebook sendMessage failed (${res.status}): ${JSON.stringify(body)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Send a voice-note attachment via Facebook Messenger
// ---------------------------------------------------------------------------

export async function sendVoiceNote(
  accountId: string,
  recipientId: string,
  audioUrl: string
): Promise<void> {
  const { accessToken, pageId } = await resolveMetaCredentials(accountId);

  const res = await fetch(`${GRAPH_API_BASE}/${pageId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'audio',
          payload: { url: audioUrl, is_reusable: true }
        }
      },
      access_token: accessToken
    })
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Facebook sendVoiceNote failed (${res.status}): ${JSON.stringify(body)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Get a user's profile info from Facebook
// ---------------------------------------------------------------------------

export async function getUserProfile(
  accountId: string,
  userId: string
): Promise<{ name: string; profilePic: string }> {
  const { accessToken } = await resolveMetaCredentials(accountId);

  const res = await fetch(
    `${GRAPH_API_BASE}/${userId}?fields=name,profile_pic&access_token=${accessToken}`
  );

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(
      `Facebook getUserProfile failed (${res.status}): ${JSON.stringify(body)}`
    );
  }

  const json = await res.json();
  return {
    name: json.name ?? '',
    profilePic: json.profile_pic ?? ''
  };
}

// ---------------------------------------------------------------------------
// Verify Meta webhook signature (x-hub-signature-256)
// Uses platform-level app secret — NOT per-account
// ---------------------------------------------------------------------------

export function verifyWebhookSignature(
  body: string,
  signature: string
): boolean {
  const appSecret = getAppSecret();
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(body, 'utf8')
    .digest('hex');
  return signature === `sha256=${expected}`;
}
