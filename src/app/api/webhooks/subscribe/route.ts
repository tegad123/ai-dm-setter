import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';

// ---------------------------------------------------------------------------
// POST — Manually subscribe all connected pages to webhook events
// Call this if DMs are not arriving after OAuth connection
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export async function POST(request: NextRequest) {
  try {
    // Find all active META and INSTAGRAM credentials
    const credentials = await prisma.integrationCredential.findMany({
      where: { provider: { in: ['META', 'INSTAGRAM'] }, isActive: true }
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
      if (cred.provider === 'INSTAGRAM') {
        const igUserId =
          meta.igUserId || meta.igBusinessAccountId || meta.instagramAccountId;
        if (!igUserId) {
          results.push({
            provider: 'INSTAGRAM',
            pageId: 'N/A',
            pageName,
            success: false,
            error: 'No IG user ID in metadata'
          });
          continue;
        }

        // Log what we have for debugging
        results.push({
          provider: 'INSTAGRAM',
          pageId: igUserId,
          pageName,
          success: true,
          details: `IG credential found. Token starts: ${accessToken.slice(0, 8)}... metadata: ${JSON.stringify(meta).slice(0, 200)}`
        });
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
