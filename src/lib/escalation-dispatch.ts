// ---------------------------------------------------------------------------
// escalation-dispatch.ts
// ---------------------------------------------------------------------------
// Unified dispatch for operator-facing alerts that need to reach the
// operator outside the dashboard (via email) in addition to the
// standard in-app Notification row.
//
// Tiers:
//   CRITICAL  — external email (if configured) + in-app notification.
//               Used for distress, scheduling-conflict, AI-stuck.
//   HIGH      — external email (if the specific pref is on) + in-app.
//               Used for stuck leads, operator-requested handoff.
//   NORMAL    — in-app only. Routine paused/reviewed/reminder items.
//
// Each escalation maps to a `notifyOn*` flag on the Account so the
// operator can mute the ones they don't want. If the flag is off we
// still create the in-app Notification but skip email.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { sendEmail } from '@/lib/email-notifier';
import { broadcastNotification } from '@/lib/realtime';

export type EscalationType = 'scheduling_conflict' | 'distress' | 'ai_stuck';

export type UrgencyTier = 'CRITICAL';

/**
 * Short human-facing label used in the email subject / notification
 * title. Matches the URGENT group copy on the notification settings
 * page so the alert wording is consistent between in-app and email.
 */
const LABEL: Record<EscalationType, string> = {
  scheduling_conflict: 'Scheduling conflict',
  distress: 'Distress signal detected',
  ai_stuck: 'Lead stuck — AI cannot help'
};

interface EscalateInput {
  type: EscalationType;
  accountId: string;
  leadId?: string;
  conversationId?: string;
  /** Lead display name (used in email subject + body header). */
  leadName?: string;
  /** Lead platform handle (used in email body). */
  leadHandle?: string;
  /** Short title used for the in-app Notification. */
  title: string;
  /** Multi-line body for the email + Notification.body. */
  body: string;
  /** Specific context line for the email "Details:" row. */
  details?: string;
  /** Optional deep link to open the conversation. */
  link?: string;
}

interface EscalateResult {
  notificationId: string | null;
  emailOk: boolean;
  emailError?: string;
  tier: UrgencyTier;
  channels: string[];
}

/**
 * Single entrypoint. Always writes the in-app Notification row (that's
 * cheap + reliable). Conditionally fires the email based on per-account
 * preference toggles. Email always goes to the account owner's
 * registered email (User.email) — there is no separate notification
 * email field. Never throws — failures log and return a partial result
 * so callers can still ship the conversation forward.
 */
export async function escalate(input: EscalateInput): Promise<EscalateResult> {
  const tier: UrgencyTier = 'CRITICAL';
  const channels: string[] = ['notification'];

  // 1. In-app Notification (always).
  let notificationId: string | null = null;
  try {
    const n = await prisma.notification.create({
      data: {
        accountId: input.accountId,
        type: 'SYSTEM',
        title: input.title,
        body: input.body,
        leadId: input.leadId
      }
    });
    notificationId = n.id;
    broadcastNotification(input.accountId, {
      type: 'SYSTEM',
      title: input.title
    });
  } catch (err) {
    console.error('[escalate] notification write failed:', err);
  }

  // 2. Email (preference gated).
  const target = await resolveEmailTarget(input.type, input.accountId);
  if (!target.shouldSend) {
    return {
      notificationId,
      emailOk: false,
      emailError: target.reason,
      tier,
      channels
    };
  }

  const subject = buildSubject(input.type, input.leadName);
  const text = buildTextBody({
    type: input.type,
    leadName: input.leadName,
    leadHandle: input.leadHandle,
    details: input.details ?? input.body,
    link: input.link
  });
  const res = await sendEmail({ to: target.to, subject, text });
  if (res.ok) channels.push('email');
  return {
    notificationId,
    emailOk: res.ok,
    emailError: res.error ?? res.skipped,
    tier,
    channels
  };
}

// ── Email target resolution ────────────────────────────────────────
interface EmailTarget {
  shouldSend: boolean;
  to: string;
  reason?: string;
}

async function resolveEmailTarget(
  type: EscalationType,
  accountId: string
): Promise<EmailTarget> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      notifyOnSchedulingConflict: true,
      notifyOnDistress: true,
      notifyOnAIStuck: true
    }
  });
  if (!account) return { shouldSend: false, to: '', reason: 'no_account' };

  const prefMap: Record<EscalationType, boolean> = {
    scheduling_conflict: account.notifyOnSchedulingConflict,
    distress: account.notifyOnDistress,
    ai_stuck: account.notifyOnAIStuck
  };
  if (!prefMap[type]) {
    return { shouldSend: false, to: '', reason: `preference_off:${type}` };
  }

  // Destination = the account owner's registered email. Picks the
  // oldest ADMIN user, falling back to the oldest user of any role.
  // (Multi-operator workspaces typically have one ADMIN and several
  // SETTERs — the ADMIN is the notification target.)
  const owner =
    (await prisma.user.findFirst({
      where: { accountId, role: 'ADMIN' },
      orderBy: { createdAt: 'asc' },
      select: { email: true }
    })) ??
    (await prisma.user.findFirst({
      where: { accountId },
      orderBy: { createdAt: 'asc' },
      select: { email: true }
    }));

  if (!owner?.email) {
    return { shouldSend: false, to: '', reason: 'no_owner_email' };
  }
  return { shouldSend: true, to: owner.email };
}

// ── Subject + body formatting ──────────────────────────────────────
function buildSubject(type: EscalationType, leadName?: string): string {
  const who = leadName ?? 'lead';
  return `🚨 ${LABEL[type]} — ${who} | QualifyDMs`;
}

function buildTextBody(params: {
  type: EscalationType;
  leadName?: string;
  leadHandle?: string;
  details: string;
  link?: string;
}): string {
  const lead = params.leadName ?? '(unknown)';
  const handle = params.leadHandle ? ` (@${params.leadHandle})` : '';
  const linkBlock = params.link ? `\n\nView conversation → ${params.link}` : '';
  const now = new Date().toLocaleString('en-US', {
    timeZone: 'UTC',
    hour12: false,
    dateStyle: 'medium',
    timeStyle: 'short'
  });
  return `Lead: ${lead}${handle}
Alert: ${LABEL[params.type]}
Details: ${params.details}
Time: ${now} UTC${linkBlock}

—
QualifyDMs · Manage notification settings: https://qualifydms.io/dashboard/settings/notifications`;
}
