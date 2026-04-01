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

    // Step 2b: Check what permissions were actually granted
    try {
      const permsRes = await fetch(
        `${GRAPH_API}/me/permissions?access_token=${userToken}`
      );
      if (permsRes.ok) {
        const permsData = await permsRes.json();
        console.log(
          `[meta-oauth] Granted permissions:`,
          JSON.stringify(
            permsData.data?.map((p: any) => `${p.permission}:${p.status}`)
          )
        );
      }
    } catch (err) {
      console.warn('[meta-oauth] Failed to check permissions:', err);
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
    console.log(
      `[meta-oauth] /me/accounts response:`,
      JSON.stringify(pagesData).slice(0, 500)
    );

    const pages: Array<{
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string };
    }> = pagesData.data ?? [];

    if (pages.length === 0) {
      // Log the full response to diagnose why no pages were returned
      console.error(
        `[meta-oauth] No pages returned for account ${state.accountId}. Full response:`,
        JSON.stringify(pagesData)
      );
      // Check if it's a pagination issue — Meta sometimes returns pages on subsequent pages
      if (pagesData.paging?.next) {
        console.log('[meta-oauth] Pagination detected — trying next page...');
        const nextRes = await fetch(pagesData.paging.next);
        if (nextRes.ok) {
          const nextData = await nextRes.json();
          console.log(
            '[meta-oauth] Next page:',
            JSON.stringify(nextData).slice(0, 500)
          );
          if (nextData.data?.length > 0) {
            pages.push(...nextData.data);
          }
        }
      }
    }

    if (pages.length === 0) {
      // Also try with the short-lived token in case long-lived exchange changed scopes
      console.log('[meta-oauth] Retrying with short-lived token...');
      const retryRes = await fetch(
        `${GRAPH_API}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${shortLivedToken}`
      );
      if (retryRes.ok) {
        const retryData = await retryRes.json();
        console.log(
          '[meta-oauth] Retry response:',
          JSON.stringify(retryData).slice(0, 500)
        );
        if (retryData.data?.length > 0) {
          pages.push(...retryData.data);
        }
      }
    }

    // Fallback 2: Try /me?fields=accounts (different endpoint format)
    if (pages.length === 0) {
      console.log('[meta-oauth] Trying /me?fields=accounts...');
      const meRes = await fetch(
        `${GRAPH_API}/me?fields=accounts{id,name,access_token,instagram_business_account}&access_token=${userToken}`
      );
      if (meRes.ok) {
        const meData = await meRes.json();
        console.log(
          '[meta-oauth] /me?fields=accounts response:',
          JSON.stringify(meData).slice(0, 500)
        );
        if (meData.accounts?.data?.length > 0) {
          pages.push(...meData.accounts.data);
        }
      }
    }

    // Fallback 3: Debug the token to see what pages it has access to
    if (pages.length === 0) {
      console.log('[meta-oauth] Debugging token...');
      const debugRes = await fetch(
        `${GRAPH_API}/debug_token?input_token=${userToken}&access_token=${appId}|${appSecret}`
      );
      if (debugRes.ok) {
        const debugData = await debugRes.json();
        console.log(
          '[meta-oauth] Token debug:',
          JSON.stringify(debugData).slice(0, 1000)
        );

        // Check granular_scopes for page IDs
        const granularScopes = debugData.data?.granular_scopes || [];
        const pageScope = granularScopes.find(
          (s: any) =>
            s.scope === 'pages_show_list' || s.scope === 'pages_messaging'
        );
        if (pageScope?.target_ids?.length > 0) {
          console.log(
            '[meta-oauth] Found page IDs in granular_scopes:',
            pageScope.target_ids
          );
          // Fetch each page directly
          for (const pageId of pageScope.target_ids) {
            try {
              const pageRes = await fetch(
                `${GRAPH_API}/${pageId}?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`
              );
              if (pageRes.ok) {
                const pageData = await pageRes.json();
                console.log(
                  '[meta-oauth] Direct page fetch:',
                  JSON.stringify(pageData).slice(0, 300)
                );
                if (pageData.id && pageData.access_token) {
                  pages.push(pageData);
                }
              } else {
                const pageErr = await pageRes.text();
                console.error(
                  `[meta-oauth] Failed to fetch page ${pageId}:`,
                  pageErr
                );
              }
            } catch (err) {
              console.error(`[meta-oauth] Error fetching page ${pageId}:`, err);
            }
          }
        }
      }
    }

    // Fallback 4: If we found page IDs in granular_scopes but couldn't fetch
    // page details (missing pages_read_engagement), save the user token + page ID.
    // The user token with pages_messaging permission CAN send DMs via the page.
    if (pages.length === 0) {
      // Check if we discovered page IDs from debug_token
      let discoveredPageId: string | null = null;
      try {
        const debugRes2 = await fetch(
          `${GRAPH_API}/debug_token?input_token=${userToken}&access_token=${appId}|${appSecret}`
        );
        if (debugRes2.ok) {
          const debugData2 = await debugRes2.json();
          const granularScopes2 = debugData2.data?.granular_scopes || [];
          const pageScope2 = granularScopes2.find(
            (s: any) =>
              s.scope === 'pages_show_list' || s.scope === 'pages_messaging'
          );
          if (pageScope2?.target_ids?.length > 0) {
            discoveredPageId = pageScope2.target_ids[0];
          }
        }
      } catch {
        // ignore
      }

      if (discoveredPageId) {
        // Save what we have — user token + page ID from granular_scopes
        console.log(
          `[meta-oauth] Saving with user token fallback for page ${discoveredPageId}`
        );

        await saveCredentials(
          state.accountId,
          'META',
          { accessToken: userToken },
          {
            pageId: discoveredPageId,
            pageName: `Page ${discoveredPageId}`,
            platform: 'FACEBOOK'
          }
        );

        // Subscribe the page to webhooks using the user token
        try {
          const subRes = await fetch(
            `${GRAPH_API}/${discoveredPageId}/subscribed_apps`,
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
                access_token: userToken
              })
            }
          );
          if (subRes.ok) {
            const subData = await subRes.json();
            console.log(
              `[meta-oauth] Subscribed page ${discoveredPageId} to webhooks (user token):`,
              subData
            );
          } else {
            const subErr = await subRes.text();
            console.error(
              `[meta-oauth] Failed to subscribe page ${discoveredPageId} to webhooks:`,
              subErr
            );
          }
        } catch (subError) {
          console.error(
            '[meta-oauth] Webhook subscription error (fallback):',
            subError
          );
        }

        console.log(
          `[meta-oauth] Saved user token + page ID ${discoveredPageId} for account ${state.accountId}`
        );

        return NextResponse.redirect(
          `${baseUrl}/dashboard/settings/integrations?connected=meta&page=${encodeURIComponent(`Page ${discoveredPageId}`)}`
        );
      }

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
    console.log(
      `[meta-oauth] Saving credentials for accountId=${state.accountId}, pageId=${pageId}, pageName=${pageName}`
    );
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

    // Step 4c: Also save INSTAGRAM credential if IG account is linked
    // This ensures the integrations page shows Instagram as "Connected" too
    if (igAccountId) {
      await saveCredentials(
        state.accountId,
        'INSTAGRAM',
        { accessToken: pageAccessToken },
        {
          igUserId: igAccountId,
          username: igUsername || '',
          name: igUsername || '',
          instagramAccountId: igAccountId,
          connectedVia: 'META_OAUTH'
        }
      );
      console.log(
        `[meta-oauth] Also saved INSTAGRAM credential for @${igUsername} (${igAccountId})`
      );
    }

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
        const igSubRes = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: 'messages',
            access_token: pageAccessToken
          })
        });
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
