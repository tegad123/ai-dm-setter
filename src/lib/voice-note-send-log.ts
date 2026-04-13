// ---------------------------------------------------------------------------
// Voice Note Send Log — cooldown tracking for library voice notes
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

/**
 * Log a voice note send for cooldown tracking.
 */
export async function logVoiceNoteSend(params: {
  accountId: string;
  leadId: string;
  voiceNoteId: string;
  messageIndex: number;
  triggerType: string;
}): Promise<void> {
  await prisma.voiceNoteSendLog.create({
    data: {
      accountId: params.accountId,
      leadId: params.leadId,
      voiceNoteId: params.voiceNoteId,
      messageIndex: params.messageIndex,
      triggerType: params.triggerType
    }
  });
}

/**
 * Check if a cooldown has elapsed for a specific voice note + lead combo.
 * Returns true if OK to send (cooldown satisfied), false if still cooling down.
 */
export async function checkCooldown(params: {
  leadId: string;
  voiceNoteId: string;
  cooldown: { type: 'messages' | 'conversation' | 'time'; value: number };
  currentMessageIndex: number;
}): Promise<boolean> {
  const { leadId, voiceNoteId, cooldown, currentMessageIndex } = params;

  // Get the most recent send of this voice note to this lead
  const lastSend = await prisma.voiceNoteSendLog.findFirst({
    where: { leadId, voiceNoteId },
    orderBy: { sentAt: 'desc' }
  });

  // Never sent before → OK
  if (!lastSend) return true;

  switch (cooldown.type) {
    case 'messages': {
      // Check if enough messages have passed since last send
      const messagesSince = currentMessageIndex - lastSend.messageIndex;
      return messagesSince >= cooldown.value;
    }

    case 'conversation': {
      // "conversation" type with value 1 means at most once per conversation.
      // If any send exists for this voice note + lead, it's blocked.
      return false;
    }

    case 'time': {
      // Check if enough seconds have passed since last send
      const elapsedMs = Date.now() - lastSend.sentAt.getTime();
      const elapsedSeconds = elapsedMs / 1000;
      return elapsedSeconds >= cooldown.value;
    }

    default:
      return true;
  }
}

/**
 * Check the global frequency cap: has ANY library voice note been sent
 * to this lead within the last N messages?
 */
export async function checkGlobalFrequencyCap(params: {
  leadId: string;
  currentMessageIndex: number;
  cap: number;
}): Promise<boolean> {
  const { leadId, currentMessageIndex, cap } = params;

  const lastAnySend = await prisma.voiceNoteSendLog.findFirst({
    where: { leadId },
    orderBy: { sentAt: 'desc' }
  });

  if (!lastAnySend) return true;

  const messagesSince = currentMessageIndex - lastAnySend.messageIndex;
  return messagesSince >= cap;
}
