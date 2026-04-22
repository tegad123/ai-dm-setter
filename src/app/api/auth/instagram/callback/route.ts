import { saveCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

// Instagram OAuth callback needs time for: token exchange + long-lived exchange + profile fetch + subscription
export const maxDuration = 45;

// ---------------------------------------------------------------------------
// GET — Instagram OAuth Callback
// Exchanges the code for a short-lived token, then a long-lived token,
// fetches the user's IG profile, stores credentials, and subscribes to
// webhook events so DMs are forwarded to our endpoint.
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.instagram.com';
const FB_GRAPH_API = 'https://graph.facebook.com/v21.0';

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
    console.log('[instagram-oauth] Starting long-lived token exchange...');
    const llUrl =
      `${GRAPH_API}/access_token?` +
      new URLSearchParams({
        grant_type: 'ig_exchange_token',
        client_secret: appSecret,
        access_token: shortLivedToken
      });
    console.log(
      `[instagram-oauth] Exchange URL: ${llUrl.split('access_token=')[0]}access_token=REDACTED`
    );

    let accessToken = shortLivedToken;
    try {
      const longLivedRes = await fetch(llUrl);
      const llBody = await longLivedRes.text();
      console.log(
        `[instagram-oauth] Long-lived exchange status: ${longLivedRes.status}, body: ${llBody.slice(0, 200)}`
      );

      if (longLivedRes.ok) {
        const llData = JSON.parse(llBody);
        accessToken = llData.access_token || shortLivedToken;
        console.log(
          `[instagram-oauth] Got long-lived token: ${accessToken.slice(0, 10)}... expires_in: ${llData.expires_in}`
        );
      } else {
        console.error(
          '[instagram-oauth] Long-lived token exchange failed:',
          llBody.slice(0, 300)
        );
      }
    } catch (llErr: any) {
      console.error(
        '[instagram-oauth] Long-lived exchange threw:',
        llErr?.message || llErr
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

    // Step 5: Subscribe to webhook events so Meta forwards DMs.
    // Instagram DM webhooks are delivered via the linked Facebook Page.
    // We need to find the Page that owns this IG account and subscribe it.
    await subscribeInstagramWebhooks(accessToken, igUserId, state.accountId);

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

// ---------------------------------------------------------------------------
// Subscribe to Instagram webhook events via the linked Facebook Page.
// Instagram DM webhooks are delivered through the Facebook Page that owns
// the IG Business/Creator account. We try two approaches:
// 1. Use the Meta/Facebook credentials already stored for this account
// 2. Use the IG token to discover the linked page via the Facebook Graph API
// ---------------------------------------------------------------------------

async function subscribeInstagramWebhooks(
  igAccessToken: string,
  igUserId: string,
  accountId: string
): Promise<void> {
  try {
    // Approach 1: Check if this account already has a META credential with a pageId
    const { getCredentials } = await import('@/lib/credential-store');
    const metaCreds = await getCredentials(accountId, 'META');

    if (metaCreds) {
      const metaRecord = await (await import('@/lib/prisma')).default.integrationCredential.findFirst({
        where: { accountId, provider: 'META', isActive: true },
        select: { metadata: true }
      });
      const pageId = (metaRecord?.metadata as any)?.pageId;
      const pageToken = metaCreds.accessToken;

      if (pageId && pageToken) {
        console.log(
          `[instagram-oauth] Found existing META credential with pageId=${pageId}, subscribing to webhooks`
        );
        await subscribePageToWebhooks(pageId, pageToken);
        return;
      }
    }

    // Approach 2: Use the IG token to find the linked Facebook Page.
    // This requires the pages_read_engagement or instagram_manage_messages permission.
    // The IG Business Account is linked to a Page — query the FB Graph API.
    try {
      const pagesRes = await fetch(
        `${FB_GRAPH_API}/me/accounts?fields=id,name,instagram_business_account,access_token&access_token=${igAccessToken}`
      );

      if (pagesRes.ok) {
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];

        const linkedPage = pages.find(
          (p: any) => p.instagram_business_account?.id === igUserId
        ) || pages[0];

        if (linkedPage) {
          console.log(
            `[instagram-oauth] Discovered linked page: ${linkedPage.name} (${linkedPage.id})`
          );
          await subscribePageToWebhooks(linkedPage.id, linkedPage.access_token || igAccessToken);
          return;
        }
      } else {
        const err = await pagesRes.text();
        console.warn(
          `[instagram-oauth] Pages discovery failed (may lack pages_read_engagement scope):`,
          err.slice(0, 300)
        );
      }
    } catch (err: any) {
      console.warn('[instagram-oauth] Page discovery error:', err?.message || err);
    }

    console.warn(
      `[instagram-oauth] Could not subscribe to webhooks for IG user ${igUserId}. ` +
        `Webhooks must be configured manually in Meta Developer Dashboard, or connect via Meta OAuth (which auto-subscribes).`
    );
  } catch (err) {
    console.error('[instagram-oauth] Webhook subscription error:', err);
  }
}

async function subscribePageToWebhooks(
  pageId: string,
  accessToken: string
): Promise<void> {
  const res = await fetch(`${FB_GRAPH_API}/${pageId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribed_fields: [
        'messages',
        'messaging_postbacks',
        'messaging_optins',
        'message_deliveries',
        'message_reads'
      ].join(','),
      access_token: accessToken
    })
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`[instagram-oauth] Subscribed page ${pageId} to webhooks:`, data);
  } else {
    const err = await res.text();
    console.error(
      `[instagram-oauth] Failed to subscribe page ${pageId} to webhooks:`,
      err.slice(0, 300)
    );
  }
}
