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

export type EscalationType =
  | 'scheduling_conflict'
  | 'distress'
  | 'stuck_lead_24h'
  | 'ai_stuck'
  | 'ai_paused_generic';

export type UrgencyTier = 'CRITICAL' | 'HIGH' | 'NORMAL';

const TIER: Record<EscalationType, UrgencyTier> = {
  scheduling_conflict: 'CRITICAL',
  distress: 'CRITICAL',
  ai_stuck: 'CRITICAL',
  stuck_lead_24h: 'HIGH',
  ai_paused_generic: 'NORMAL'
};

interface EscalateInput {
  type: EscalationType;
  accountId: string;
  leadId?: string;
  conversationId?: string;
  /** Short title, shown in dashboard + as email subject line. */
  title: string;
  /** Multi-line body for the email + Notification.body. */
  body: string;
  /** Optional deep link path (e.g. /dashboard/conversations/<id>). */
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
 * cheap + reliable). Conditionally fires the email based on tier +
 * per-account preferences. Never throws — failures log and return a
 * partial result so callers can still ship the conversation forward.
 */
export async function escalate(input: EscalateInput): Promise<EscalateResult> {
  const tier = TIER[input.type];
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
    broadcastNotification({
      accountId: input.accountId,
      type: 'SYSTEM',
      title: input.title
    });
  } catch (err) {
    console.error('[escalate] notification write failed:', err);
  }

  // 2. Email (tier + preference gated).
  const emailTarget = await shouldEmail(input.type, input.accountId);
  if (!emailTarget.shouldSend) {
    return {
      notificationId,
      emailOk: false,
      emailError: emailTarget.reason,
      tier,
      channels
    };
  }

  const subjectPrefix = tier === 'CRITICAL' ? '🚨 ' : '';
  const subject = `${subjectPrefix}${input.title}`;
  const linkFooter = input.link
    ? `\n\nOpen the conversation: ${input.link}`
    : '';
  const res = await sendEmail({
    to: emailTarget.to,
    subject,
    text: `${input.body}${linkFooter}`
  });
  if (res.ok) channels.push('email');
  return {
    notificationId,
    emailOk: res.ok,
    emailError: res.error ?? res.skipped,
    tier,
    channels
  };
}

interface EmailTarget {
  shouldSend: boolean;
  to: string;
  reason?: string;
}

async function shouldEmail(
  type: EscalationType,
  accountId: string
): Promise<EmailTarget> {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: {
      notificationEmail: true,
      notifyOnSchedulingConflict: true,
      notifyOnDistress: true,
      notifyOnStuckLead: true,
      notifyOnAIStuck: true,
      notifyOnAllAIPauses: true
    }
  });
  if (!account?.notificationEmail) {
    return { shouldSend: false, to: '', reason: 'no_notification_email_set' };
  }
  const prefMap: Record<EscalationType, boolean> = {
    scheduling_conflict: account.notifyOnSchedulingConflict,
    distress: account.notifyOnDistress,
    stuck_lead_24h: account.notifyOnStuckLead,
    ai_stuck: account.notifyOnAIStuck,
    ai_paused_generic: account.notifyOnAllAIPauses
  };
  if (!prefMap[type]) {
    return {
      shouldSend: false,
      to: account.notificationEmail,
      reason: `preference_off:${type}`
    };
  }
  return { shouldSend: true, to: account.notificationEmail };
}
