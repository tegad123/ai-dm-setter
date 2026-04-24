// ---------------------------------------------------------------------------
// follow-up-sequence.ts
// ---------------------------------------------------------------------------
// Two silent-lead recovery sequences, both operating via ScheduledMessage rows
// that the `process-scheduled-messages` cron fires.
//
// 1. BOOKING_LINK_FOLLOWUP — 30 min after the AI ships a Typeform URL,
//    check back in with "yo bro, did you get a chance to fill that out?".
//    Cancelled if the lead replies first.
//
// 2. FOLLOW_UP_1 / _2 / _3 / _SOFT_EXIT — 12h cascade. After any AI message
//    to the lead, schedule FOLLOW_UP_1 for 12h later. When it fires, the
//    cron schedules FOLLOW_UP_2 (12h later again). After FOLLOW_UP_3 fires
//    with no lead reply, FOLLOW_UP_SOFT_EXIT fires 12h later — short
//    no-pressure closer + conversation.outcome → DORMANT.
//
// Any LEAD message arriving on the conversation cancels every pending row
// (both BOOKING_LINK_FOLLOWUP and FOLLOW_UP_*) via cancelAllPendingFollowUps.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import type { ScheduledMessageType } from '@prisma/client';

export const TYPEFORM_BOOKING_URL = 'https://form.typeform.com/to/AGUtPdmb';

const FOLLOW_UP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const BOOKING_LINK_FOLLOWUP_MS = 30 * 60 * 1000; // 30min

const FOLLOW_UP_TYPES: ScheduledMessageType[] = [
  'FOLLOW_UP_1',
  'FOLLOW_UP_2',
  'FOLLOW_UP_3',
  'FOLLOW_UP_SOFT_EXIT',
  'BOOKING_LINK_FOLLOWUP'
];

/**
 * Generic silent-lead cascade bodies. Used when a LEAD simply stops
 * replying mid-qualification (no Typeform URL in flight). Short +
 * varied so a 3-message sequence doesn't read as a template.
 */
export const FOLLOW_UP_BODIES: Record<string, string> = {
  FOLLOW_UP_1: 'yo bro you still there?',
  FOLLOW_UP_2: 'hey bro, everything good on your end? still thinking it over?',
  FOLLOW_UP_3:
    'last check-in bro — you still want to get this going or nah? no pressure either way, just lmk',
  FOLLOW_UP_SOFT_EXIT:
    "aight bro, gonna stop bugging you. the offer's still here whenever you wanna pick it back up 💯",
  BOOKING_LINK_FOLLOWUP: 'yo bro, did you get a chance to fill that out?'
};

/**
 * Booking-aware cascade bodies. Applied when the cascade originates
 * from a BOOKING_LINK_FOLLOWUP (Typeform URL already sent, lead hasn't
 * confirmed a booking). Cascade route is:
 *   BOOKING_LINK_FOLLOWUP (generic body above)
 *     → FOLLOW_UP_1 (booking-aware)  — 12h after the 30-min check-in
 *     → FOLLOW_UP_2 (booking-aware)  — 12h later
 *     → FOLLOW_UP_3 (booking-aware)  — 12h later
 *     → FOLLOW_UP_SOFT_EXIT (booking-aware) — 12h later, marks DORMANT
 */
export const BOOKING_FOLLOW_UP_BODIES: Record<string, string> = {
  FOLLOW_UP_1: 'yo bro, just checking in — were you able to book that call? 💪🏿',
  FOLLOW_UP_2:
    'hey bro, still here if you need anything. did you get a chance to book?',
  FOLLOW_UP_3:
    'yo bro, last check-in — you still interested in hopping on that call with Anthony?',
  FOLLOW_UP_SOFT_EXIT:
    "no worries bro, I'll leave it here. when you're ready hit me up — the offer still stands 💪🏿"
};

/**
 * Every booking-aware cascade body (used for substring matching the
 * `messageBody` stored on a prior ScheduledMessage to figure out which
 * cascade we're in). Also lets the cron detect booking context when a
 * FOLLOW_UP_1/2/3 row fires.
 */
const BOOKING_BODY_SET = new Set([
  FOLLOW_UP_BODIES.BOOKING_LINK_FOLLOWUP,
  ...Object.values(BOOKING_FOLLOW_UP_BODIES)
]);
export function isBookingCascadeBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return BOOKING_BODY_SET.has(body);
}

/**
 * True if the text contains the Typeform booking URL we hand out. Used by
 * post-ship hooks to decide whether to schedule a 30-min check-in.
 */
export function containsBookingLink(text: string): boolean {
  return text.includes(TYPEFORM_BOOKING_URL);
}

/**
 * Schedule the 30-minute BOOKING_LINK_FOLLOWUP check-in after the AI ships
 * a Typeform URL. Idempotent: if a PENDING row already exists for this
 * conversation, we don't stack a second one.
 */
export async function scheduleBookingLinkFollowup(
  conversationId: string,
  accountId: string
): Promise<void> {
  const existing = await prisma.scheduledMessage.findFirst({
    where: {
      conversationId,
      messageType: 'BOOKING_LINK_FOLLOWUP',
      status: 'PENDING'
    },
    select: { id: true }
  });
  if (existing) return;

  const scheduledFor = new Date(Date.now() + BOOKING_LINK_FOLLOWUP_MS);
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: 'BOOKING_LINK_FOLLOWUP',
      messageBody: FOLLOW_UP_BODIES.BOOKING_LINK_FOLLOWUP,
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] scheduled BOOKING_LINK_FOLLOWUP for ${conversationId} at ${scheduledFor.toISOString()}`
  );
}

/**
 * Schedule the first FOLLOW_UP_1 row after the AI ships a reply. Fires in
 * 12h if the lead stays silent. Idempotent per conversation: any existing
 * PENDING FOLLOW_UP_* row is cancelled first so we don't stack two chains
 * running side-by-side from two back-to-back AI messages.
 */
export async function scheduleFollowUp1AfterAiMessage(
  conversationId: string,
  accountId: string
): Promise<void> {
  // Cancel any leftover PENDING chain rows — the newer AI message resets
  // the clock. Only cancels FOLLOW_UP_* chain rows, not BOOKING_LINK_FOLLOWUP.
  await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      messageType: {
        in: ['FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3', 'FOLLOW_UP_SOFT_EXIT']
      },
      status: 'PENDING'
    },
    data: { status: 'CANCELLED' }
  });

  const scheduledFor = new Date(Date.now() + FOLLOW_UP_INTERVAL_MS);
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: 'FOLLOW_UP_1',
      messageBody: FOLLOW_UP_BODIES.FOLLOW_UP_1,
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] scheduled FOLLOW_UP_1 for ${conversationId} at ${scheduledFor.toISOString()}`
  );
}

/**
 * Given a follow-up type that just FIRED, schedule the next one in the
 * cascade. Returns the type that was scheduled, or null if we've reached
 * the end (after FOLLOW_UP_SOFT_EXIT there's nothing left).
 *
 * Cascades:
 *   BOOKING_LINK_FOLLOWUP → FOLLOW_UP_1 (booking-aware body)
 *   FOLLOW_UP_1 → FOLLOW_UP_2
 *   FOLLOW_UP_2 → FOLLOW_UP_3
 *   FOLLOW_UP_3 → FOLLOW_UP_SOFT_EXIT
 *
 * `firedBody` lets the cascade pick the right body variant: when the
 * body matches a booking-context message, the next step uses the
 * booking-aware body; otherwise it falls back to the generic one.
 * Called from the cron's fireScheduledMessage after a successful send.
 */
export async function scheduleNextInCascade(
  conversationId: string,
  accountId: string,
  firedType: ScheduledMessageType,
  firedBody?: string | null
): Promise<ScheduledMessageType | null> {
  const nextType: ScheduledMessageType | null =
    firedType === 'BOOKING_LINK_FOLLOWUP'
      ? 'FOLLOW_UP_1'
      : firedType === 'FOLLOW_UP_1'
        ? 'FOLLOW_UP_2'
        : firedType === 'FOLLOW_UP_2'
          ? 'FOLLOW_UP_3'
          : firedType === 'FOLLOW_UP_3'
            ? 'FOLLOW_UP_SOFT_EXIT'
            : null;
  if (!nextType) return null;

  const useBookingBody =
    firedType === 'BOOKING_LINK_FOLLOWUP' || isBookingCascadeBody(firedBody);
  const body = useBookingBody
    ? BOOKING_FOLLOW_UP_BODIES[nextType]
    : FOLLOW_UP_BODIES[nextType];

  const scheduledFor = new Date(Date.now() + FOLLOW_UP_INTERVAL_MS);
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: nextType,
      messageBody: body,
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] cascaded ${firedType} → ${nextType} (${useBookingBody ? 'booking' : 'generic'}) for ${conversationId} at ${scheduledFor.toISOString()}`
  );
  return nextType;
}

/**
 * Cancel every PENDING FOLLOW_UP_* and BOOKING_LINK_FOLLOWUP row for a
 * conversation. Invoked from processIncomingMessage when a LEAD message
 * arrives — lead responded, the cascade is no longer needed.
 */
export async function cancelAllPendingFollowUps(
  conversationId: string
): Promise<number> {
  const res = await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      messageType: { in: FOLLOW_UP_TYPES },
      status: 'PENDING'
    },
    data: { status: 'CANCELLED' }
  });
  if (res.count > 0) {
    console.log(
      `[follow-up-sequence] cancelled ${res.count} pending follow-up row(s) for ${conversationId} — lead responded`
    );
  }
  return res.count;
}

// ---------------------------------------------------------------------------
// Snooze detection + rescheduling
// ---------------------------------------------------------------------------
// Leads often reply to a follow-up with a soft delay ("busy rn", "give me
// a few hours", "hit me up tomorrow"). Normal lead-reply cancels the
// cascade entirely, but that's wrong in the snooze case — the lead IS
// still interested, just not now. Snooze detection reschedules the
// FOLLOW_UP_1 for the stated duration instead of letting the chain go
// silent.

export interface SnoozeResult {
  /** True if the lead message reads as a delay/snooze request. */
  matched: boolean;
  /** Matched substring, for logging. */
  match: string | null;
  /** Milliseconds until the follow-up should fire. Default 6h. */
  delayMs: number;
  /** Short reason label for telemetry. */
  reason: string | null;
}

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const TWENTY_HOURS = 20 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

const SNOOZE_PATTERNS: Array<{
  pattern: RegExp;
  delayMs: number;
  reason: string;
}> = [
  // "tomorrow" / "do it tomorrow" — pin to ~20h out
  {
    pattern: /\b(tomorrow|do\s+it\s+tomorrow|tmrw|tmr)\b/i,
    delayMs: TWENTY_HOURS,
    reason: 'tomorrow'
  },
  // "few hours" / "couple hours" / "in a bit" — ~4h
  {
    pattern:
      /\b(few\s+hours?|couple\s+(of\s+)?hours?|in\s+a\s+bit|in\s+a\s+min|in\s+a\s+minute|shortly|in\s+a\s+few)\b/i,
    delayMs: FOUR_HOURS,
    reason: 'few_hours'
  },
  // "later" / "busy right now" / "not now" / "give me time" / vague — ~6h
  {
    pattern:
      /\b(later|busy\s+(right\s+)?now|not\s+(right\s+)?now|i'?ll\s+get\s+back|i'?ll\s+hit\s+you\s+(back|up)|give\s+me\s+(some\s+)?time|need\s+(a\s+)?(minute|moment|sec)|hold\s+on|one\s+sec|give\s+me\s+a\s+sec|let\s+me\s+get\s+back)\b/i,
    delayMs: SIX_HOURS,
    reason: 'vague_later'
  }
];

/**
 * Scan a lead message for snooze intent. Returns the first match with
 * its mapped delay. Pure function — no DB access.
 */
export function detectSnooze(text: string): SnoozeResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { matched: false, match: null, delayMs: 0, reason: null };
  }
  for (const { pattern, delayMs, reason } of SNOOZE_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      return { matched: true, match: m[0], delayMs, reason };
    }
  }
  return { matched: false, match: null, delayMs: 0, reason: null };
}

/**
 * Cancel every pending follow-up for a conversation AND schedule a new
 * FOLLOW_UP_1 at `delayMs` out. Preserves booking context when any of
 * the cancelled rows was part of a booking-aware cascade. Used by
 * processIncomingMessage when a lead snoozes a follow-up.
 */
export async function rescheduleFollowUpAfterSnooze(
  conversationId: string,
  accountId: string,
  delayMs: number
): Promise<{ cancelled: number; scheduledFor: Date; bookingContext: boolean }> {
  // See whether the pending cascade was booking-aware before we cancel
  // so we pick the right FOLLOW_UP_1 body for the new row.
  const pending = await prisma.scheduledMessage.findMany({
    where: {
      conversationId,
      messageType: { in: FOLLOW_UP_TYPES },
      status: 'PENDING'
    },
    select: { messageType: true, messageBody: true }
  });
  const bookingContext = pending.some(
    (r) =>
      r.messageType === 'BOOKING_LINK_FOLLOWUP' ||
      isBookingCascadeBody(r.messageBody)
  );

  const cancelled = await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      messageType: { in: FOLLOW_UP_TYPES },
      status: 'PENDING'
    },
    data: { status: 'CANCELLED' }
  });

  const scheduledFor = new Date(Date.now() + delayMs);
  const body = bookingContext
    ? BOOKING_FOLLOW_UP_BODIES.FOLLOW_UP_1
    : FOLLOW_UP_BODIES.FOLLOW_UP_1;
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: 'FOLLOW_UP_1',
      messageBody: body,
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] snooze: cancelled ${cancelled.count}, rescheduled FOLLOW_UP_1 (${bookingContext ? 'booking' : 'generic'}) for ${conversationId} at ${scheduledFor.toISOString()}`
  );
  return { cancelled: cancelled.count, scheduledFor, bookingContext };
}

// ---------------------------------------------------------------------------
// AI re-enable hook
// ---------------------------------------------------------------------------
// When an operator flips aiActive false → true, sweep for booking-limbo
// conversations (Typeform URL sent, no scheduledCallAt, stage=CALL_PROPOSED,
// no pending follow-ups) and schedule a FOLLOW_UP_1 for +5min so the lead
// gets chased immediately instead of waiting another 12h.

const AI_REENABLE_FOLLOWUP_MS = FIVE_MIN;

export async function scheduleBookingFollowupOnAIReenable(
  conversationId: string,
  accountId: string
): Promise<{ scheduled: boolean; reason: string }> {
  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      scheduledCallAt: true,
      aiActive: true,
      lead: { select: { stage: true } }
    }
  });
  if (!convo || !convo.aiActive) {
    return { scheduled: false, reason: 'ai_still_inactive' };
  }
  if (convo.scheduledCallAt) {
    return { scheduled: false, reason: 'call_already_scheduled' };
  }
  if (convo.lead.stage !== 'CALL_PROPOSED') {
    return { scheduled: false, reason: `stage_${convo.lead.stage}` };
  }
  // Already has pending follow-up? Don't stack.
  const existingPending = await prisma.scheduledMessage.findFirst({
    where: {
      conversationId,
      messageType: { in: FOLLOW_UP_TYPES },
      status: 'PENDING'
    },
    select: { id: true }
  });
  if (existingPending) {
    return { scheduled: false, reason: 'pending_followup_exists' };
  }
  // Confirm the AI actually sent the Typeform URL at some point. If it
  // didn't, this isn't booking-limbo — something else is going on and
  // we shouldn't schedule a booking-aware follow-up.
  const typeformSend = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'AI',
      content: { contains: TYPEFORM_BOOKING_URL }
    },
    select: { id: true }
  });
  if (!typeformSend) {
    return { scheduled: false, reason: 'no_prior_typeform_send' };
  }

  const scheduledFor = new Date(Date.now() + AI_REENABLE_FOLLOWUP_MS);
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: 'FOLLOW_UP_1',
      messageBody: BOOKING_FOLLOW_UP_BODIES.FOLLOW_UP_1,
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] AI re-enabled — scheduled booking FOLLOW_UP_1 for ${conversationId} at ${scheduledFor.toISOString()} (+5min)`
  );
  return { scheduled: true, reason: 'ok' };
}
