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

    // Try config_id first (Facebook Login for Business), fall back to scope
    const configId = process.env.META_LOGIN_CONFIG_ID;

    const oauthUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    oauthUrl.searchParams.set('client_id', appId);
    oauthUrl.searchParams.set('redirect_uri', redirectUri);
    oauthUrl.searchParams.set('state', state);
    oauthUrl.searchParams.set('response_type', 'code');

    if (configId) {
      // Facebook Login for Business mode — use config_id (no scope)
      oauthUrl.searchParams.set('config_id', configId);
    } else {
      // Standard mode — use scope parameter directly
      // Only request scopes that are approved in Meta App Review
      const scopes = [
        'instagram_basic',
        'instagram_manage_messages',
        'pages_messaging',
        'pages_show_list',
        // Approved 2026-04-07: required to subscribe pages to webhooks
        // (POST /{page-id}/subscribed_apps) — without this we can't receive
        // DMs without a manual setup step.
        'pages_manage_metadata',
        // Approved 2026-04-07: required to fetch page details (name, IG link)
        // via /{page-id}?fields=... and read post metadata for content
        // attribution. Without this /me/accounts may return empty for some
        // page setups.
        'pages_read_engagement'
      ].join(',');
      oauthUrl.searchParams.set('scope', scopes);
    }

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
