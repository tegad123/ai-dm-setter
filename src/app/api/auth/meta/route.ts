import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET — Initiate Meta OAuth flow
// Redirects the user to Facebook OAuth dialog using the platform's App ID.
// The user grants page permissions so we can manage their IG/FB DMs.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const appId = process.env.META_APP_ID;
    if (!appId) {
      return NextResponse.json(
        { error: 'META_APP_ID is not configured on the platform' },
        { status: 500 }
      );
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    const redirectUri = `${baseUrl}/api/auth/meta/callback`;

    // Encode accountId in state so we can associate the token after callback
    const state = Buffer.from(
      JSON.stringify({ accountId: auth.accountId, userId: auth.userId })
    ).toString('base64url');

    const scopes = [
      'pages_messaging',
      'pages_read_engagement',
      'pages_manage_metadata',
      'instagram_manage_messages',
      'instagram_basic'
    ].join(',');

    const oauthUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    oauthUrl.searchParams.set('client_id', appId);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('state', state);
    oauthUrl.searchParams.set('scope', scopes);
    oauthUrl.searchParams.set('response_type', 'code');

    return NextResponse.redirect(oauthUrl.toString());
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/auth/meta error:', error);
    return NextResponse.json(
      { error: 'Failed to initiate Meta OAuth' },
      { status: 500 }
    );
  }
}
