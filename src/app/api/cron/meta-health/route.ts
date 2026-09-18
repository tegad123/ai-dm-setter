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
// Rate-limited: invalid-token notices can fire once per hour. An unchanged
// subscription incident fires once per 24 hours, while a changed missing-field
// fingerprint can alert immediately with the new impact.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { getMetaAccessToken } from '@/lib/credential-store';
import { broadcastNotification } from '@/lib/realtime';
import { checkTokenHealth } from '@/lib/meta-token-health';
import {
  assessMetaWebhookSubscription,
  META_SUBSCRIPTION_ALERT_THROTTLE_MS
} from '@/lib/meta-webhook-subscription';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const GRAPH_API = 'https://graph.facebook.com/v22.0';
async function fireThrottledAlert(
  accountId: string,
  titlePrefix: string,
  title: string,
  body: string,
  throttleMs = 60 * 60 * 1000,
  matchExactTitle = false
): Promise<boolean> {
  const throttleStart = new Date(Date.now() - throttleMs);
  const existing = await prisma.notification
    .findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title: matchExactTitle ? titlePrefix : { contains: titlePrefix },
        createdAt: { gte: throttleStart }
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
    let transientSkipped = 0;
    let subscriptionBad = 0;

    for (const cred of creds) {
      checked++;
      const accessToken = await getMetaAccessToken(cred.accountId);
      if (!accessToken) {
        // No token stored — nothing to probe. Not an error (fresh
        // account, no Meta connection yet).
        continue;
      }

      // ── 1. Token validity (QD-005: retry-with-backoff + error-code
      // classification via checkTokenHealth helper). The helper
      // retries up to 3x on transient Meta errors (code 2, code 4,
      // HTTP 5xx, fetch throws) before giving up. Only `revoked`
      // results fire the operator-facing alert — `transient_exhausted`
      // is logged and the next 15-min cron tick re-checks.
      const health = await checkTokenHealth({
        accessToken,
        appAccessToken,
        graphApiBase: GRAPH_API
      });
      if (!health.ok) {
        if (health.reason === 'revoked') {
          tokenBad++;
          if (!alertedAccounts.has(cred.accountId)) {
            const fired = await fireThrottledAlert(
              cred.accountId,
              'Meta credential invalidated',
              'Meta credential invalidated — reconnect required',
              `Health check: Meta access token for this account is no longer valid (${health.details}). Until you reconnect via Settings → Integrations, AI replies WILL NOT deliver and new inbound DMs may not reach the app.`
            );
            if (fired) alertedAccounts.add(cred.accountId);
          }
        } else {
          // transient_exhausted — Meta-side hiccup that didn't clear
          // within 3 retries. Log + count, but DO NOT alert the
          // operator. The next cron tick (15 min) will probe again.
          transientSkipped++;
          console.warn(
            `[cron/meta-health] transient probe failure for account ${cred.accountId} (suppressed alert): ${health.lastError}`
          );
        }
        // No point checking webhook subscription if we can't verify
        // the token (revoked: subsequent call would 401; transient:
        // would just compound the noise).
        continue;
      }

      // ── 1b. Instagram-Login token probe (IG parity day 3, 2026-09-11) ──
      // getMetaAccessToken() prefers the META token, so an account with both
      // rows never had its INSTAGRAM (IGAA) token checked, and IGAA tokens
      // must be probed on graph.instagram.com, not graph.facebook.com. On
      // 2026-09-09 three of four IG-Login tokens in prod were invalidated
      // (Meta code 190) with nothing surfacing it: webhooks still arrived,
      // no reply could ever send. Probe the row's own token and alert.
      if (cred.provider === 'INSTAGRAM') {
        try {
          const { getCredentials } = await import('@/lib/credential-store');
          const igCreds = await getCredentials(cred.accountId, 'INSTAGRAM');
          const igToken = igCreds?.accessToken as string | undefined;
          if (igToken) {
            const igRes = await fetch(
              `https://graph.instagram.com/v21.0/me?fields=id&access_token=${encodeURIComponent(igToken)}`
            );
            const igBody: any = await igRes.json().catch(() => ({}));
            const code = igBody?.error?.code;
            if (!igRes.ok && (code === 190 || igRes.status === 401)) {
              tokenBad++;
              if (!alertedAccounts.has(cred.accountId)) {
                const fired = await fireThrottledAlert(
                  cred.accountId,
                  'Instagram credential invalidated',
                  'Instagram credential invalidated — reconnect required',
                  `Health check: the Instagram access token for this account is no longer valid (Meta code ${code ?? igRes.status}: ${String(igBody?.error?.message ?? '').slice(0, 120)}). Instagram DMs still arrive, but NO reply can be delivered until you reconnect Instagram via Settings → Integrations.`
                );
                if (fired) alertedAccounts.add(cred.accountId);
              }
            }
          }
        } catch (igErr) {
          console.warn(
            `[cron/meta-health] Instagram token probe threw for account ${cred.accountId} (suppressed):`,
            igErr instanceof Error ? igErr.message : igErr
          );
        }
      }

      // ── 2. Webhook subscription check — META provider only ─────
      // /{pageId}/subscribed_apps with the Page token returns the apps
      // subscribed to this Page + the fields they're subscribed to.
      // Each required field has a different impact. `messages` carries lead
      // DMs, `message_echoes` carries Page-side sends, and
      // `messaging_postbacks` carries button interactions.
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
          const assessment = assessMetaWebhookSubscription({
            pageId,
            appSubscribed: Boolean(ourApp),
            subscribedFields: ourApp?.subscribed_fields
          });
          if (!assessment.healthy) {
            subscriptionBad++;
            if (
              !alertedAccounts.has(cred.accountId) &&
              assessment.alertTitle &&
              assessment.alertBody
            ) {
              const fired = await fireThrottledAlert(
                cred.accountId,
                assessment.alertTitle,
                assessment.alertTitle,
                assessment.alertBody,
                META_SUBSCRIPTION_ALERT_THROTTLE_MS,
                true
              );
              if (fired) alertedAccounts.add(cred.accountId);
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
      transientSkipped,
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
