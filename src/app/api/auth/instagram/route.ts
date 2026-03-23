import { requireAuth, AuthError } from '@/lib/auth-guard';
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

    // Encode accountId in state so we can associate the token after callback
    const state = Buffer.from(
      JSON.stringify({ accountId: auth.accountId, userId: auth.userId })
    ).toString('base64url');

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
