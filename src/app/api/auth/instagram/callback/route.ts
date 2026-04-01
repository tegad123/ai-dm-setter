import { saveCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET — Instagram OAuth Callback
// Exchanges the code for a short-lived token, then a long-lived token,
// fetches the user's IG profile, and stores credentials.
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.instagram.com';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const errorParam = searchParams.get('error');

    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';

    // Handle OAuth denial
    if (errorParam) {
      console.warn('[instagram-oauth] User denied access:', errorParam);
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=instagram_denied`
      );
    }

    if (!code || !stateParam) {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=missing_params`
      );
    }

    // Decode state
    let state: { accountId: string; userId: string };
    try {
      state = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
    } catch {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=invalid_state`
      );
    }

    const appId = process.env.INSTAGRAM_APP_ID;
    const appSecret = process.env.INSTAGRAM_APP_SECRET;
    if (!appId || !appSecret) {
      console.error(
        '[instagram-oauth] INSTAGRAM_APP_ID or INSTAGRAM_APP_SECRET not set'
      );
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=platform_config`
      );
    }

    const redirectUri = `${baseUrl}/api/auth/instagram/callback`;

    // Step 1: Exchange code for short-lived Instagram token
    const tokenRes = await fetch(
      'https://api.instagram.com/oauth/access_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code
        })
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[instagram-oauth] Token exchange failed:', err);
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=ig_token_exchange`
      );
    }

    const tokenData = await tokenRes.json();
    const shortLivedToken: string = tokenData.access_token;
    const igUserId: string = String(tokenData.user_id);

    console.log(
      `[instagram-oauth] Got short-lived token for IG user: ${igUserId}`
    );

    // Step 2: Exchange for long-lived token (60-day)
    const longLivedRes = await fetch(
      `${GRAPH_API}/access_token?` +
        new URLSearchParams({
          grant_type: 'ig_exchange_token',
          client_secret: appSecret,
          access_token: shortLivedToken
        })
    );

    let accessToken = shortLivedToken;
    if (longLivedRes.ok) {
      const llData = await longLivedRes.json();
      accessToken = llData.access_token || shortLivedToken;
      console.log('[instagram-oauth] Exchanged for long-lived token');
    } else {
      console.warn(
        '[instagram-oauth] Long-lived token exchange failed, using short-lived'
      );
    }

    // Step 3: Fetch the Instagram user profile
    const profileRes = await fetch(
      `${GRAPH_API}/v21.0/me?fields=user_id,username,name,profile_picture_url,followers_count&access_token=${accessToken}`
    );

    let username = igUserId;
    let name = '';
    let profilePicture = '';
    let followersCount = 0;

    if (profileRes.ok) {
      const profileData = await profileRes.json();
      username = profileData.username || igUserId;
      name = profileData.name || '';
      profilePicture = profileData.profile_picture_url || '';
      followersCount = profileData.followers_count || 0;
      console.log(`[instagram-oauth] Profile: @${username} (${name})`);
    } else {
      const err = await profileRes.text();
      console.warn('[instagram-oauth] Profile fetch failed:', err);
    }

    // Step 4: Save to credential store as INSTAGRAM provider.
    // Store igUserId as instagramAccountId too — Instagram webhooks send the
    // IG user/business-account ID as entry.id, so both fields must be present
    // for webhook credential matching to succeed.
    await saveCredentials(
      state.accountId,
      'INSTAGRAM',
      { accessToken },
      {
        igUserId,
        instagramAccountId: igUserId,
        username,
        name,
        profilePicture,
        followersCount: String(followersCount)
      }
    );

    console.log(
      `[instagram-oauth] Successfully connected @${username} (${igUserId}) for account ${state.accountId}`
    );

    return NextResponse.redirect(
      `${baseUrl}/dashboard/settings/integrations?connected=instagram&ig=${encodeURIComponent(username)}`
    );
  } catch (error) {
    console.error('[instagram-oauth] Callback error:', error);
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    return NextResponse.redirect(
      `${baseUrl}/dashboard/settings/integrations?error=ig_unknown`
    );
  }
}
