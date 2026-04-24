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
 * Static message bodies for the silent-lead cascade. Kept intentionally
 * short and varied so a 3-message sequence doesn't read as a template.
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
 */
export async function scheduleNextInCascade(
  conversationId: string,
  accountId: string,
  firedType: ScheduledMessageType
): Promise<ScheduledMessageType | null> {
  const nextType: ScheduledMessageType | null =
    firedType === 'FOLLOW_UP_1'
      ? 'FOLLOW_UP_2'
      : firedType === 'FOLLOW_UP_2'
        ? 'FOLLOW_UP_3'
        : firedType === 'FOLLOW_UP_3'
          ? 'FOLLOW_UP_SOFT_EXIT'
          : null;
  if (!nextType) return null;

  const scheduledFor = new Date(Date.now() + FOLLOW_UP_INTERVAL_MS);
  await prisma.scheduledMessage.create({
    data: {
      conversationId,
      accountId,
      scheduledFor,
      messageType: nextType,
      messageBody: FOLLOW_UP_BODIES[nextType],
      generateAtSendTime: false,
      createdBy: 'AI'
    }
  });
  console.log(
    `[follow-up-sequence] cascaded ${firedType} → ${nextType} for ${conversationId} at ${scheduledFor.toISOString()}`
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
