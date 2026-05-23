import { setCredentials } from '@/lib/credential-store';
import { verifyState } from '@/lib/oauth-state';
import { google } from 'googleapis';
import { NextRequest, NextResponse } from 'next/server';

// Token exchange + userinfo can take a moment.
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// GET — Google Calendar OAuth callback.
// Verifies the signed state, exchanges the code for access + refresh tokens,
// records which Google account connected, and persists the credential
// (tokens encrypted) so the calendar adapter can read/refresh them.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'http://localhost:3000';
  const settings = `${baseUrl}/dashboard/settings/integrations`;

  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      console.warn('[google-calendar-oauth] user denied access:', errorParam);
      return NextResponse.redirect(`${settings}?error=google_denied`);
    }
    if (!code || !stateParam) {
      return NextResponse.redirect(`${settings}?error=missing_params`);
    }

    const verified = verifyState(stateParam);
    if (!verified) {
      return NextResponse.redirect(`${settings}?error=invalid_state`);
    }
    const { accountId } = verified;

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const redirectUri =
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      `${baseUrl}/api/auth/google-calendar/callback`;
    if (!clientId || !clientSecret) {
      return NextResponse.redirect(`${settings}?error=platform_config`);
    }

    const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token) {
      console.error(
        '[google-calendar-oauth] no access_token in token response'
      );
      return NextResponse.redirect(`${settings}?error=google_token_exchange`);
    }

    // Calendar permissions are opt-in on Google's consent screen (the boxes
    // are unchecked by default), so a user can finish OAuth having granted
    // ONLY email. Without the calendar scopes the connection is useless — so
    // verify both calendar scopes were granted; otherwise revoke the partial
    // grant and reject with a clear error instead of storing a dead credential.
    const granted = (tokens.scope || '').split(/\s+/);
    const requiredScopes = [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly'
    ];
    const missingScopes = requiredScopes.filter((s) => !granted.includes(s));
    if (missingScopes.length > 0) {
      console.warn(
        '[google-calendar-oauth] calendar scopes not granted:',
        missingScopes
      );
      try {
        await client.revokeToken(tokens.access_token);
      } catch (revokeErr) {
        console.warn('[google-calendar-oauth] revoke failed:', revokeErr);
      }
      return NextResponse.redirect(`${settings}?error=google_missing_scopes`);
    }

    if (!tokens.refresh_token) {
      // Without a refresh token we can't refresh after 1h. This happens when
      // the user previously consented and Google skips re-issuing it. We force
      // prompt=consent on connect to avoid this — warn if it still occurs.
      console.warn(
        '[google-calendar-oauth] no refresh_token returned — connection will expire in ~1h. User may need to revoke prior access and reconnect.'
      );
    }

    // Identify which Google account connected (for display in Settings).
    client.setCredentials(tokens);
    let email = '';
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const me = await oauth2.userinfo.get();
      email = me.data.email || '';
    } catch (err) {
      console.warn('[google-calendar-oauth] userinfo fetch failed:', err);
    }

    await setCredentials(
      accountId,
      'GOOGLE_CALENDAR',
      {
        accessToken: tokens.access_token,
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        // Non-secret config the adapter reads. 'primary' = the account's
        // default calendar; can be made selectable later.
        calendarId: 'primary'
      },
      { email, connectedAt: new Date().toISOString() }
    );

    console.log(
      `[google-calendar-oauth] connected ${email || '(unknown email)'} for account ${accountId}`
    );
    return NextResponse.redirect(
      `${settings}?connected=google-calendar&email=${encodeURIComponent(email)}`
    );
  } catch (error) {
    console.error('[google-calendar-oauth] callback error:', error);
    return NextResponse.redirect(`${settings}?error=google_unknown`);
  }
}
