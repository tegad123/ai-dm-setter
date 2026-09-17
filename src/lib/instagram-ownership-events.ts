import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

type UnknownRecord = Record<string, unknown>;

export interface InstagramOwnershipEvent {
  eventType: string;
  channel: 'messaging' | 'standby' | 'changes';
  senderId: string | null;
  recipientId: string | null;
  previousOwnerAppId: string | null;
  // A request is not a transfer; requested_owner_app_id stays in raw payload.
  newOwnerAppId: string | null;
  eventTimestamp: Date | null;
  payload: UnknownRecord;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function id(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim();
    return normalized || null;
  }
  return null;
}

function timestamp(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ownershipPayload(event: UnknownRecord): {
  eventType: string;
  value: UnknownRecord;
} | null {
  for (const key of [
    'pass_thread_control',
    'take_thread_control',
    'request_thread_control',
    'messaging_handover'
  ]) {
    if (event[key] && typeof event[key] === 'object') {
      return { eventType: key, value: record(event[key]) };
    }
  }
  return null;
}

function normalizeEvent(
  event: UnknownRecord,
  channel: 'messaging' | 'standby'
): InstagramOwnershipEvent | null {
  const ownership = ownershipPayload(event);
  if (!ownership && channel !== 'standby') return null;

  const value = ownership?.value ?? {};
  const sender = record(event.sender);
  const recipient = record(event.recipient);
  return {
    eventType:
      ownership?.eventType ??
      (event.message && typeof event.message === 'object'
        ? 'standby_message'
        : 'standby_event'),
    channel,
    senderId: id(sender.id),
    recipientId: id(recipient.id),
    previousOwnerAppId:
      id(value.previous_owner_app_id) ?? id(value.previousOwnerAppId),
    newOwnerAppId: id(value.new_owner_app_id) ?? id(value.newOwnerAppId),
    eventTimestamp: timestamp(event.timestamp),
    payload: event
  };
}

export function extractInstagramOwnershipEvents(
  entry: UnknownRecord
): InstagramOwnershipEvent[] {
  const result: InstagramOwnershipEvent[] = [];
  for (const event of Array.isArray(entry.messaging) ? entry.messaging : []) {
    const normalized = normalizeEvent(record(event), 'messaging');
    if (normalized) result.push(normalized);
  }
  for (const event of Array.isArray(entry.standby) ? entry.standby : []) {
    const normalized = normalizeEvent(record(event), 'standby');
    if (normalized) result.push(normalized);
  }
  for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
    const change = record(rawChange);
    const field = id(change.field);
    if (field !== 'messaging_handover' && field !== 'standby') continue;
    const value = record(change.value);
    result.push({
      eventType: field,
      channel: 'changes',
      senderId: id(value.sender_id) ?? id(record(value.sender).id),
      recipientId: id(value.recipient_id) ?? id(record(value.recipient).id),
      previousOwnerAppId:
        id(value.previous_owner_app_id) ?? id(value.previousOwnerAppId),
      newOwnerAppId: id(value.new_owner_app_id) ?? id(value.newOwnerAppId),
      eventTimestamp: timestamp(value.timestamp) ?? timestamp(entry.time),
      payload: change
    });
  }
  return result;
}

export async function recordInstagramOwnershipEvents(params: {
  accountId: string;
  credentialId?: string | null;
  entryId: string;
  events: InstagramOwnershipEvent[];
}): Promise<number> {
  if (params.events.length === 0) return 0;
  const rows: Prisma.InstagramOwnershipEventLogCreateManyInput[] =
    params.events.map((event) => {
      const serialized = JSON.stringify({
        entryId: params.entryId,
        channel: event.channel,
        eventType: event.eventType,
        payload: event.payload
      });
      return {
        accountId: params.accountId,
        credentialId: params.credentialId ?? null,
        entryId: params.entryId,
        eventType: event.eventType,
        channel: event.channel,
        senderId: event.senderId,
        recipientId: event.recipientId,
        previousOwnerAppId: event.previousOwnerAppId,
        newOwnerAppId: event.newOwnerAppId,
        eventTimestamp: event.eventTimestamp,
        payloadHash: createHash('sha256').update(serialized).digest('hex'),
        payload: event.payload as Prisma.InputJsonValue
      };
    });
  const inserted = await prisma.instagramOwnershipEventLog.createMany({
    data: rows,
    skipDuplicates: true
  });
  return inserted.count;
}
