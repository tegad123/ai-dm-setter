import { requireAuth, AuthError } from '@/lib/auth-guard';
import { signState } from '@/lib/oauth-state';
import { google } from 'googleapis';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET — Initiate Google Calendar OAuth.
// access_type=offline + prompt=consent guarantees Google returns a
// refresh_token (needed to refresh the 1-hour access token server-side).
// State is HMAC-signed (same pattern as the Meta/Instagram connect routes) so
// the callback is anchored to an account/user we issued it for.
// ---------------------------------------------------------------------------

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: 'GOOGLE_OAUTH_CLIENT_ID/SECRET not configured' },
        { status: 500 }
      );
    }

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      `${baseUrl}/api/auth/google-calendar/callback`;

    const state = signState({ accountId: auth.accountId, userId: auth.userId });

    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const oauthUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: SCOPES,
      state
    });

    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/auth/google-calendar/connect error:', error);
    return NextResponse.json(
      { error: 'Failed to initiate Google Calendar OAuth' },
      { status: 500 }
    );
  }
}
