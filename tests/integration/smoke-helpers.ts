/* eslint-disable no-console */
// Helpers shared by the smoke-test runner.
//
// - installFetchStub(): swallows Meta API calls (graph.instagram.com,
//   graph.facebook.com). Anthropic + OpenAI requests pass through to
//   real APIs so the LLM call is genuinely exercised.
// - seedConversation(): persists Lead + Conversation + history Messages
//   to the test DB. Ends with a single trailing LEAD Message (the
//   "incoming" one) so scheduleAIReply has something to reply to.
// - drainScheduledReply(): calls scheduleAIReply with skipDelayQueue,
//   then waits for the AI Message row to land.
// - readReplyState(): reads back AI message content + Conversation
//   state for assertions.
// - deleteConversationTree(): per-test cleanup.

import { SMOKE_CONFIG } from './smoke-config';

export interface SmokeMessage {
  sender: 'AI' | 'LEAD' | 'HUMAN';
  content: string;
  ageMs?: number;
}

export interface SeedConversationInput {
  accountId: string;
  personaId: string;
  history: SmokeMessage[];
  trailingLeadMessage: string;
  igUserIdSuffix: string;
  capturedDataPoints?: Record<string, unknown>;
  systemStage?: string | null;
  awaitingAiResponse?: boolean;
}

export interface SeedConversationOutput {
  leadId: string;
  conversationId: string;
  trailingMessageTimestamp: Date;
}

const META_HOST_PATTERNS = [/graph\.instagram\.com/i, /graph\.facebook\.com/i];

interface MetaCall {
  url: string;
  method: string;
  body: string | null;
}

let metaCalls: MetaCall[] = [];
let originalFetch: typeof fetch | null = null;

export function installFetchStub() {
  if (originalFetch) return; // idempotent
  originalFetch = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const isMeta = META_HOST_PATTERNS.some((p) => p.test(url));
    if (isMeta) {
      metaCalls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null
      });
      // Pretend the send succeeded with a synthetic message id. Same
      // shape Meta returns for /{ig-user-id}/messages.
      return new Response(
        JSON.stringify({
          recipient_id: 'mock_recipient',
          message_id: `mock_${Date.now()}`
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return originalFetch!(input, init);
  }) as typeof fetch;
}

export function popMetaCalls(): MetaCall[] {
  const calls = metaCalls;
  metaCalls = [];
  return calls;
}

export function uninstallFetchStub() {
  if (originalFetch) {
    global.fetch = originalFetch;
    originalFetch = null;
  }
}

export async function seedConversation(
  input: SeedConversationInput
): Promise<SeedConversationOutput> {
  const prisma = (await import('../../src/lib/prisma')).default;
  const igUserId = `${SMOKE_CONFIG.testIgUserIdPrefix}${input.igUserIdSuffix}`;
  const handle = `${SMOKE_CONFIG.testHandlePrefix}${input.igUserIdSuffix}`;

  const lead = await prisma.lead.create({
    data: {
      accountId: input.accountId,
      name: handle,
      handle,
      platform: 'INSTAGRAM',
      platformUserId: igUserId,
      triggerType: 'DM',
      triggerSource: 'smoke-test',
      stage: 'NEW_LEAD'
    }
  });

  const baseTime = Date.now() - (input.history.length + 1) * 30_000;
  const conversation = await prisma.conversation.create({
    data: {
      leadId: lead.id,
      personaId: input.personaId,
      aiActive: true,
      unreadCount: 0,
      source: 'INBOUND',
      systemStage: input.systemStage ?? null,
      capturedDataPoints: (input.capturedDataPoints ?? {}) as never,
      awaitingAiResponse: input.awaitingAiResponse ?? false,
      lastMessageAt: new Date()
    }
  });

  // Persist history messages (oldest → newest) with monotonic
  // timestamps so the ordering matches what the pipeline expects.
  for (let i = 0; i < input.history.length; i++) {
    const m = input.history[i]!;
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        sender: m.sender,
        content: m.content,
        timestamp: new Date(baseTime + i * 30_000)
      }
    });
  }

  const trailingTs = new Date(baseTime + input.history.length * 30_000);
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      sender: 'LEAD',
      content: input.trailingLeadMessage,
      timestamp: trailingTs
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: trailingTs, awaitingAiResponse: true }
  });

  return {
    leadId: lead.id,
    conversationId: conversation.id,
    trailingMessageTimestamp: trailingTs
  };
}

export async function drainScheduledReply(
  conversationId: string,
  accountId: string,
  trailingTs: Date,
  timeoutMs = 30_000
): Promise<void> {
  const prisma = (await import('../../src/lib/prisma')).default;
  const { scheduleAIReply } = await import('../../src/lib/webhook-processor');

  await scheduleAIReply(conversationId, accountId, { skipDelayQueue: true });

  // scheduleAIReply may itself enqueue a ScheduledReply row meant to be
  // picked up by a cron worker. Drain any PENDING rows synchronously.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await prisma.scheduledReply.findFirst({
      where: { conversationId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' }
    });
    if (!pending) break;
    const { processScheduledReply } = await import(
      '../../src/lib/webhook-processor'
    );
    await processScheduledReply(conversationId, accountId, {
      messageType: pending.messageType,
      generatedResult: pending.generatedResult,
      createdAt: pending.createdAt
    });
    await prisma.scheduledReply
      .update({ where: { id: pending.id }, data: { status: 'SENT' } })
      .catch(() => null);
  }

  // Wait for the new AI message row to actually exist (sendAIReply
  // commits asynchronously after the Meta-stub returns).
  while (Date.now() - start < timeoutMs) {
    const aiAfter = await prisma.message.findFirst({
      where: {
        conversationId,
        sender: 'AI',
        timestamp: { gt: trailingTs }
      }
    });
    if (aiAfter) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `drainScheduledReply timed out after ${timeoutMs}ms — no AI reply persisted`
  );
}

export interface ReplyStateSnapshot {
  reply: string;
  allReplyMessages: string[];
  systemStage: string | null;
  capitalVerificationStatus: string;
  capitalVerifiedAmount: number | null;
  capturedDataPoints: Record<string, unknown>;
  aiActive: boolean;
  outcome: string;
}

export async function readReplyState(
  conversationId: string,
  trailingTs: Date
): Promise<ReplyStateSnapshot> {
  const prisma = (await import('../../src/lib/prisma')).default;
  const aiMsgs = await prisma.message.findMany({
    where: {
      conversationId,
      sender: 'AI',
      timestamp: { gt: trailingTs }
    },
    orderBy: { timestamp: 'asc' }
  });
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId }
  });
  return {
    reply: aiMsgs.map((m) => m.content).join('\n'),
    allReplyMessages: aiMsgs.map((m) => m.content),
    systemStage: conv?.systemStage ?? null,
    capitalVerificationStatus: conv?.capitalVerificationStatus ?? 'UNVERIFIED',
    capitalVerifiedAmount: conv?.capitalVerifiedAmount ?? null,
    capturedDataPoints:
      (conv?.capturedDataPoints as Record<string, unknown>) ?? {},
    aiActive: conv?.aiActive ?? false,
    outcome: conv?.outcome ?? 'ONGOING'
  };
}

export async function deleteConversationTree(
  leadId: string,
  conversationId: string
): Promise<void> {
  const prisma = (await import('../../src/lib/prisma')).default;
  await prisma.message.deleteMany({ where: { conversationId } });
  await prisma.scheduledReply.deleteMany({ where: { conversationId } });
  await prisma.conversation.deleteMany({ where: { id: conversationId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
}

export async function resolveAccountId(): Promise<string> {
  const prisma = (await import('../../src/lib/prisma')).default;
  const account = await prisma.account.findUnique({
    where: { slug: SMOKE_CONFIG.testAccountSlug },
    select: { id: true }
  });
  if (!account) {
    throw new Error(
      `Test account "${SMOKE_CONFIG.testAccountSlug}" not found — run npm run test:smoke:seed first.`
    );
  }
  return account.id;
}

export async function resolvePersonaId(accountId: string): Promise<string> {
  if (SMOKE_CONFIG.testPersonaId) return SMOKE_CONFIG.testPersonaId;
  const prisma = (await import('../../src/lib/prisma')).default;
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, personaName: SMOKE_CONFIG.testPersonaName },
    select: { id: true }
  });
  if (!persona) {
    throw new Error(
      `Test persona "${SMOKE_CONFIG.testPersonaName}" not found in account "${SMOKE_CONFIG.testAccountSlug}" — run npm run test:smoke:seed first.`
    );
  }
  return persona.id;
}
