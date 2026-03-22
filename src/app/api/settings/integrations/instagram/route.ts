import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { getCredentials, saveCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
// GET — Fetch Instagram Business accounts available via the connected FB Page
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Get the stored META credential
    const cred = await prisma.integrationCredential.findFirst({
      where: { accountId: auth.accountId, provider: 'META', isActive: true }
    });

    if (!cred) {
      return NextResponse.json(
        { error: 'Connect your Facebook Page first' },
        { status: 400 }
      );
    }

    const credentials = await getCredentials(auth.accountId, 'META');
    const accessToken = credentials?.accessToken;
    const pageId = (cred.metadata as any)?.pageId;

    if (!accessToken || !pageId) {
      return NextResponse.json(
        { error: 'Facebook Page credentials incomplete' },
        { status: 400 }
      );
    }

    // Fetch the Instagram Business Account linked to this Page
    const res = await fetch(
      `${GRAPH_API}/${pageId}?fields=instagram_business_account{id,username,name,profile_picture_url,followers_count}&access_token=${accessToken}`
    );

    if (!res.ok) {
      const err = await res.json().catch(() => null);
      console.error('[instagram-link] Failed to fetch IG account:', err);
      return NextResponse.json(
        { error: 'Failed to fetch Instagram accounts from Meta' },
        { status: 502 }
      );
    }

    const data = await res.json();
    const igAccount = data.instagram_business_account;

    if (!igAccount) {
      return NextResponse.json({
        available: false,
        accounts: [],
        message:
          'No Instagram Business account is linked to this Facebook Page. Link one in Instagram Settings > Account > Linked Accounts.'
      });
    }

    return NextResponse.json({
      available: true,
      accounts: [
        {
          id: igAccount.id,
          username: igAccount.username || null,
          name: igAccount.name || null,
          profilePicture: igAccount.profile_picture_url || null,
          followersCount: igAccount.followers_count || 0
        }
      ]
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/integrations/instagram error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST — Link a specific Instagram account to the current Meta integration
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { instagramAccountId, instagramUsername } = body;

    if (!instagramAccountId) {
      return NextResponse.json(
        { error: 'instagramAccountId is required' },
        { status: 400 }
      );
    }

    // Get existing META credential
    const cred = await prisma.integrationCredential.findFirst({
      where: { accountId: auth.accountId, provider: 'META', isActive: true }
    });

    if (!cred) {
      return NextResponse.json(
        { error: 'Connect your Facebook Page first' },
        { status: 400 }
      );
    }

    const existingMeta = (cred.metadata as any) || {};

    // Update metadata with Instagram info
    await prisma.integrationCredential.update({
      where: { id: cred.id },
      data: {
        metadata: {
          ...existingMeta,
          instagramAccountId,
          instagramUsername: instagramUsername || null,
          platform: 'INSTAGRAM_AND_FACEBOOK'
        }
      }
    });

    console.log(
      `[instagram-link] Linked @${instagramUsername} (${instagramAccountId}) for account ${auth.accountId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/settings/integrations/instagram error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE — Unlink Instagram (but keep Facebook connected)
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const cred = await prisma.integrationCredential.findFirst({
      where: { accountId: auth.accountId, provider: 'META', isActive: true }
    });

    if (!cred) {
      return NextResponse.json({ success: true });
    }

    const existingMeta = (cred.metadata as any) || {};

    // Remove Instagram fields from metadata, keep Facebook
    const { instagramAccountId, instagramUsername, ...rest } = existingMeta;

    await prisma.integrationCredential.update({
      where: { id: cred.id },
      data: {
        metadata: {
          ...rest,
          platform: 'FACEBOOK'
        }
      }
    });

    console.log(
      `[instagram-link] Unlinked Instagram for account ${auth.accountId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/settings/integrations/instagram error:', error);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
