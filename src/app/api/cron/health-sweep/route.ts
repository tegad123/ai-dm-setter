// ---------------------------------------------------------------------------
// GET /api/cron/health-sweep
// ---------------------------------------------------------------------------
// The SCHEDULED EXECUTOR for runHealthChecks. This is the gap F9-era review
// surfaced: runHealthChecks + rollupStatus already existed, but the ONLY caller
// was the admin account page (src/app/api/admin/accounts/[id]/route.ts) — so
// the checks only ran when a human happened to open that page. The
// distress_handled check in particular (FAIL when a distress conversation is
// still aiActive after >1h) had no automated evaluator at all.
//
// This route runs every 15 minutes, evaluates every active account, persists
// the rollup to Account.healthStatus / lastHealthCheck, and on any CRITICAL
// (a FAIL check) fires a throttled operator alert to Slack + Sentry. One alert
// per account per 1h so a sustained bad state doesn't spam.
//
// Env: CRON_SECRET (auth), one of QDMS_DAETRADEZ_ALERTS_SLACK_WEBHOOK_URL /
// OPERATOR_SLACK_WEBHOOK_URL / SLACK_WEBHOOK_URL (Slack), Sentry DSN (optional).
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import {
  runHealthChecks,
  rollupStatus,
  type HealthCheckResult
} from '@/lib/admin-health';
import { broadcastNotification } from '@/lib/realtime';
import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

const SLACK_WEBHOOK =
  process.env.QDMS_DAETRADEZ_ALERTS_SLACK_WEBHOOK_URL ||
  process.env.OPERATOR_SLACK_WEBHOOK_URL ||
  process.env.SLACK_WEBHOOK_URL ||
  null;

const ALERT_THROTTLE_MS = 60 * 60 * 1000; // hard floor between alerts (flap guard)
// An UNCHANGED failure set re-alerts at most daily. The old hourly re-alert
// produced 11+ identical "Health check FAILED" notifications per day for one
// persistent condition (8 distress holds), which buried the two real
// quality-gate alerts on Aug 6 — the operator stopped reading them.
const SAME_SIGNATURE_REMIND_MS = 24 * 60 * 60 * 1000;

// Stable identity of a failure state: which checks are failing, not their
// prose details (counts drift without the situation actually changing).
function failureSignature(failed: HealthCheckResult[]): string {
  return failed
    .map((f) => f.id)
    .sort()
    .join(',');
}

async function postSlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (err) {
    console.error('[cron/health-sweep] Slack post failed (non-fatal):', err);
  }
}

// One alert per account per check-type per hour. Reuses the Notification table
// as the throttle ledger (same pattern as meta-health's fireThrottledAlert).
async function fireThrottledAlert(
  accountId: string,
  accountName: string,
  failed: HealthCheckResult[]
): Promise<boolean> {
  const titlePrefix = 'Health check FAILED';
  const sig = failureSignature(failed);
  const last = await prisma.notification
    .findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title: { contains: titlePrefix }
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, body: true }
    })
    .catch(() => null);

  let stillFailing = false;
  if (last) {
    const age = Date.now() - last.createdAt.getTime();
    if (age < ALERT_THROTTLE_MS) return false;
    const lastSig = /\nsig:(.*)$/.exec(last.body ?? '')?.[1] ?? null;
    if (lastSig === sig) {
      if (age < SAME_SIGNATURE_REMIND_MS) return false;
      stillFailing = true;
    }
  }

  const failList = failed.map((f) => `• ${f.label}: ${f.detail}`).join('\n');
  const title = `${titlePrefix} — ${accountName}`;
  const body = `${
    stillFailing
      ? `STILL failing (unchanged 24h+), ${failed.length} check(s):`
      : `${failed.length} check(s) failing:`
  }\n${failList}\nsig:${sig}`;

  await prisma.notification
    .create({ data: { accountId, type: 'SYSTEM', title, body } })
    .catch((err) =>
      console.error('[cron/health-sweep] notification write failed:', err)
    );
  broadcastNotification(accountId, { type: 'SYSTEM', title });

  await postSlack(`:rotating_light: *${title}*\n${body}`);

  Sentry.captureMessage(`health-sweep CRITICAL: ${accountName}`, {
    level: 'error',
    tags: { cron: 'health-sweep', accountId },
    extra: { failed: failed.map((f) => ({ id: f.id, detail: f.detail })) }
  });
  // Cron functions can be torn down before Sentry's async transport flushes —
  // force it so the event isn't lost.
  await Sentry.flush(2000).catch(() => {});

  return true;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!token || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, healthStatus: true }
  });

  let critical = 0;
  let alertsFired = 0;
  const summary: Array<{ accountId: string; rollup: string; fails: number }> =
    [];

  for (const account of accounts) {
    try {
      const results = await runHealthChecks(account.id);
      const rollup = rollupStatus(results);
      const failed = results.filter((r) => r.status === 'FAIL');

      await prisma.account
        .update({
          where: { id: account.id },
          data: { healthStatus: rollup, lastHealthCheck: new Date() }
        })
        .catch((err) =>
          console.error(
            `[cron/health-sweep] persist failed for ${account.id}:`,
            err
          )
        );

      summary.push({
        accountId: account.id,
        rollup,
        fails: failed.length
      });

      if (rollup === 'CRITICAL') {
        critical += 1;
        const fired = await fireThrottledAlert(
          account.id,
          account.name,
          failed
        );
        if (fired) alertsFired += 1;
      } else if (account.healthStatus === 'CRITICAL') {
        // State change CRITICAL → healthy: announce recovery once. The
        // persisted healthStatus was just overwritten above, so a stable
        // recovery fires exactly one notice. 1h floor guards a flapping
        // check from producing a FAILED/RECOVERED pair every sweep.
        const since = new Date(Date.now() - ALERT_THROTTLE_MS);
        const recentRecovery = await prisma.notification
          .findFirst({
            where: {
              accountId: account.id,
              type: 'SYSTEM',
              title: { contains: 'Health check RECOVERED' },
              createdAt: { gte: since }
            },
            select: { id: true }
          })
          .catch(() => null);
        if (!recentRecovery) {
          const title = `Health check RECOVERED — ${account.name}`;
          const body = 'All health checks passing again.';
          await prisma.notification
            .create({
              data: { accountId: account.id, type: 'SYSTEM', title, body }
            })
            .catch((err) =>
              console.error(
                '[cron/health-sweep] recovery notification write failed:',
                err
              )
            );
          broadcastNotification(account.id, { type: 'SYSTEM', title });
          await postSlack(`:white_check_mark: *${title}*`);
        }
      }
    } catch (err) {
      console.error(
        `[cron/health-sweep] check run failed for ${account.id}:`,
        err
      );
    }
  }

  return NextResponse.json({
    ok: true,
    accountsChecked: accounts.length,
    critical,
    alertsFired,
    summary
  });
}
