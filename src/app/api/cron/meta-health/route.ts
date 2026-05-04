// ---------------------------------------------------------------------------
// GET /api/cron/meta-health
// ---------------------------------------------------------------------------
// Proactive health check for every account's Meta credentials. Runs every
// 15 minutes. For each active META / INSTAGRAM credential row:
//
//   1. GET /debug_token?input_token=<token> — verify the token is still
//      valid. A 400 / {is_valid: false} means the session has been
//      invalidated (password change, Meta security reset, 60-day
//      long-lived expiry). When that happens, Meta ALSO silently stops
//      forwarding webhooks to our endpoint — so outbound sends AND
//      inbound DMs both die. Pre-this-cron, we only discovered this
//      because the operator noticed leads weren't getting replied to.
//      Now: operator sees a dashboard notification within 15 min of the
//      token going bad.
//
//   2. GET /{pageId}/subscribed_apps — confirm the page is still
//      subscribed to `messages` / `message_echoes`. Meta sometimes
//      severs this subscription even when the token itself is still
//      valid (rare, but worth catching). Fires a separate alert.
//
// Rate-limited: one notification per account per check type per hour,
// so a sustained bad-token state doesn't spam the operator's inbox.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { getMetaAccessToken } from '@/lib/credential-store';
import { broadcastNotification } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const GRAPH_API = 'https://graph.facebook.com/v22.0';
const REQUIRED_WEBHOOK_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks'
];

async function fireThrottledAlert(
  accountId: string,
  titlePrefix: string,
  title: string,
  body: string
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const existing = await prisma.notification
    .findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title: { contains: titlePrefix },
        createdAt: { gte: oneHourAgo }
      },
      select: { id: true }
    })
    .catch(() => null);
  if (existing) return false;

  await prisma.notification.create({
    data: {
      accountId,
      type: 'SYSTEM',
      title,
      body
    }
  });
  broadcastNotification(accountId, { type: 'SYSTEM', title });
  return true;
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      console.error('[cron/meta-health] META_APP_ID/SECRET not configured');
      return NextResponse.json(
        { error: 'platform not configured' },
        { status: 500 }
      );
    }
    const appAccessToken = `${appId}|${appSecret}`;

    // Every active Meta-family credential. Group by account so we fire
    // at most one "token bad" alert per account even if both META and
    // INSTAGRAM rows are dead (same root cause).
    const creds = await prisma.integrationCredential.findMany({
      where: {
        provider: { in: ['META', 'INSTAGRAM'] },
        isActive: true
      },
      select: {
        id: true,
        accountId: true,
        provider: true,
        metadata: true
      }
    });

    const alertedAccounts = new Set<string>();
    let checked = 0;
    let tokenBad = 0;
    let subscriptionBad = 0;

    for (const cred of creds) {
      checked++;
      const accessToken = await getMetaAccessToken(cred.accountId);
      if (!accessToken) {
        // No token stored — nothing to probe. Not an error (fresh
        // account, no Meta connection yet).
        continue;
      }

      // ── 1. Token validity ───────────────────────────────────────
      try {
        const dbgRes = await fetch(
          `${GRAPH_API}/debug_token?input_token=${accessToken}&access_token=${appAccessToken}`
        );
        const dbgBody = await dbgRes.text();
        let parsed: { data?: { is_valid?: boolean; error?: unknown } } = {};
        try {
          parsed = JSON.parse(dbgBody);
        } catch {
          // fallthrough
        }
        const isValid = parsed?.data?.is_valid === true;
        if (!isValid) {
          tokenBad++;
          if (!alertedAccounts.has(cred.accountId)) {
            const fired = await fireThrottledAlert(
              cred.accountId,
              'Meta credential invalidated',
              'Meta credential invalidated — reconnect required',
              `Health check: Meta access token for this account is no longer valid. Debug_token response: ${dbgBody.slice(0, 400)}. Until you reconnect via Settings → Integrations, AI replies WILL NOT deliver and new inbound DMs may not reach the app.`
            );
            if (fired) alertedAccounts.add(cred.accountId);
          }
          // No point checking webhook subscription if the token is dead
          // (the check would just return 400).
          continue;
        }
      } catch (err) {
        console.error(
          `[cron/meta-health] debug_token threw for account ${cred.accountId}:`,
          err
        );
        continue;
      }

      // ── 2. Webhook subscription check — META provider only ─────
      // /{pageId}/subscribed_apps with the Page token returns the apps
      // subscribed to this Page + the fields they're subscribed to.
      // If our app ID is missing OR `messages` is missing from the
      // subscribed_fields, Meta isn't forwarding webhooks to us.
      if (cred.provider === 'META') {
        const meta = (cred.metadata as Record<string, unknown> | null) ?? {};
        const pageId = meta.pageId as string | undefined;
        if (!pageId) continue;

        try {
          const subRes = await fetch(
            `${GRAPH_API}/${pageId}/subscribed_apps?access_token=${accessToken}`
          );
          if (!subRes.ok) {
            const errBody = await subRes.text();
            console.warn(
              `[cron/meta-health] subscribed_apps fetch failed (${subRes.status}) for page ${pageId}: ${errBody.slice(0, 200)}`
            );
            continue;
          }
          const subData = await subRes.json();
          const apps = (subData?.data ?? []) as Array<{
            id?: string;
            subscribed_fields?: string[];
          }>;
          const ourApp = apps.find((a) => a.id === appId);
          const subscribedFields = ourApp?.subscribed_fields ?? [];
          const missing = REQUIRED_WEBHOOK_FIELDS.filter(
            (f) => !subscribedFields.includes(f)
          );
          if (!ourApp || missing.length > 0) {
            subscriptionBad++;
            if (!alertedAccounts.has(cred.accountId)) {
              await fireThrottledAlert(
                cred.accountId,
                'Webhook subscription broken',
                'Webhook subscription broken — reconnect Meta',
                `Health check: page ${pageId} is ${ourApp ? `missing webhook fields: ${missing.join(', ')}` : 'not subscribed to this app at all'}. New inbound DMs will NOT reach the app. Reconnect via Settings → Integrations to re-subscribe.`
              );
              alertedAccounts.add(cred.accountId);
            }
          }
        } catch (err) {
          console.error(
            `[cron/meta-health] subscribed_apps threw for page ${pageId}:`,
            err
          );
        }
      }
    }

    return NextResponse.json({
      ok: true,
      checked,
      tokenBad,
      subscriptionBad,
      alerted: alertedAccounts.size
    });
  } catch (err) {
    console.error('[cron/meta-health] fatal:', err);
    return NextResponse.json(
      { error: 'meta-health cron failed' },
      {
        status: 500
      }
    );
  }
}
