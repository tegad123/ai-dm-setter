// ---------------------------------------------------------------------------
// leadconnector-webhook.ts
// ---------------------------------------------------------------------------
// Receives "Appointment Booked" / "Calendar Event Created" webhooks from
// LeadConnector (GoHighLevel) and routes the booking back to the
// originating Conversation, populating `scheduledCallAt` so the AI sees
// the booking on its next turn AND the pre-call confirmation sequence
// fires automatically.
//
// Match strategy (in priority order):
//   1. `conversationid` custom field — set on the contact when the lead
//      lands on the calendar widget via Typeform redirect URL. Bulletproof
//      because the hidden field carries the conversation identity from the
//      Typeform submission through to the booking event without depending
//      on email-equality between systems.
//   2. Email match — fallback for leads who reach the calendar via a
//      direct link (no Typeform pre-step). Scoped to the same accountId
//      to prevent cross-tenant leak from email collisions across tenants.
//
// If neither matches, the webhook returns 200 with `matched=false` so
// LeadConnector doesn't retry indefinitely. We log the payload for the
// operator to investigate.
//
// Auth: query-string `secret` MUST match the per-account
// `LeadConnector.webhookSecret` stored in IntegrationCredential.metadata.
// LeadConnector's outbound webhook system doesn't sign payloads, so the
// secret is the only thing preventing a third party from posting fake
// bookings. Treat the URL itself as a credential.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { scheduleCallConfirmationSequence } from '@/lib/call-confirmation-sequence';
import { isUpgrade, transitionLeadStage } from '@/lib/lead-stage';
import type { LeadStage } from '@prisma/client';

export class LeadConnectorWebhookError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LeadConnectorWebhookError';
    this.status = status;
  }
}

interface ProcessLeadConnectorResult {
  ok: true;
  matched: boolean;
  matchedBy: 'conversationid' | 'email' | null;
  accountId: string;
  conversationId: string | null;
  scheduledCallAt: string | null;
}

/**
 * GHL has two common payload shapes for appointment events:
 *
 *  - "Workflow Action Webhook" (modern):
 *      { contact: {...}, appointment: {...}, customData: {...} }
 *
 *  - "Subaccount Webhook" (legacy):
 *      { type: "AppointmentCreate", appointment: {...}, contact: {...} }
 *
 * Plus zaps / direct-pushed workflows can flatten the structure entirely.
 * We accept all of them and look for the booking time + custom fields in
 * any of the known locations.
 */
interface LeadConnectorAppointmentPayload {
  type?: string;
  appointment?: {
    id?: string;
    calendarId?: string;
    contactId?: string;
    startTime?: string;
    endTime?: string;
    appointmentStatus?: string;
    customData?: Record<string, unknown>;
  };
  contact?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    customFields?: Array<{
      id?: string;
      key?: string;
      name?: string;
      value?: unknown;
    }>;
  };
  customData?: Record<string, unknown>;
  // Flattened-shape fallbacks
  startTime?: string;
  start_time?: string;
  email?: string;
  conversationid?: string;
  conversationId?: string;
}

interface ProcessInput {
  accountId: string | null;
  secret: string | null;
  rawBody: string;
}

export async function processLeadConnectorWebhook(
  input: ProcessInput
): Promise<ProcessLeadConnectorResult> {
  const accountId = input.accountId?.trim();
  if (!accountId) {
    throw new LeadConnectorWebhookError(
      'Missing accountId query parameter',
      400
    );
  }
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true }
  });
  if (!account) {
    throw new LeadConnectorWebhookError('Account not found', 404);
  }

  // Verify shared secret. We never accept the env-var fallback here —
  // LeadConnector secrets are per-account because each operator's GHL
  // sub-account has its own webhook configuration.
  const creds = await getCredentials(accountId, 'LEADCONNECTOR');
  const expectedSecret =
    typeof creds?.webhookSecret === 'string' && creds.webhookSecret.trim()
      ? creds.webhookSecret.trim()
      : null;
  if (!expectedSecret) {
    throw new LeadConnectorWebhookError(
      'Account has no LEADCONNECTOR webhookSecret configured',
      403
    );
  }
  if (input.secret?.trim() !== expectedSecret) {
    throw new LeadConnectorWebhookError(
      'Invalid LeadConnector webhook secret',
      401
    );
  }

  let payload: LeadConnectorAppointmentPayload;
  try {
    payload = JSON.parse(input.rawBody) as LeadConnectorAppointmentPayload;
  } catch {
    throw new LeadConnectorWebhookError('Invalid JSON', 400);
  }

  const conversationIdHint = extractConversationId(payload);
  const startTimeStr = extractStartTime(payload);
  const email = extractEmail(payload);

  const startAt = startTimeStr ? parseDate(startTimeStr) : null;
  if (!startAt) {
    console.warn(
      `[leadconnector-webhook] No usable startTime in payload — accountId=${accountId} conversationIdHint=${conversationIdHint ?? 'none'} email=${email ?? 'none'}`
    );
    return {
      ok: true,
      matched: false,
      matchedBy: null,
      accountId,
      conversationId: null,
      scheduledCallAt: null
    };
  }

  // Step 1: hidden-field match (preferred — deterministic).
  let conversationRow: {
    id: string;
    leadId: string;
    lead: { accountId: string; stage: LeadStage };
  } | null = null;
  let matchedBy: 'conversationid' | 'email' | null = null;
  if (conversationIdHint) {
    const candidate = await prisma.conversation.findUnique({
      where: { id: conversationIdHint },
      select: {
        id: true,
        leadId: true,
        lead: { select: { accountId: true, stage: true } }
      }
    });
    if (candidate && candidate.lead.accountId === accountId) {
      conversationRow = candidate;
      matchedBy = 'conversationid';
    } else if (candidate) {
      console.warn(
        `[leadconnector-webhook] conversationid=${conversationIdHint} ` +
          `belongs to account ${candidate.lead.accountId}, not ${accountId} — ` +
          `falling back to email match.`
      );
    }
  }

  // Step 2: email-match fallback (only when hidden field absent / mismatched).
  if (!conversationRow && email) {
    const byEmail = await prisma.conversation.findFirst({
      where: {
        lead: { accountId },
        leadEmail: { equals: email, mode: 'insensitive' }
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        leadId: true,
        lead: { select: { accountId: true, stage: true } }
      }
    });
    if (byEmail) {
      conversationRow = byEmail;
      matchedBy = 'email';
    }
  }

  if (!conversationRow) {
    console.warn(
      `[leadconnector-webhook] No matching conversation — accountId=${accountId} ` +
        `conversationIdHint=${conversationIdHint ?? 'none'} email=${email ?? 'none'} ` +
        `startAt=${startAt.toISOString()}`
    );
    return {
      ok: true,
      matched: false,
      matchedBy: null,
      accountId,
      conversationId: null,
      scheduledCallAt: startAt.toISOString()
    };
  }

  // Update the conversation: persist the booking time + mark confirmed
  // since the lead actively chose the slot in LeadConnector's calendar.
  await prisma.conversation.update({
    where: { id: conversationRow.id },
    data: {
      scheduledCallAt: startAt,
      scheduledCallSource: 'CALENDAR_INTEGRATION',
      scheduledCallConfirmed: true,
      scheduledCallUpdatedAt: new Date()
    }
  });

  // Bump the lead stage if booking is an upgrade from the current stage.
  // Mirrors what typeform-webhook does after a calendar-time answer
  // arrives — keeps stage transitions consistent across booking sources.
  const currentStage = conversationRow.lead.stage;
  const targetStage: LeadStage = 'BOOKED';
  if (isUpgrade(currentStage, targetStage)) {
    await transitionLeadStage(
      conversationRow.leadId,
      targetStage,
      'system',
      'leadconnector_booking_webhook'
    ).catch((err) => {
      console.error(
        '[leadconnector-webhook] stage transition failed (non-fatal):',
        err
      );
    });
  }

  // Schedule the pre-call confirmation sequence (night-before, morning-of,
  // 1-hour-before reminders). Same flow as typeform path.
  if (startAt.getTime() > Date.now()) {
    await scheduleCallConfirmationSequence({
      conversationId: conversationRow.id,
      accountId,
      scheduledCallAt: startAt,
      leadTimezone: null,
      createdByUserId: null
    }).catch((err) => {
      console.error(
        '[leadconnector-webhook] pre-call sequence scheduling failed:',
        err
      );
    });
  }

  return {
    ok: true,
    matched: true,
    matchedBy,
    accountId,
    conversationId: conversationRow.id,
    scheduledCallAt: startAt.toISOString()
  };
}

// ── Field extraction helpers ─────────────────────────────────────────

function extractConversationId(
  payload: LeadConnectorAppointmentPayload
): string | null {
  // 1. Top-level (flattened webhooks / GHL workflow action mapping)
  const flat = pickString(
    payload.conversationid ?? payload.conversationId ?? null
  );
  if (flat) return flat;

  // 2. customData on payload root or appointment
  const fromRoot = readCustomDataField(payload.customData, 'conversationid');
  if (fromRoot) return fromRoot;
  const fromAppt = readCustomDataField(
    payload.appointment?.customData,
    'conversationid'
  );
  if (fromAppt) return fromAppt;

  // 3. contact.customFields array (each element { key, value } or { name, value })
  const cf = payload.contact?.customFields ?? [];
  for (const f of cf) {
    const key = (f.key ?? f.name ?? '').toString().toLowerCase().trim();
    if (key === 'conversationid' || key === 'conversation_id') {
      const v = pickString(f.value);
      if (v) return v;
    }
  }
  return null;
}

function readCustomDataField(
  data: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!data || typeof data !== 'object') return null;
  for (const [k, v] of Object.entries(data)) {
    if (k.toLowerCase() === key.toLowerCase()) {
      return pickString(v);
    }
  }
  return null;
}

function extractStartTime(
  payload: LeadConnectorAppointmentPayload
): string | null {
  return (
    pickString(payload.appointment?.startTime) ||
    pickString(payload.startTime) ||
    pickString(payload.start_time) ||
    null
  );
}

function extractEmail(payload: LeadConnectorAppointmentPayload): string | null {
  return (
    pickString(payload.contact?.email) || pickString(payload.email) || null
  );
}

function pickString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function parseDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}
