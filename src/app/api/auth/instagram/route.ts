import { requireAuth, AuthError } from '@/lib/auth-guard';
import { signState } from '@/lib/oauth-state';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET — Initiate Instagram OAuth flow (separate from Facebook)
// Uses Instagram API with Instagram Login
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const appId = process.env.INSTAGRAM_APP_ID;
    if (!appId) {
      return NextResponse.json(
        { error: 'INSTAGRAM_APP_ID is not configured' },
        { status: 500 }
      );
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    const redirectUri = `${baseUrl}/api/auth/instagram/callback`;

    // HMAC-signed state — see meta/route.ts for the rationale. Plain
    // base64 JSON lets an attacker forge any accountId/userId; signing
    // anchors the callback to a state we issued.
    const state = signState({
      accountId: auth.accountId,
      userId: auth.userId
    });

    const scopes = [
      'instagram_business_basic',
      'instagram_business_manage_messages'
    ].join(',');

    // Build URL manually to avoid encoding issues with redirect_uri
    const oauthUrl = `https://www.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${scopes}&response_type=code`;

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/auth/instagram error:', error);
    return NextResponse.json(
      { error: 'Failed to initiate Instagram OAuth' },
      { status: 500 }
    );
  }
}
