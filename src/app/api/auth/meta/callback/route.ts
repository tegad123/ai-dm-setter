import { saveCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET — Meta OAuth Callback
// Exchanges the authorization code for tokens, fetches the user's pages,
// and stores the Page Access Token in the credential store.
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.facebook.com/v21.0';

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
      console.warn('[meta-oauth] User denied access:', errorParam);
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=meta_denied`
      );
    }

    if (!code || !stateParam) {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=missing_params`
      );
    }

    // Decode state to get accountId
    let state: { accountId: string; userId: string };
    try {
      state = JSON.parse(Buffer.from(stateParam, 'base64url').toString());
    } catch {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=invalid_state`
      );
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=platform_config`
      );
    }

    const redirectUri = `${baseUrl}/api/auth/meta/callback`;

    // Step 1: Exchange code for short-lived user access token
    const tokenRes = await fetch(
      `${GRAPH_API}/oauth/access_token?` +
        new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code
        })
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('[meta-oauth] Token exchange failed:', err);
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=token_exchange`
      );
    }

    const tokenData = await tokenRes.json();
    const shortLivedToken: string = tokenData.access_token;

    // Step 2: Exchange for long-lived user token (60-day)
    const longLivedRes = await fetch(
      `${GRAPH_API}/oauth/access_token?` +
        new URLSearchParams({
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: shortLivedToken
        })
    );

    let userToken = shortLivedToken;
    if (longLivedRes.ok) {
      const llData = await longLivedRes.json();
      userToken = llData.access_token || shortLivedToken;
    }

    // Step 3: Fetch user's pages (includes Instagram-connected pages)
    const pagesRes = await fetch(
      `${GRAPH_API}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`
    );

    if (!pagesRes.ok) {
      const err = await pagesRes.text();
      console.error('[meta-oauth] Pages fetch failed:', err);
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=pages_fetch`
      );
    }

    const pagesData = await pagesRes.json();
    const pages: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }> = pagesData.data ?? [];

    if (pages.length === 0) {
      return NextResponse.redirect(
        `${baseUrl}/dashboard/settings/integrations?error=no_pages`
      );
    }

    // Use the first page (users can change later in settings)
    const page = pages[0];

    // The Page Access Token from /me/accounts with a long-lived user token
    // is already a long-lived page token (never expires unless permissions revoked)
    const pageAccessToken = page.access_token;
    const pageId = page.id;
    const pageName = page.name;
    const igAccountId = page.instagram_business_account?.id || null;

    // Step 4a: If Instagram is connected, fetch the IG username
    let igUsername: string | null = null;
    if (igAccountId) {
      try {
        const igRes = await fetch(
          `${GRAPH_API}/${igAccountId}?fields=username,name,profile_picture_url&access_token=${pageAccessToken}`
        );
        if (igRes.ok) {
          const igData = await igRes.json();
          igUsername = igData.username || null;
          console.log(
            `[meta-oauth] Instagram account: @${igUsername} (${igAccountId})`
          );
        }
      } catch (err) {
        console.warn('[meta-oauth] Failed to fetch IG username:', err);
      }
    }

    // Step 4b: Save to credential store
    await saveCredentials(
      state.accountId,
      'META',
      { accessToken: pageAccessToken },
      {
        pageId,
        pageName,
        ...(igAccountId ? { instagramAccountId: igAccountId } : {}),
        ...(igUsername ? { instagramUsername: igUsername } : {}),
        platform: igAccountId ? 'INSTAGRAM_AND_FACEBOOK' : 'FACEBOOK'
      }
    );

    console.log(
      `[meta-oauth] Successfully connected page "${pageName}" (${pageId}) for account ${state.accountId}`
    );

    // Step 5: Subscribe the page to your app's webhooks so DMs are forwarded
    // This is the critical step — without it, Meta won't send webhook events
    try {
      const subscribeRes = await fetch(
        `${GRAPH_API}/${pageId}/subscribed_apps`,
        {
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
            access_token: pageAccessToken
          })
        }
      );

      if (subscribeRes.ok) {
        const subData = await subscribeRes.json();
        console.log(
          `[meta-oauth] Subscribed page ${pageId} to webhooks:`,
          subData
        );
      } else {
        const subErr = await subscribeRes.text();
        console.error(
          `[meta-oauth] Failed to subscribe page ${pageId} to webhooks:`,
          subErr
        );
      }
    } catch (subError) {
      console.error('[meta-oauth] Webhook subscription error:', subError);
    }

    // Step 5b: If Instagram is connected, also subscribe for Instagram messaging
    if (igAccountId) {
      try {
        const igSubRes = await fetch(
          `${GRAPH_API}/${pageId}/subscribed_apps`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subscribed_fields: 'messages',
              access_token: pageAccessToken
            })
          }
        );
        if (igSubRes.ok) {
          console.log(
            `[meta-oauth] Instagram messaging webhook subscribed for page ${pageId} (IG: ${igAccountId})`
          );
        } else {
          const igSubErr = await igSubRes.text();
          console.error('[meta-oauth] IG webhook subscribe failed:', igSubErr);
        }
      } catch (err) {
        console.error('[meta-oauth] IG webhook subscription error:', err);
      }
    }

    return NextResponse.redirect(
      `${baseUrl}/dashboard/settings/integrations?connected=meta&page=${encodeURIComponent(pageName)}`
    );
  } catch (error) {
    console.error('[meta-oauth] Callback error:', error);
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      'http://localhost:3000';
    return NextResponse.redirect(
      `${baseUrl}/dashboard/settings/integrations?error=unknown`
    );
  }
}
