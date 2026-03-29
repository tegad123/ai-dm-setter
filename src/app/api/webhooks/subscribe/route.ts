import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { decrypt } from '@/lib/credential-store';

// ---------------------------------------------------------------------------
// POST — Manually subscribe all connected pages to webhook events
// Call this if DMs are not arriving after OAuth connection
// ---------------------------------------------------------------------------

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export async function POST(request: NextRequest) {
  try {
    // Find all active META credentials
    const credentials = await prisma.integrationCredential.findMany({
      where: { provider: 'META', isActive: true }
    });

    if (credentials.length === 0) {
      return NextResponse.json(
        { error: 'No META credentials found. Connect via Meta OAuth first.' },
        { status: 404 }
      );
    }

    const results: Array<{
      pageId: string;
      pageName: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const cred of credentials) {
      const meta = cred.metadata as any;
      const pageId = meta?.pageId;
      const pageName = meta?.pageName || 'Unknown';

      if (!pageId) {
        results.push({ pageId: 'N/A', pageName, success: false, error: 'No pageId in metadata' });
        continue;
      }

      // Decrypt the access token
      let accessToken: string;
      try {
        const decrypted = JSON.parse(decrypt(cred.credentials as string));
        accessToken = decrypted.accessToken;
      } catch {
        results.push({ pageId, pageName, success: false, error: 'Failed to decrypt credentials' });
        continue;
      }

      // Subscribe the page to webhooks
      try {
        const res = await fetch(`${GRAPH_API}/${pageId}/subscribed_apps`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads',
            access_token: accessToken
          })
        });

        if (res.ok) {
          const data = await res.json();
          console.log(`[webhook-subscribe] Page ${pageId} (${pageName}) subscribed:`, data);
          results.push({ pageId, pageName, success: true });
        } else {
          const errText = await res.text();
          console.error(`[webhook-subscribe] Page ${pageId} failed:`, errText);
          results.push({ pageId, pageName, success: false, error: errText });
        }
      } catch (err) {
        results.push({ pageId, pageName, success: false, error: String(err) });
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
