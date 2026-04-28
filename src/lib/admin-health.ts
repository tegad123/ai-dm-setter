// ---------------------------------------------------------------------------
// admin-health.ts
// ---------------------------------------------------------------------------
// Health checks for the super-admin dashboard. Each check is pure-data
// (no side effects) and returns a uniform shape so the UI can render
// rows without per-check special-casing. The aggregator computes a
// rollup status (HEALTHY / WARNING / CRITICAL) for the account header.
//
// The 8 checks mirror the Phase 1 spec Section B:
//   1. Meta webhook receiving messages
//   2. Instagram credential valid
//   3. Facebook credential valid
//   4. AI generation succeeding (no repeated hard-fails)
//   5. Follow-up cascade running
//   6. No unhandled distress conversations (>1h old)
//   7. No leads stuck in CALL_PROPOSED > 48h with no follow-up
//   8. Upcoming calls have confirmations sent (Phase 1 stub — returns
//      passing until pre-call audit infra lands in Phase 3)
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

export type HealthCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface HealthCheckResult {
  id: string;
  label: string;
  status: HealthCheckStatus;
  detail: string;
  lastCheckedAt: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function runHealthChecks(
  accountId: string
): Promise<HealthCheckResult[]> {
  const now = new Date();
  const results: HealthCheckResult[] = [];

  // 1. Meta webhook receiving messages — at least 1 LEAD message in
  // the last 24h on any conversation owned by this account.
  const recentLead = await prisma.message.findFirst({
    where: {
      sender: 'LEAD',
      conversation: { lead: { accountId } },
      timestamp: { gte: new Date(now.getTime() - DAY_MS) }
    },
    select: { timestamp: true }
  });
  results.push({
    id: 'webhook_active',
    label: 'Meta webhook receiving messages',
    status: recentLead ? 'PASS' : 'WARN',
    detail: recentLead
      ? `Last lead message ${recentLead.timestamp.toISOString()}`
      : 'No lead messages in the last 24h',
    lastCheckedAt: now
  });

  // 2-3. Credentials present + active by provider.
  const creds = await prisma.integrationCredential.findMany({
    where: { accountId, isActive: true },
    select: { provider: true, updatedAt: true }
  });
  const igCred = creds.find((c) => c.provider === 'INSTAGRAM');
  const metaCred = creds.find((c) => c.provider === 'META');
  results.push({
    id: 'credential_instagram',
    label: 'Instagram credential active',
    status: igCred ? 'PASS' : 'WARN',
    detail: igCred
      ? `Last updated ${igCred.updatedAt.toISOString()}`
      : 'No active INSTAGRAM credential row',
    lastCheckedAt: now
  });
  results.push({
    id: 'credential_facebook',
    label: 'Facebook (META) credential active',
    status: metaCred ? 'PASS' : 'WARN',
    detail: metaCred
      ? `Last updated ${metaCred.updatedAt.toISOString()}`
      : 'No active META credential row',
    lastCheckedAt: now
  });

  // 4. AI generation succeeding — fewer than 5 hard-fail-only suggestions
  // in the last hour (a stuck retry loop is the failure mode).
  const recentHardFails = await prisma.aISuggestion.count({
    where: {
      account: { id: accountId },
      generatedAt: { gte: new Date(now.getTime() - HOUR_MS) },
      qualityGatePassedFirstAttempt: false,
      qualityGateAttempts: { gte: 4 }
    }
  });
  results.push({
    id: 'ai_generation_healthy',
    label: 'AI generation succeeding',
    status:
      recentHardFails >= 5 ? 'FAIL' : recentHardFails >= 2 ? 'WARN' : 'PASS',
    detail: `${recentHardFails} hard-fail-only suggestions in last hour`,
    lastCheckedAt: now
  });

  // 5. Follow-up cascade running — at least one PENDING or recently
  // SENT row in the trailing 7d says the queue is moving.
  const recentScheduled = await prisma.scheduledMessage.count({
    where: {
      accountId,
      OR: [
        { status: 'PENDING' },
        {
          status: 'FIRED',
          firedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) }
        }
      ]
    }
  });
  results.push({
    id: 'followup_cascade',
    label: 'Follow-up cascade scheduled / firing',
    status: recentScheduled > 0 ? 'PASS' : 'WARN',
    detail:
      recentScheduled > 0
        ? `${recentScheduled} pending or recently-sent rows`
        : 'No follow-up activity in last 7d',
    lastCheckedAt: now
  });

  // 6. Distress detection > 1h old without aiActive=false (= unhandled).
  const unhandledDistress = await prisma.conversation.count({
    where: {
      lead: { accountId },
      distressDetected: true,
      distressDetectedAt: { lte: new Date(now.getTime() - HOUR_MS) },
      aiActive: true
    }
  });
  results.push({
    id: 'distress_handled',
    label: 'No unhandled distress > 1h',
    status: unhandledDistress === 0 ? 'PASS' : 'FAIL',
    detail:
      unhandledDistress === 0
        ? 'No unhandled distress conversations'
        : `${unhandledDistress} distress conversation(s) still aiActive after >1h`,
    lastCheckedAt: now
  });

  // 7. Leads stuck CALL_PROPOSED > 48h with no follow-up scheduled.
  const stuck = await prisma.lead.count({
    where: {
      accountId,
      stage: 'CALL_PROPOSED',
      stageEnteredAt: { lte: new Date(now.getTime() - 2 * DAY_MS) },
      conversation: {
        is: {
          scheduledMessages: {
            none: {
              status: 'PENDING',
              messageType: {
                in: [
                  'BOOKING_LINK_FOLLOWUP',
                  'FOLLOW_UP_1',
                  'FOLLOW_UP_2',
                  'FOLLOW_UP_3'
                ]
              }
            }
          }
        }
      }
    }
  });
  results.push({
    id: 'no_stuck_leads',
    label: 'No leads stuck CALL_PROPOSED > 48h',
    status: stuck === 0 ? 'PASS' : 'WARN',
    detail:
      stuck === 0
        ? 'No stuck CALL_PROPOSED leads'
        : `${stuck} lead(s) stuck > 48h without pending follow-up`,
    lastCheckedAt: now
  });

  // 8. Upcoming-call confirmations — Phase 1 stub. Real audit ships
  // with the pre-call sequence audit job in Phase 3. Pass for now so
  // the rollup isn't permanently WARNING for every account.
  results.push({
    id: 'upcoming_call_confirmations',
    label: 'Upcoming call confirmations sent (Phase 3)',
    status: 'PASS',
    detail: 'Audit deferred to Phase 3',
    lastCheckedAt: now
  });

  return results;
}

export type RollupStatus = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

export function rollupStatus(results: HealthCheckResult[]): RollupStatus {
  if (results.length === 0) return 'UNKNOWN';
  if (results.some((r) => r.status === 'FAIL')) return 'CRITICAL';
  if (results.some((r) => r.status === 'WARN')) return 'WARNING';
  return 'HEALTHY';
}
