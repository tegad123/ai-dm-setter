import crypto from 'crypto';
import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { scheduleCallConfirmationSequence } from '@/lib/call-confirmation-sequence';
import { isUpgrade, transitionLeadStage } from '@/lib/lead-stage';
import type { LeadStage } from '@prisma/client';

export interface TypeformFieldMapping {
  email?: string;
  instagramUsername?: string;
  capitalAmount?: string;
  tradingExperience?: string;
  scheduledCallTime?: string;
  fullName?: string;
  [key: string]: string | undefined;
}

export interface TypeformParsedApplication {
  email?: string | null;
  instagramUsername?: string | null;
  capitalAmount?: number | null;
  tradingExperience?: string | null;
  scheduledCallTime?: string | null;
  fullName?: string | null;
  [key: string]: string | number | null | undefined;
}

interface TypeformAnswer {
  field?: {
    id?: string;
    ref?: string;
    type?: string;
    title?: string;
  };
  type?: string;
  [key: string]: unknown;
}

interface TypeformPayload {
  event_id?: string;
  event_type?: string;
  form_response?: {
    form_id?: string;
    token?: string;
    submitted_at?: string;
    answers?: TypeformAnswer[];
    /**
     * Typeform "hidden fields" — set per-lead by appending
     * `#fieldName=value&otherField=…` to the form URL. We use
     * `conversationid` (lowercase, alphanumeric) as the primary
     * conversation key so when the AI sends a personalized form
     * link to a specific lead, the resulting submission routes
     * back to THAT conversation with no email/IG-handle guessing.
     */
    hidden?: Record<string, string | undefined>;
  };
}

interface ProcessTypeformResult {
  ok: true;
  duplicate: boolean;
  matched: boolean;
  accountId: string;
  leadId: string;
  conversationId: string;
}

export class TypeformWebhookError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'TypeformWebhookError';
    this.status = status;
  }
}

export function verifyTypeformSignature(params: {
  rawBody: string;
  signature: string | null;
  secret: string | null | undefined;
}): boolean {
  const secret = params.secret?.trim();
  const header = params.signature?.trim();
  if (!secret || !header?.startsWith('sha256=')) return false;

  const received = header.slice('sha256='.length).trim();
  const digest = crypto
    .createHmac('sha256', secret)
    .update(params.rawBody)
    .digest();

  return safeCompare(received, digest.toString('base64')) ||
    safeCompare(received, digest.toString('hex'))
    ? true
    : false;
}

function safeCompare(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normalizeTypeformAnswers(answers: TypeformAnswer[]): Array<{
  fieldId: string;
  fieldRef: string | null;
  fieldTitle: string | null;
  type: string;
  value: string | number | boolean | null;
}> {
  return answers.map((answer) => ({
    fieldId: String(answer.field?.id ?? ''),
    fieldRef: answer.field?.ref ? String(answer.field.ref) : null,
    fieldTitle: answer.field?.title ? String(answer.field.title) : null,
    type: String(answer.type ?? answer.field?.type ?? 'unknown'),
    value: extractAnswerValue(answer)
  }));
}

export function parseTypeformApplication(
  answers: TypeformAnswer[],
  mapping: TypeformFieldMapping
): TypeformParsedApplication {
  const normalized = normalizeTypeformAnswers(answers);
  const parsed: TypeformParsedApplication = {};

  for (const [key, fieldKey] of Object.entries(mapping)) {
    if (!fieldKey) continue;
    const answer = normalized.find(
      (a) =>
        a.fieldId === fieldKey ||
        a.fieldRef === fieldKey ||
        a.fieldTitle === fieldKey
    );
    const value = answer?.value ?? null;
    if (key === 'capitalAmount') {
      parsed[key] = parseCapitalAmount(value);
    } else {
      parsed[key] = value === null ? null : String(value).trim() || null;
    }
  }

  if (typeof parsed.instagramUsername === 'string') {
    parsed.instagramUsername = cleanInstagramUsername(parsed.instagramUsername);
  }
  if (typeof parsed.email === 'string') {
    parsed.email = parsed.email.trim().toLowerCase();
  }

  return parsed;
}

export async function processTypeformWebhook(params: {
  accountId: string | null;
  rawBody: string;
  signature: string | null;
}): Promise<ProcessTypeformResult> {
  const accountId = params.accountId?.trim();
  if (!accountId) {
    throw new TypeformWebhookError('Missing accountId', 400);
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true }
  });
  if (!account) {
    throw new TypeformWebhookError('Account not found', 404);
  }

  const creds = await getCredentials(accountId, 'TYPEFORM');
  const webhookSecret =
    (typeof creds?.webhookSecret === 'string' && creds.webhookSecret) ||
    (typeof creds?.typeformWebhookSecret === 'string' &&
      creds.typeformWebhookSecret) ||
    process.env.TYPEFORM_WEBHOOK_SECRET ||
    null;

  if (
    !verifyTypeformSignature({
      rawBody: params.rawBody,
      signature: params.signature,
      secret: webhookSecret
    })
  ) {
    throw new TypeformWebhookError('Invalid Typeform signature', 401);
  }

  const payload = JSON.parse(params.rawBody) as TypeformPayload;
  if (payload.event_type !== 'form_response' || !payload.form_response) {
    throw new TypeformWebhookError('Unsupported Typeform event', 400);
  }

  const token = payload.form_response.token;
  if (!token) {
    throw new TypeformWebhookError('Missing form response token', 400);
  }

  const duplicate = await prisma.conversation.findUnique({
    where: { typeformResponseToken: token },
    select: { id: true, leadId: true, lead: { select: { accountId: true } } }
  });
  if (duplicate?.lead.accountId === accountId) {
    return {
      ok: true,
      duplicate: true,
      matched: true,
      accountId,
      leadId: duplicate.leadId,
      conversationId: duplicate.id
    };
  }

  const persona = await prisma.aIPersona.findFirst({
    where: { accountId },
    orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true,
      promptConfig: true,
      minimumCapitalRequired: true
    }
  });
  const promptConfig =
    persona?.promptConfig && typeof persona.promptConfig === 'object'
      ? (persona.promptConfig as Record<string, unknown>)
      : {};
  const fieldMapping = normalizeFieldMapping(
    promptConfig.typeformFieldMapping ??
      ((creds?.fieldMapping || null) as unknown)
  );
  const answers = payload.form_response.answers ?? [];
  const parsed = parseTypeformApplication(answers, fieldMapping);
  const normalizedAnswers = normalizeTypeformAnswers(answers);
  const submittedAt =
    parseDate(payload.form_response.submitted_at) ?? new Date();
  const callScheduledAt = parseDate(parsed.scheduledCallTime ?? null);

  // Step 1: prefer the `conversationid` hidden field if present. This
  // is the deterministic per-lead routing path: when the AI sends a
  // personalized link `…/to/FORM#conversationid=CONVO_ID`, the
  // submission posts back with that ID in `form_response.hidden`,
  // letting us match the exact conversation without email/IG
  // heuristics. We still scope by accountId so a spoofed/leaked ID
  // from another tenant cannot route into this account.
  const hidden = payload.form_response.hidden ?? {};
  const hiddenConvoId =
    typeof hidden.conversationid === 'string' && hidden.conversationid.trim()
      ? hidden.conversationid.trim()
      : null;
  let directMatch: { id: string; leadId: string } | null = null;
  if (hiddenConvoId) {
    const direct = await prisma.conversation.findUnique({
      where: { id: hiddenConvoId },
      select: { id: true, leadId: true, lead: { select: { accountId: true } } }
    });
    if (direct && direct.lead.accountId === accountId) {
      directMatch = { id: direct.id, leadId: direct.leadId };
    } else if (direct) {
      // Cross-tenant id leak — REFUSE to use it. Log and fall back.
      console.warn(
        `[typeform-webhook] hidden conversationid=${hiddenConvoId} ` +
          `belongs to account ${direct.lead.accountId}, not ${accountId} — ` +
          `falling back to email/IG match.`
      );
    } else {
      console.warn(
        `[typeform-webhook] hidden conversationid=${hiddenConvoId} not found ` +
          `(lead may have been deleted) — falling back to email/IG match.`
      );
    }
  }

  // Step 2: fall back to email/IG-handle heuristic match for inbound
  // forms not initiated via a personalized AI-sent link (e.g. someone
  // shares the form URL directly).
  const match =
    directMatch ??
    (await findMatchingConversation({
      accountId,
      instagramUsername:
        typeof parsed.instagramUsername === 'string'
          ? parsed.instagramUsername
          : null,
      email: typeof parsed.email === 'string' ? parsed.email : null
    }));

  const { conversationId, leadId, matched } = match
    ? { conversationId: match.id, leadId: match.leadId, matched: true }
    : await createTypeformOnlyLead({
        accountId,
        token,
        formId: payload.form_response.form_id ?? null,
        fullName: typeof parsed.fullName === 'string' ? parsed.fullName : null,
        instagramUsername:
          typeof parsed.instagramUsername === 'string'
            ? parsed.instagramUsername
            : null,
        email: typeof parsed.email === 'string' ? parsed.email : null
      });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      typeformSubmittedAt: submittedAt,
      typeformResponseToken: token,
      typeformCapitalConfirmed:
        typeof parsed.capitalAmount === 'number' ? parsed.capitalAmount : null,
      typeformCallScheduledAt: callScheduledAt,
      typeformAnswers: {
        eventId: payload.event_id ?? null,
        formId: payload.form_response.form_id ?? null,
        token,
        submittedAt: submittedAt.toISOString(),
        parsed,
        answers: normalizedAnswers
      },
      ...(typeof parsed.email === 'string' ? { leadEmail: parsed.email } : {}),
      ...(callScheduledAt
        ? {
            scheduledCallAt: callScheduledAt,
            scheduledCallSource: 'CALENDAR_INTEGRATION',
            scheduledCallConfirmed: true,
            scheduledCallUpdatedAt: new Date()
          }
        : {})
    }
  });

  await updateLeadFromTypeform({
    leadId,
    accountId,
    parsed,
    minimumCapitalRequired: persona?.minimumCapitalRequired ?? null,
    callScheduledAt
  });

  if (callScheduledAt && callScheduledAt.getTime() > Date.now()) {
    await scheduleCallConfirmationSequence({
      conversationId,
      accountId,
      scheduledCallAt: callScheduledAt,
      leadTimezone: null,
      createdByUserId: null
    }).catch((err) => {
      console.error(
        '[typeform-webhook] pre-call sequence scheduling failed:',
        err
      );
    });
  }

  return {
    ok: true,
    duplicate: false,
    matched,
    accountId,
    leadId,
    conversationId
  };
}

function normalizeFieldMapping(input: unknown): TypeformFieldMapping {
  if (!input || typeof input !== 'object') return {};
  const out: TypeformFieldMapping = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

function extractAnswerValue(
  answer: TypeformAnswer
): string | number | boolean | null {
  const type = String(answer.type ?? '');
  if (type && answer[type] !== undefined) {
    const typedValue = answer[type];
    if (
      typeof typedValue === 'string' ||
      typeof typedValue === 'number' ||
      typeof typedValue === 'boolean'
    ) {
      return typedValue;
    }
    if (typedValue && typeof typedValue === 'object') {
      const obj = typedValue as Record<string, unknown>;
      if (typeof obj.label === 'string') return obj.label;
      if (typeof obj.amount === 'number') return obj.amount;
      if (Array.isArray(obj.labels)) return obj.labels.join(', ');
    }
  }
  for (const key of [
    'text',
    'email',
    'phone_number',
    'url',
    'date',
    'number',
    'boolean'
  ]) {
    const value = answer[key];
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }
  }
  return null;
}

function parseCapitalAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value !== 'string') return null;
  const cleaned = value
    .toLowerCase()
    .replace(/,/g, '')
    .replace(/\$/g, '')
    .trim();
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(k|m)?/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1000 : 1;
  return Math.round(base * multiplier);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanInstagramUsername(username: string): string {
  return username.replace(/^@+/, '').trim();
}

async function findMatchingConversation(params: {
  accountId: string;
  instagramUsername: string | null;
  email: string | null;
}): Promise<{ id: string; leadId: string } | null> {
  const or: Array<Record<string, unknown>> = [];
  if (params.instagramUsername) {
    or.push({
      lead: {
        is: {
          accountId: params.accountId,
          handle: { equals: params.instagramUsername, mode: 'insensitive' }
        }
      }
    });
  }
  if (params.email) {
    or.push({
      lead: {
        is: {
          accountId: params.accountId,
          email: { equals: params.email, mode: 'insensitive' }
        }
      }
    });
    or.push({
      lead: { is: { accountId: params.accountId } },
      leadEmail: { equals: params.email, mode: 'insensitive' }
    });
  }
  if (or.length === 0) return null;
  return prisma.conversation.findFirst({
    where: { OR: or },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, leadId: true }
  });
}

async function createTypeformOnlyLead(params: {
  accountId: string;
  token: string;
  formId: string | null;
  fullName: string | null;
  instagramUsername: string | null;
  email: string | null;
}): Promise<{ conversationId: string; leadId: string; matched: false }> {
  const handle =
    params.instagramUsername ||
    (params.email
      ? params.email.split('@')[0]
      : `typeform_${params.token.slice(0, 8)}`);
  const { resolveActivePersonaIdForCreate } = await import(
    '@/lib/active-persona'
  );
  const personaId = await resolveActivePersonaIdForCreate(params.accountId);
  const lead = await prisma.lead.create({
    data: {
      accountId: params.accountId,
      name: params.fullName || handle,
      handle,
      platform: 'INSTAGRAM',
      platformUserId: null,
      triggerType: 'DM',
      triggerSource: params.formId ? `typeform:${params.formId}` : 'typeform',
      email: params.email,
      stage: 'NEW_LEAD',
      conversation: {
        create: {
          personaId,
          aiActive: false,
          unreadCount: 0,
          leadEmail: params.email
        }
      }
    },
    include: { conversation: { select: { id: true } } }
  });

  const tag = await prisma.tag.upsert({
    where: {
      accountId_name: {
        accountId: params.accountId,
        name: 'typeform_no_conversation'
      }
    },
    update: {},
    create: {
      accountId: params.accountId,
      name: 'typeform_no_conversation',
      color: '#f59e0b',
      isAuto: true
    },
    select: { id: true }
  });
  await prisma.leadTag.upsert({
    where: { leadId_tagId: { leadId: lead.id, tagId: tag.id } },
    update: {},
    create: {
      leadId: lead.id,
      tagId: tag.id,
      appliedBy: 'TYPEFORM',
      confidence: 1
    }
  });
  await prisma.notification.create({
    data: {
      accountId: params.accountId,
      type: 'SYSTEM',
      title: 'Typeform submission without matching conversation',
      body: `${lead.name} submitted an application, but no matching DM conversation was found. Review and connect this lead manually.`,
      leadId: lead.id
    }
  });

  return {
    conversationId: lead.conversation!.id,
    leadId: lead.id,
    matched: false
  };
}

async function updateLeadFromTypeform(params: {
  leadId: string;
  accountId: string;
  parsed: TypeformParsedApplication;
  minimumCapitalRequired: number | null;
  callScheduledAt: Date | null;
}): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: params.leadId },
    select: { stage: true, email: true, name: true }
  });
  if (!lead) return;

  const updateData: Record<string, unknown> = {};
  if (typeof params.parsed.email === 'string' && !lead.email) {
    updateData.email = params.parsed.email;
  }
  if (typeof params.parsed.fullName === 'string' && params.parsed.fullName) {
    updateData.name = params.parsed.fullName;
  }
  if (params.callScheduledAt) {
    updateData.bookedAt = new Date();
  }
  if (Object.keys(updateData).length > 0) {
    await prisma.lead.update({
      where: { id: params.leadId },
      data: updateData
    });
  }

  let targetStage: LeadStage | null = null;
  if (params.callScheduledAt) {
    targetStage = 'BOOKED';
  } else if (
    typeof params.parsed.capitalAmount === 'number' &&
    typeof params.minimumCapitalRequired === 'number' &&
    params.parsed.capitalAmount >= params.minimumCapitalRequired &&
    !['CALL_PROPOSED', 'BOOKED', 'SHOWED', 'CLOSED_WON'].includes(lead.stage)
  ) {
    targetStage = 'QUALIFIED';
  }

  if (targetStage && isUpgrade(lead.stage, targetStage)) {
    await transitionLeadStage(
      params.leadId,
      targetStage,
      'system',
      targetStage === 'BOOKED'
        ? 'Typeform application included scheduled call time'
        : 'Typeform application confirmed minimum capital'
    );
  }
}
