import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { requireAuth, AuthError } from '@/lib/auth-guard';

// ---------------------------------------------------------------------------
// POST — Manually subscribe all connected pages to webhook events
// Call this if DMs are not arriving after OAuth connection
// ---------------------------------------------------------------------------
//
// SECURITY: gated behind `requireAuth` and scoped to the caller's
// accountId. Previously this endpoint was unauthenticated AND
// iterated every active META/INSTAGRAM credential across all
// accounts — anyone could trigger a re-subscribe sweep, and (worse)
// learn the page-id surface of all tenants from the response body.
// Both leaks closed.
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.facebook.com/v21.0';
const IG_GRAPH_API = 'https://graph.instagram.com/v21.0';

export async function POST(request: NextRequest) {
  try {
    let auth;
    try {
      auth = await requireAuth(request);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json(
          { error: err.message },
          { status: err.status }
        );
      }
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Tenant-scoped: only the caller's own account credentials.
    const credentials = await prisma.integrationCredential.findMany({
      where: {
        accountId: auth.accountId,
        provider: { in: ['META', 'INSTAGRAM'] },
        isActive: true
      }
    });

    if (credentials.length === 0) {
      return NextResponse.json(
        {
          error: 'No META/INSTAGRAM credentials found. Connect via OAuth first.'
        },
        { status: 404 }
      );
    }

    const results: Array<{
      provider: string;
      pageId: string;
      pageName: string;
      success: boolean;
      details?: string;
      error?: string;
    }> = [];

    for (const cred of credentials) {
      const meta = (cred.metadata as any) || {};
      const pageName = meta.pageName || meta.username || 'Unknown';

      // Use getCredentials to properly handle encrypted data
      const decrypted = await getCredentials(cred.accountId, cred.provider);
      if (!decrypted?.accessToken) {
        results.push({
          provider: cred.provider,
          pageId: 'N/A',
          pageName,
          success: false,
          error: 'No access token found in credentials'
        });
        continue;
      }

      const accessToken = decrypted.accessToken as string;

      // ── Subscribe Facebook Page (META provider) ──
      if (cred.provider === 'META') {
        const pageId = meta.pageId;
        if (!pageId) {
          results.push({
            provider: 'META',
            pageId: 'N/A',
            pageName,
            success: false,
            error: 'No pageId in metadata'
          });
          continue;
        }

        try {
          const res = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subscribed_fields:
                'messages,message_echoes,messaging_postbacks,messaging_optins,message_deliveries,message_reads',
              access_token: accessToken
            })
          });

          const body = await res.text();
          if (res.ok) {
            console.log(
              `[webhook-subscribe] META page ${pageId} (${pageName}) subscribed:`,
              body
            );
            results.push({
              provider: 'META',
              pageId,
              pageName,
              success: true,
              details: body
            });
          } else {
            console.error(
              `[webhook-subscribe] META page ${pageId} failed:`,
              body
            );
            results.push({
              provider: 'META',
              pageId,
              pageName,
              success: false,
              error: body
            });
          }
        } catch (err) {
          results.push({
            provider: 'META',
            pageId,
            pageName,
            success: false,
            error: String(err)
          });
        }

        // Also subscribe the IG business account if available
        const igAccountId = meta.instagramAccountId;
        if (igAccountId) {
          try {
            const igRes = await fetch(
              `${GRAPH_API}/${igAccountId}/subscribed_apps`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  subscribed_fields:
                    'messages,message_echoes,messaging_postbacks,messaging_optins',
                  access_token: accessToken
                })
              }
            );
            const igBody = await igRes.text();
            console.log(
              `[webhook-subscribe] IG account ${igAccountId} subscription:`,
              igRes.status,
              igBody
            );
            results.push({
              provider: 'META/IG',
              pageId: igAccountId,
              pageName: meta.instagramUsername || pageName,
              success: igRes.ok,
              details: igRes.ok ? igBody : undefined,
              error: igRes.ok ? undefined : igBody
            });
          } catch (err) {
            console.log(
              `[webhook-subscribe] IG account ${igAccountId} subscription failed:`,
              err
            );
          }
        }
      }

      // ── Subscribe Instagram account (INSTAGRAM provider) ──
      // IG Login API direct path: works without a linked Facebook Page.
      // Always re-resolve igBusinessAccountId from /me?fields=user_id —
      // the value may be stale or missing in metadata, and only the 17841
      // ID works for both POST /subscribed_apps and webhook entry.id matching.
      if (cred.provider === 'INSTAGRAM') {
        let igBizId: string | null = null;
        let resolveDetail = '';
        try {
          const meRes = await fetch(
            `${IG_GRAPH_API}/me?fields=user_id,username&access_token=${accessToken}`
          );
          const meBody = await meRes.text();
          if (meRes.ok) {
            const me = JSON.parse(meBody) as { user_id?: string };
            if (me.user_id && /^17841\d+$/.test(String(me.user_id))) {
              igBizId = String(me.user_id);
            } else {
              resolveDetail = `Non-17841 from /me?fields=user_id: ${meBody.slice(0, 200)}`;
            }
          } else {
            resolveDetail = `/me?fields=user_id HTTP ${meRes.status}: ${meBody.slice(0, 200)}`;
          }
        } catch (err) {
          resolveDetail = `resolve threw: ${(err as Error).message}`;
        }

        if (!igBizId) {
          results.push({
            provider: 'INSTAGRAM',
            pageId: 'N/A',
            pageName,
            success: false,
            error: `Could not resolve IG Business Account ID. ${resolveDetail}`
          });
          continue;
        }

        try {
          const subUrl =
            `${IG_GRAPH_API}/${igBizId}/subscribed_apps?` +
            new URLSearchParams({
              subscribed_fields:
                'messages,messaging_postbacks,message_reactions,messaging_seen,messaging_referral',
              access_token: accessToken
            });
          const subRes = await fetch(subUrl, { method: 'POST' });
          const subBody = await subRes.text();
          if (subRes.ok) {
            console.log(
              `[webhook-subscribe] INSTAGRAM ${igBizId} (${pageName}) subscribed:`,
              subBody
            );
            // Persist the resolved ID so the webhook router can match entry.id
            if (meta.igBusinessAccountId !== igBizId) {
              await prisma.integrationCredential.update({
                where: { id: cred.id },
                data: { metadata: { ...meta, igBusinessAccountId: igBizId } }
              });
            }
            results.push({
              provider: 'INSTAGRAM',
              pageId: igBizId,
              pageName,
              success: true,
              details: subBody
            });
          } else {
            console.error(
              `[webhook-subscribe] INSTAGRAM ${igBizId} subscription failed:`,
              subBody
            );
            results.push({
              provider: 'INSTAGRAM',
              pageId: igBizId,
              pageName,
              success: false,
              error: subBody
            });
          }
        } catch (err) {
          results.push({
            provider: 'INSTAGRAM',
            pageId: igBizId,
            pageName,
            success: false,
            error: String(err)
          });
        }
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error('[webhook-subscribe] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
