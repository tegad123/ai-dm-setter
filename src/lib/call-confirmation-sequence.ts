import prisma from '@/lib/prisma';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import {
  broadcastConversationUpdate,
  broadcastNewMessage
} from '@/lib/realtime';
import { escalate } from '@/lib/escalation-dispatch';
import { sanitizeDashCharacters } from '@/lib/voice-quality-gate';
import type { Prisma, ScheduledMessageType } from '@prisma/client';

export const CALL_CONFIRMATION_TYPES: ScheduledMessageType[] = [
  'PRE_CALL_HOMEWORK',
  'CALL_DAY_CONFIRMATION',
  'CALL_DAY_REMINDER'
];

const CALL_SEQUENCE_CANCEL_TYPES: ScheduledMessageType[] = [
  'DAY_BEFORE_REMINDER',
  'MORNING_OF_REMINDER',
  ...CALL_CONFIRMATION_TYPES
];

const BUBBLE_BODY_KIND = 'call_confirmation_bubbles';
const HOUR_MS = 60 * 60 * 1000;

type CallSequenceType =
  | 'PRE_CALL_HOMEWORK'
  | 'CALL_DAY_CONFIRMATION'
  | 'CALL_DAY_REMINDER';

interface CallSequenceConfig {
  homeworkUrl: string | null;
  closerName: string | null;
  greeting: string;
  addressTerm: string;
  powerEmoji: string;
  fireEmoji: string;
}

interface SequenceScheduleResult {
  homeworkId: string | null;
  confirmationId: string | null;
  reminderId: string | null;
}

export function encodeScheduledBubbles(bubbles: string[]): string {
  return JSON.stringify({ kind: BUBBLE_BODY_KIND, bubbles });
}

export function decodeScheduledBubbles(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { kind?: string; bubbles?: unknown };
    if (
      parsed.kind === BUBBLE_BODY_KIND &&
      Array.isArray(parsed.bubbles) &&
      parsed.bubbles.every((b) => typeof b === 'string')
    ) {
      return parsed.bubbles.map((b) => b.trim()).filter(Boolean);
    }
  } catch {
    // Plain legacy body. Fall through to single-bubble send.
  }
  return [body.trim()].filter(Boolean);
}

export async function scheduleCallConfirmationSequence(params: {
  conversationId: string;
  accountId: string;
  scheduledCallAt: Date;
  leadTimezone: string | null;
  createdByUserId?: string | null;
}): Promise<SequenceScheduleResult> {
  const {
    conversationId,
    accountId,
    scheduledCallAt,
    leadTimezone,
    createdByUserId
  } = params;
  const config = await resolveCallSequenceConfig(accountId);
  const now = Date.now();
  const homeworkAt = new Date(scheduledCallAt.getTime() - 20 * HOUR_MS);
  const confirmationAt = new Date(scheduledCallAt.getTime() - 3 * HOUR_MS);
  const reminderAt = new Date(scheduledCallAt.getTime() - 2 * HOUR_MS);

  const created = await prisma.$transaction(async (tx) => {
    await tx.scheduledMessage.updateMany({
      where: {
        conversationId,
        status: 'PENDING',
        messageType: { in: CALL_SEQUENCE_CANCEL_TYPES }
      },
      data: { status: 'CANCELLED' }
    });

    const out: SequenceScheduleResult = {
      homeworkId: null,
      confirmationId: null,
      reminderId: null
    };

    if (config.homeworkUrl && homeworkAt.getTime() > now) {
      const homework = await tx.scheduledMessage.create({
        data: {
          conversationId,
          accountId,
          scheduledFor: homeworkAt,
          messageType: 'PRE_CALL_HOMEWORK',
          messageBody: encodeScheduledBubbles(
            buildPreCallHomeworkBubbles({
              scheduledCallAt,
              timezone: leadTimezone,
              config
            })
          ),
          generateAtSendTime: false,
          relatedCallAt: scheduledCallAt,
          createdBy: createdByUserId ? 'HUMAN' : 'SYSTEM',
          createdByUserId: createdByUserId ?? null
        }
      });
      out.homeworkId = homework.id;
    }

    if (confirmationAt.getTime() > now) {
      const confirmation = await tx.scheduledMessage.create({
        data: {
          conversationId,
          accountId,
          scheduledFor: confirmationAt,
          messageType: 'CALL_DAY_CONFIRMATION',
          messageBody: encodeScheduledBubbles(
            buildCallDayConfirmationBubbles({
              scheduledCallAt,
              timezone: leadTimezone,
              config,
              leadName: null
            })
          ),
          generateAtSendTime: false,
          relatedCallAt: scheduledCallAt,
          createdBy: createdByUserId ? 'HUMAN' : 'SYSTEM',
          createdByUserId: createdByUserId ?? null
        }
      });
      out.confirmationId = confirmation.id;
    }

    if (reminderAt.getTime() > now) {
      const reminder = await tx.scheduledMessage.create({
        data: {
          conversationId,
          accountId,
          scheduledFor: reminderAt,
          messageType: 'CALL_DAY_REMINDER',
          messageBody: encodeScheduledBubbles(
            buildCallDayReminderBubbles({
              scheduledCallAt,
              config,
              now: new Date()
            })
          ),
          generateAtSendTime: false,
          relatedCallAt: scheduledCallAt,
          createdBy: createdByUserId ? 'HUMAN' : 'SYSTEM',
          createdByUserId: createdByUserId ?? null
        }
      });
      out.reminderId = reminder.id;
    }

    return out;
  });

  await enforceSinglePendingCallSequence(
    conversationId,
    'PRE_CALL_HOMEWORK',
    created.homeworkId
  );
  await enforceSinglePendingCallSequence(
    conversationId,
    'CALL_DAY_CONFIRMATION',
    created.confirmationId
  );
  await enforceSinglePendingCallSequence(
    conversationId,
    'CALL_DAY_REMINDER',
    created.reminderId
  );

  return created;
}

export async function cancelCallConfirmationSequence(
  conversationId: string
): Promise<number> {
  const res = await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      status: 'PENDING',
      messageType: { in: CALL_SEQUENCE_CANCEL_TYPES }
    },
    data: { status: 'CANCELLED' }
  });
  return res.count;
}

export async function handleQualifiedCallConfirmationTrigger(
  leadId: string
): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { leadId },
    include: { lead: true }
  });
  if (!conversation?.scheduledCallAt) return;
  if (conversation.scheduledCallAt.getTime() <= Date.now()) return;
  if (conversation.lead.stage === 'UNQUALIFIED') return;

  await scheduleCallConfirmationSequence({
    conversationId: conversation.id,
    accountId: conversation.lead.accountId,
    scheduledCallAt: conversation.scheduledCallAt,
    leadTimezone:
      conversation.scheduledCallTimezone ||
      conversation.leadTimezone ||
      conversation.lead.timezone ||
      null
  });

  if (conversation.aiActive) {
    await sendImmediateCallConfirmation(conversation.id);
  }
}

export async function sendImmediateCallConfirmation(
  conversationId: string
): Promise<boolean> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { lead: true }
  });
  if (!conversation?.scheduledCallAt || !conversation.lead.platformUserId) {
    return false;
  }

  const recentLockMessage = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'AI',
      timestamp: { gte: new Date(Date.now() - 15 * 60_000) },
      content: { contains: 'locked in', mode: 'insensitive' }
    },
    select: { id: true }
  });
  if (recentLockMessage) return false;

  const config = await resolveCallSequenceConfig(conversation.lead.accountId);
  const bubbles = buildImmediateConfirmationBubbles({
    scheduledCallAt: conversation.scheduledCallAt,
    timezone:
      conversation.scheduledCallTimezone ||
      conversation.leadTimezone ||
      conversation.lead.timezone ||
      null,
    config
  });
  await sendCallSequenceBubbles({ conversationId, bubbles });
  return true;
}

export async function handleCallConfirmationLeadReply(params: {
  conversationId: string;
  messageId: string;
  messageText: string;
}): Promise<{ handled: boolean; kind: 'confirmed' | 'reschedule' | null }> {
  const { conversationId, messageId, messageText } = params;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { lead: true }
  });
  if (!conversation?.scheduledCallAt) {
    return { handled: false, kind: null };
  }

  const recentPrompt = await prisma.scheduledMessage.findFirst({
    where: {
      conversationId,
      status: 'FIRED',
      messageType: { in: ['CALL_DAY_CONFIRMATION', 'CALL_DAY_REMINDER'] },
      firedAt: { gte: new Date(Date.now() - 8 * HOUR_MS) }
    },
    orderBy: { firedAt: 'desc' },
    select: { id: true }
  });
  if (!recentPrompt) {
    return { handled: false, kind: null };
  }

  if (isCantMakeCallReply(messageText)) {
    await handleCallRescheduleNeeded({
      conversationId,
      messageId,
      messageText
    });
    return { handled: true, kind: 'reschedule' };
  }

  if (!isCallConfirmationReply(messageText)) {
    return { handled: false, kind: null };
  }

  const now = new Date();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      callConfirmed: true,
      callConfirmedAt: now,
      scheduledCallConfirmed: true
    }
  });
  await prisma.scheduledMessage.updateMany({
    where: {
      conversationId,
      status: 'PENDING',
      messageType: 'CALL_DAY_REMINDER'
    },
    data: { status: 'CANCELLED' }
  });

  const config = await resolveCallSequenceConfig(conversation.lead.accountId);
  await sendCallSequenceBubbles({
    conversationId,
    bubbles: buildLeadConfirmedBubbles(config)
  });

  broadcastConversationUpdate({
    id: conversationId,
    leadId: conversation.lead.id,
    aiActive: conversation.aiActive,
    unreadCount: conversation.unreadCount,
    lastMessageAt: now.toISOString()
  });

  return { handled: true, kind: 'confirmed' };
}

export async function sendScheduledCallSequenceMessage(params: {
  conversationId: string;
  bubbles: string[];
}): Promise<void> {
  await sendCallSequenceBubbles(params);
}

function buildImmediateConfirmationBubbles(params: {
  scheduledCallAt: Date;
  timezone: string | null;
  config: CallSequenceConfig;
}): string[] {
  const { scheduledCallAt, timezone, config } = params;
  const address = addressSuffix(config);
  const closer = config.closerName || 'the team';
  return [
    cleanBubble(
      `perfect${address}, ${formatDayAtTime(scheduledCallAt, timezone)} is locked in`
    ),
    cleanBubble(
      `${closer} will have everything ready for you, you're gonna want to come prepared ${config.powerEmoji}`
    )
  ];
}

function buildPreCallHomeworkBubbles(params: {
  scheduledCallAt: Date;
  timezone: string | null;
  config: CallSequenceConfig;
}): string[] {
  const { scheduledCallAt, timezone, config } = params;
  const callPhrase = config.closerName
    ? `your call with ${config.closerName}`
    : 'your call';
  return [
    cleanBubble(
      `${config.greeting}${addressSuffix(config)}, ${callPhrase} is tomorrow at ${formatTimeWithZone(scheduledCallAt, timezone)}`
    ),
    cleanBubble(
      "before you hop on, check this out, it'll tell you exactly what to expect and how to get the most out of it:"
    ),
    config.homeworkUrl || '',
    cleanBubble(`go through it tonight so you're ready ${config.powerEmoji}`)
  ].filter(Boolean);
}

function buildCallDayConfirmationBubbles(params: {
  scheduledCallAt: Date;
  timezone: string | null;
  config: CallSequenceConfig;
  leadName: string | null;
}): string[] {
  const { scheduledCallAt, timezone, config, leadName } = params;
  const who = leadName ? firstName(leadName) : config.addressTerm;
  const opener = [config.greeting, who].filter(Boolean).join(' ');
  const callPhrase = config.closerName
    ? `your call with ${config.closerName}`
    : 'your call';
  return [
    cleanBubble(
      `${opener}, ${callPhrase} is today at ${formatTimeWithZone(scheduledCallAt, timezone)}, you still good to make it?`
    )
  ];
}

function buildCallDayReminderBubbles(params: {
  scheduledCallAt: Date;
  config: CallSequenceConfig;
  now: Date;
}): string[] {
  const hours = Math.max(
    1,
    Math.round(
      (params.scheduledCallAt.getTime() - params.now.getTime()) / HOUR_MS
    )
  );
  const unit = hours === 1 ? 'hour' : 'hours';
  return [
    cleanBubble(
      `${params.config.greeting}${addressSuffix(params.config)} quick reminder your call is in ${hours} ${unit}, still on? ${params.config.powerEmoji}`
    )
  ];
}

function buildLeadConfirmedBubbles(config: CallSequenceConfig): string[] {
  const address = addressSuffix(config);
  const closerPhrase = config.closerName
    ? `${config.closerName}'s gonna break everything down for you`
    : "the team's gonna break everything down for you";
  return [
    cleanBubble(`let's go${address} ${config.fireEmoji}`),
    cleanBubble(`${closerPhrase}, come with your questions ready`)
  ];
}

function buildRescheduleBubbles(config: CallSequenceConfig): string[] {
  return [
    cleanBubble(
      `no worries${addressSuffix(config)}, let's get you rescheduled, what day works better?`
    )
  ];
}

async function handleCallRescheduleNeeded(params: {
  conversationId: string;
  messageId: string;
  messageText: string;
}): Promise<void> {
  const { conversationId, messageId, messageText } = params;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { lead: true }
  });
  if (!conversation) return;

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      aiActive: false,
      callOutcome: 'RESCHEDULED',
      schedulingConflict: true,
      schedulingConflictAt: new Date(),
      schedulingConflictMessageId: messageId,
      schedulingConflictPreference: messageText.slice(0, 180)
    }
  });
  await cancelCallConfirmationSequence(conversationId);
  const config = await resolveCallSequenceConfig(conversation.lead.accountId);
  await sendCallSequenceBubbles({
    conversationId,
    bubbles: buildRescheduleBubbles(config)
  });

  try {
    const { transitionLeadStage } = await import('@/lib/lead-stage');
    await transitionLeadStage(
      conversation.lead.id,
      'RESCHEDULED',
      'system',
      'lead said they cannot make confirmed call'
    );
  } catch (err) {
    console.error(
      '[call-confirmation] RESCHEDULED stage transition failed:',
      err
    );
  }

  await escalate({
    type: 'scheduling_conflict',
    accountId: conversation.lead.accountId,
    leadId: conversation.lead.id,
    conversationId,
    leadName: conversation.lead.name,
    leadHandle: conversation.lead.handle,
    title: 'URGENT - lead needs call rescheduled',
    body: `${conversation.lead.name || 'Lead'} said they cannot make the scheduled call. AI asked what day works better and paused the conversation for human follow-up.`,
    details: messageText,
    link: `/dashboard/conversations?conversationId=${conversationId}`
  });
}

async function sendCallSequenceBubbles(params: {
  conversationId: string;
  bubbles: string[];
}): Promise<void> {
  const { conversationId } = params;
  const bubbles = params.bubbles.map(cleanBubble).filter(Boolean);
  if (bubbles.length === 0) return;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { lead: true }
  });
  if (!conversation?.lead.platformUserId) {
    throw new Error('cannot send call sequence without platformUserId');
  }

  const group = await prisma.messageGroup.create({
    data: {
      conversationId,
      bubbleCount: bubbles.length,
      totalCharacters: bubbles.reduce((sum, b) => sum + b.length, 0),
      sentByType: 'AI'
    }
  });

  let delivered = 0;
  let failedAt: Date | null = null;
  try {
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i];
      const platformMessageId = await sendBubbleToPlatform({
        accountId: conversation.lead.accountId,
        platform: conversation.lead.platform,
        platformUserId: conversation.lead.platformUserId,
        text: bubble
      });
      const timestamp = new Date();
      const message = await prisma.message.create({
        data: {
          conversationId,
          sender: 'AI',
          content: bubble,
          timestamp,
          platformMessageId,
          messageGroupId: group.id,
          bubbleIndex: i,
          bubbleTotalCount: bubbles.length
        }
      });
      delivered++;
      broadcastNewMessage({
        id: message.id,
        conversationId,
        sender: 'AI',
        content: bubble,
        timestamp: timestamp.toISOString(),
        messageGroupId: group.id,
        bubbleIndex: i,
        bubbleTotalCount: bubbles.length
      });
    }
  } catch (err) {
    failedAt = new Date();
    await prisma.messageGroup.update({
      where: { id: group.id },
      data: {
        failedAt,
        deliveryNotes: {
          delivered,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    });
    throw err;
  }

  await prisma.messageGroup.update({
    where: { id: group.id },
    data: {
      completedAt: failedAt ? null : new Date(),
      failedAt,
      deliveryNotes:
        delivered < bubbles.length
          ? ({ delivered } as Prisma.InputJsonValue)
          : undefined
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() }
  });
  broadcastConversationUpdate({
    id: conversationId,
    leadId: conversation.lead.id,
    aiActive: conversation.aiActive,
    unreadCount: conversation.unreadCount,
    lastMessageAt: new Date().toISOString()
  });
}

async function sendBubbleToPlatform(params: {
  accountId: string;
  platform: string;
  platformUserId: string;
  text: string;
}): Promise<string | null> {
  const { accountId, platform, platformUserId, text } = params;
  if (platform === 'INSTAGRAM') {
    const result = await sendInstagramDM(accountId, platformUserId, text);
    return extractMetaMessageId(result);
  }
  if (platform === 'FACEBOOK') {
    const result = await sendFacebookMessage(accountId, platformUserId, text);
    return extractMetaMessageId(result);
  }
  throw new Error(`unsupported platform: ${platform}`);
}

function extractMetaMessageId(result: unknown): string | null {
  if (result && typeof result === 'object') {
    const obj = result as {
      message_id?: unknown;
      messageId?: unknown;
      id?: unknown;
    };
    if (typeof obj.message_id === 'string') return obj.message_id;
    if (typeof obj.messageId === 'string') return obj.messageId;
    return typeof obj.id === 'string' ? obj.id : null;
  }
  return null;
}

async function enforceSinglePendingCallSequence(
  conversationId: string,
  messageType: CallSequenceType,
  keepId: string | null
): Promise<void> {
  const pending = await prisma.scheduledMessage.findMany({
    where: { conversationId, messageType, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true }
  });
  if (pending.length <= 1) return;
  const canonical =
    (keepId && pending.find((p) => p.id === keepId)?.id) ?? pending[0].id;
  const cancelIds = pending.filter((p) => p.id !== canonical).map((p) => p.id);
  await prisma.scheduledMessage.updateMany({
    where: { id: { in: cancelIds } },
    data: { status: 'CANCELLED' }
  });
}

async function resolveCallSequenceConfig(
  accountId: string
): Promise<CallSequenceConfig> {
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true },
    select: {
      promptConfig: true,
      customPhrases: true,
      closerName: true,
      tone: true
    }
  });
  const config = (persona?.promptConfig || {}) as Record<string, any>;
  const style =
    (config.callConfirmationStyle as Record<string, string> | undefined) || {};
  const phrases = parseJsonRecord(persona?.customPhrases);
  const handoff = (config.callHandoff || {}) as { closerName?: string };
  const tone = (persona?.tone || '').toLowerCase();
  const greeting =
    style.greeting || phrases.greeting || (tone.includes('yo') ? 'yo' : 'hey');
  const addressTerm =
    style.addressTerm ||
    phrases.addressTerm ||
    (greeting.toLowerCase() === 'yo' || tone.includes('bro') ? 'bro' : '');

  return {
    homeworkUrl: normalizeUrl(
      (config.homeworkUrl as string | undefined) ||
        (config.callConfirmationSequence?.homeworkUrl as string | undefined) ||
        (config.preCallMessages?.homeworkUrl as string | undefined) ||
        findHomeworkAssetUrl(config)
    ),
    closerName:
      (config.closerName as string | undefined)?.trim() ||
      handoff.closerName?.trim() ||
      persona?.closerName?.trim() ||
      null,
    greeting,
    addressTerm,
    powerEmoji: style.powerEmoji || style.emoji || '',
    fireEmoji: style.fireEmoji || ''
  };
}

function parseJsonRecord(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function findHomeworkAssetUrl(config: Record<string, any>): string | null {
  const assets = Array.isArray(config.assetLinks) ? config.assetLinks : [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const label = String(asset.label || asset.title || asset.name || '');
    const url = typeof asset.url === 'string' ? asset.url : null;
    if (url && /\b(homework|confirmation|prep|prepare)\b/i.test(label)) {
      return url;
    }
  }
  return null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : null;
}

function addressSuffix(config: CallSequenceConfig): string {
  return config.addressTerm ? ` ${config.addressTerm}` : '';
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function cleanBubble(text: string): string {
  return sanitizeDashCharacters(text.replace(/\s+/g, ' ').trim());
}

function formatDayAtTime(d: Date, tz: string | null): string {
  return d.toLocaleString('en-US', {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: safeTimezone(tz),
    timeZoneName: 'short'
  });
}

function formatTimeWithZone(d: Date, tz: string | null): string {
  return d.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: safeTimezone(tz),
    timeZoneName: 'short'
  });
}

function safeTimezone(tz: string | null): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export function isCallConfirmationReply(text: string): boolean {
  return /\b(yes|yeah|yep|yup|confirmed|ready|still good|good to go|i'?ll be there|i will be there|i'?m there|im there|for sure|absolutely|see you then|i can make it)\b/i.test(
    text
  );
}

export function isCantMakeCallReply(text: string): boolean {
  return /\b(can'?t make it|cant make it|cannot make it|won'?t make it|not able to make it|something came up|need to reschedule|reschedule|busy then|miss the call|can we do another|another time)\b/i.test(
    text
  );
}
