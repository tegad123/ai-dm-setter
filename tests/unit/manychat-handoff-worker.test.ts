import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createManyChatHandoffReceiptWorker } from '../../src/lib/manychat-handoff-worker';

const NOW = new Date('2026-09-18T18:00:00Z');
type Row = Record<string, any>; // In-memory Prisma adapter, intentionally supports dynamic query shapes.
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((item: Row) => matches(row, item));
    const actual = row[key];
    if (value === null || value instanceof Date || typeof value !== 'object')
      return actual === value;
    return Object.entries(value).every(([op, expected]) => {
      if (op === 'in') return (expected as unknown[]).includes(actual);
      if (op === 'not') return actual !== expected;
      if (op === 'lte') return actual <= (expected as Date);
      if (op === 'gte') return actual >= (expected as Date);
      if (op === 'lt') return actual < (expected as Date);
      if (op === 'gt') return actual > (expected as Date);
      if (op === 'equals')
        return String(actual).toLowerCase() === String(expected).toLowerCase();
      if (op === 'mode') return true;
      return false;
    });
  });
}
function apply(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    row[key] =
      value && typeof value === 'object' && 'increment' in value
        ? (row[key] || 0) + value.increment
        : value;
  }
}
function fixture() {
  const receipt: Row = {
    id: 'r1',
    accountId: 'a1',
    platform: 'INSTAGRAM',
    subscriberId: '1234',
    payloadHash: 'hash',
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseUntil: null,
    conversationId: null,
    openerMessageId: null,
    leadMessageId: null,
    scheduledReplyId: null,
    nativeInboundOwned: false,
    schedulingStartedAt: null,
    lastError: null,
    receivedAt: NOW,
    updatedAt: NOW,
    payload: {
      platform: 'instagram',
      instagramUserId: '1234',
      manyChatSubscriberId: '1234',
      instagramUsername: 'test.contact',
      openerMessage: 'Are you starting?',
      triggerType: 'new_follower',
      scheduleAi: true,
      leadResponseText: 'Starting',
      processingMode: 'queued_first_reply'
    }
  };
  const lead: Row = {
    id: 'l1',
    accountId: 'a1',
    platform: 'INSTAGRAM',
    platformUserId: '123456789012345',
    handle: 'test.contact'
  };
  const conversation: Row = {
    id: 'c1',
    source: 'MANYCHAT',
    aiActive: true,
    awaitingHumanReview: false,
    distressDetected: false,
    schedulingConflict: false,
    autoSendOverride: false,
    lastMessageAt: new Date(NOW.getTime() - 60_000),
    manyChatOpenerMessage: 'Are you starting?',
    manyChatFiredAt: new Date(NOW.getTime() - 60_000),
    lead,
    unreadCount: 0
  };
  lead.conversation = conversation;
  const messages: Row[] = [
    {
      id: 'opener',
      conversationId: 'c1',
      sender: 'MANYCHAT',
      content: 'Are you starting?',
      timestamp: conversation.manyChatFiredAt,
      deletedAt: null,
      platformMessageId: null,
      providerMessageId: 'manychat-opener-1',
      deliveryStatus: 'PROVIDER_REPORTED',
      deliveryReportedAt: conversation.manyChatFiredAt
    }
  ];
  const jobs: Row[] = [];
  const groups: Row[] = [];
  const notifications: Row[] = [];
  const account = {
    awayModeInstagram: true,
    generateOnlyInstagram: false,
    awayModeFacebook: false,
    generateOnlyFacebook: false
  };
  const state = {
    account,
    receipt,
    lead,
    conversation,
    messages,
    jobs,
    groups,
    notifications,
    missingLead: false,
    schedules: 0,
    lookups: 0,
    fencedWrites: 0,
    advisoryLocks: 0,
    failTransaction: false,
    failNotification: false,
    notificationInTransaction: 0,
    transactionDepth: 0
  };
  function query(rows: Row[], args: Row) {
    const result = rows.filter((r) => matches(r, args.where));
    if (args.orderBy) {
      const [field, direction] = Object.entries(args.orderBy)[0];
      result.sort(
        (a, b) =>
          (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) *
          (direction === 'desc' ? -1 : 1)
      );
    }
    return result.slice(0, args.take ?? result.length);
  }
  const db: Row = {
    manyChatHandoffReceipt: {
      findMany: async (args: Row) =>
        query([receipt], args).map((r) => ({ ...r })),
      updateMany: async (args: Row) => {
        if (!matches(receipt, args.where)) return { count: 0 };
        apply(receipt, args.data);
        state.fencedWrites++;
        return { count: 1 };
      }
    },
    lead: {
      findMany: async (args: Row) =>
        state.missingLead ? [] : query([lead], args),
      update: async (args: Row) => {
        apply(lead, args.data);
        return lead;
      }
    },
    conversation: {
      findUnique: async () => conversation,
      update: async (args: Row) => {
        apply(conversation, args.data);
        return conversation;
      },
      updateMany: async (args: Row) => {
        if (!matches(conversation, args.where)) return { count: 0 };
        apply(conversation, args.data);
        return { count: 1 };
      }
    },
    account: { findUnique: async () => account },
    message: {
      findMany: async (args: Row) => query(messages, args),
      findFirst: async (args: Row) => query(messages, args)[0] ?? null,
      findUnique: async (args: Row) =>
        messages.find((r) => matches(r, args.where)) ?? null,
      create: async (args: Row) => {
        const row = {
          id: `m${messages.length}`,
          deletedAt: null,
          platformMessageId: null,
          ...args.data
        };
        messages.push(row);
        return row;
      }
    },
    messageGroup: { findMany: async () => groups },
    scheduledReply: { findMany: async (args: Row) => query(jobs, args) },
    notification: {
      upsert: async (args: Row) => {
        assert.equal(
          state.transactionDepth,
          1,
          'terminal notification must be in fenced transaction'
        );
        state.notificationInTransaction++;
        if (state.failNotification)
          throw new Error('simulated notification failure');
        if (!notifications.some((n) => n.id === args.where.id))
          notifications.push(args.create);
        return args.create;
      }
    },
    $executeRaw: async () => {
      state.advisoryLocks++;
      return 1;
    }
  };
  db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => {
    if (state.failTransaction) throw new Error('simulated db unavailable');
    const saved = structuredClone({
      receipt,
      messages,
      jobs,
      notifications,
      conversation: { ...conversation, lead: undefined },
      lead: { ...lead, conversation: undefined }
    });
    state.transactionDepth++;
    try {
      return await fn(db);
    } catch (error) {
      for (const key of Object.keys(receipt)) delete receipt[key];
      Object.assign(receipt, saved.receipt);
      messages.splice(0, messages.length, ...saved.messages);
      jobs.splice(0, jobs.length, ...saved.jobs);
      notifications.splice(0, notifications.length, ...saved.notifications);
      Object.assign(conversation, saved.conversation, { lead });
      Object.assign(lead, saved.lead, { conversation });
      throw error;
    } finally {
      state.transactionDepth--;
    }
  };
  const deps = {
    db: db as unknown as PrismaClient,
    now: () => NOW,
    token: () => 'lease-token',
    resolveRecipient: async () => {
      state.lookups++;
      return '123456789012345';
    },
    schedule: async (
      _conversationId: string,
      _accountId: string,
      receiptId: string,
      leaseToken: string
    ) => {
      state.schedules++;
      assert.equal(receiptId, 'r1');
      assert.equal(leaseToken, 'lease-token');
      jobs.push({
        id: 'job1',
        conversationId: 'c1',
        createdAt: NOW,
        status: 'PENDING'
      });
    }
  };
  return { state, deps, run: () => createManyChatHandoffReceiptWorker(deps)() };
}

describe('durable ManyChat handoff worker', () => {
  it('persists first reply and confirms actual queued work, reuses recipient and opener', async () => {
    const f = fixture();
    const result = await f.run();
    assert.equal(result.queued, 1);
    assert.equal(f.state.schedules, 1);
    assert.equal(f.state.lookups, 0);
    assert.equal(f.state.messages.length, 2);
    assert.equal(f.state.receipt.scheduledReplyId, 'job1');
    assert.equal(f.state.receipt.leadMessageId, 'm1');
    assert.equal(f.state.advisoryLocks, 1);
    assert.equal(f.state.receipt.leaseToken, null);
  });
  it('processes a valid first response without manufacturing a visible opener', async () => {
    const f = fixture();
    f.state.messages.splice(0, 1);
    const result = await f.run();
    assert.equal(result.queued, 1);
    assert.equal(f.state.messages.length, 1);
    assert.equal(f.state.messages[0].sender, 'LEAD');
    assert.equal(f.state.receipt.openerMessageId, null);
    assert.equal(f.state.receipt.leadMessageId, f.state.messages[0].id);
    assert.equal(f.state.schedules, 1);
  });
  it('queues a Facebook first reply with the subscriber PSID and Facebook settings', async () => {
    const f = fixture();
    Object.assign(f.state.receipt, {
      platform: 'FACEBOOK',
      subscriberId: '27000000000000001',
      payload: {
        processingMode: 'queued_first_reply',
        platform: 'facebook',
        facebookUserId: '27000000000000001',
        contactName: 'Facebook Contact',
        instagramUserId: '',
        instagramUsername: '',
        manyChatSubscriberId: '27000000000000001',
        openerMessage: 'Are you starting?',
        triggerType: 'new_follower',
        scheduleAi: true,
        leadResponseText: 'Starting'
      }
    });
    Object.assign(f.state.lead, {
      platform: 'FACEBOOK',
      platformUserId: '27000000000000001',
      handle: 'Facebook Contact'
    });
    f.state.account.awayModeFacebook = true;
    f.state.account.awayModeInstagram = false;
    const result = await f.run();
    assert.equal(result.queued, 1);
    assert.equal(f.state.schedules, 1);
    assert.equal(f.state.lookups, 0, 'Facebook PSID must skip IG lookup');
    assert.equal(f.state.receipt.leadMessageId, 'm1');
  });
  it('uses Facebook generate-only and review holds without changing them', async () => {
    for (const change of [
      { generateOnlyFacebook: true },
      { awaitingHumanReview: true },
      { distressDetected: true }
    ]) {
      const f = fixture();
      Object.assign(f.state.receipt, {
        platform: 'FACEBOOK',
        subscriberId: '27000000000000001',
        payload: {
          processingMode: 'queued_first_reply',
          platform: 'facebook',
          facebookUserId: '27000000000000001',
          contactName: 'Facebook Contact',
          instagramUserId: '',
          instagramUsername: '',
          manyChatSubscriberId: '27000000000000001',
          openerMessage: 'Are you starting?',
          triggerType: 'new_follower',
          scheduleAi: true,
          leadResponseText: 'Starting'
        }
      });
      Object.assign(f.state.lead, {
        platform: 'FACEBOOK',
        platformUserId: '27000000000000001',
        handle: 'Facebook Contact'
      });
      f.state.account.awayModeFacebook = true;
      if ('generateOnlyFacebook' in change)
        Object.assign(f.state.account, change);
      else Object.assign(f.state.conversation, change);
      await f.run();
      assert.equal(f.state.receipt.status, 'HELD');
      assert.equal(f.state.schedules, 0);
      for (const [key, value] of Object.entries(change)) {
        const owner: Row =
          key in f.state.account ? f.state.account : f.state.conversation;
        assert.equal(owner[key], value);
      }
    }
  });
  it('reuses native Meta inbound and existing pending work without another scheduler call', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'native',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: NOW,
      deletedAt: null,
      platformMessageId: 'mid-native'
    });
    f.state.jobs.push({
      id: 'native-job',
      conversationId: 'c1',
      status: 'PENDING',
      createdAt: NOW
    });
    await f.run();
    assert.equal(f.state.messages.length, 2);
    assert.equal(f.state.receipt.leadMessageId, 'native');
    assert.equal(f.state.receipt.scheduledReplyId, 'native-job');
    assert.equal(f.state.schedules, 0);
  });
  it('does not mistake a historical same-text reply for this fresh inbound', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'old',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: new Date(NOW.getTime() - 3600_000),
      deletedAt: null,
      platformMessageId: 'old-mid'
    });
    await f.run();
    assert.notEqual(f.state.receipt.leadMessageId, 'old');
    assert.equal(f.state.messages.length, 3);
  });
  it('retries missing original context without creating a competing lead', async () => {
    const f = fixture();
    f.state.missingLead = true;
    const result = await f.run();
    assert.equal(result.retried, 1);
    assert.equal(
      f.state.receipt.nextAttemptAt.getTime(),
      NOW.getTime() + 60_000
    );
    assert.equal(f.state.messages.length, 1);
    assert.equal(f.state.schedules, 0);
  });
  it('exhausts bounded retry to one sanitized review notification', async () => {
    const f = fixture();
    f.state.missingLead = true;
    f.state.receipt.attempts = 3;
    await f.run();
    assert.equal(f.state.receipt.status, 'NEEDS_REVIEW');
    assert.equal(f.state.notifications.length, 1);
    assert.equal(f.state.schedules, 0);
  });
  it('leaves human review, distress and disabled AI untouched', async () => {
    for (const change of [
      { awaitingHumanReview: true },
      { distressDetected: true },
      { aiActive: false },
      { schedulingConflict: true }
    ]) {
      const f = fixture();
      Object.assign(f.state.conversation, change);
      const before = f.state.messages.length;
      await f.run();
      assert.equal(f.state.receipt.status, 'HELD');
      assert.equal(f.state.schedules, 0);
      assert.equal(f.state.messages.length, before + 1);
      assert.ok(f.state.receipt.leadMessageId);
      for (const [key, value] of Object.entries(change))
        assert.equal(f.state.conversation[key], value);
    }
  });
  it('does not retry an existing terminal delivery failure', async () => {
    const f = fixture();
    f.state.jobs.push({
      id: 'failed',
      conversationId: 'c1',
      status: 'FAILED',
      createdAt: NOW
    });
    await f.run();
    assert.equal(f.state.receipt.status, 'NEEDS_REVIEW');
    assert.equal(f.state.schedules, 0);
  });
  it('scheduler returning void without durable work is not success', async () => {
    const f = fixture();
    f.deps.schedule = async () => {
      f.state.schedules++;
    };
    await f.run();
    assert.equal(f.state.receipt.status, 'NEEDS_REVIEW');
    assert.equal(f.state.receipt.lastError, 'scheduling_outcome_uncertain');
  });
  it('scheduler throwing after queue commit reconciles as queued', async () => {
    const f = fixture();
    const original = f.deps.schedule;
    f.deps.schedule = async (...args) => {
      await original(...args);
      throw new Error('postcommit network break');
    };
    await f.run();
    assert.equal(f.state.receipt.status, 'QUEUED');
  });
  it('known deferred signal clears intent and retries without claiming success', async () => {
    const f = fixture();
    f.deps.schedule = async () => {
      throw new Error('HANDOFF_DEFERRED: native generation active');
    };
    await f.run();
    assert.equal(f.state.receipt.status, 'RETRY');
    assert.equal(f.state.receipt.schedulingStartedAt, null);
  });
  it('expired lease with prior scheduling intent never invokes scheduler again', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'inbound',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: NOW,
      deletedAt: null
    });
    Object.assign(f.state.receipt, {
      conversationId: 'c1',
      leadMessageId: 'inbound',
      schedulingStartedAt: new Date(NOW.getTime() - 300_000),
      status: 'PROCESSING',
      leaseUntil: new Date(NOW.getTime() - 1)
    });
    await f.run();
    assert.equal(f.state.receipt.status, 'NEEDS_REVIEW');
    assert.equal(f.state.schedules, 0);
  });
  it('a current lease cannot be stolen by another invocation', async () => {
    const f = fixture();
    Object.assign(f.state.receipt, {
      status: 'PROCESSING',
      leaseUntil: new Date(NOW.getTime() + 1000),
      leaseToken: 'another-worker'
    });
    assert.equal((await f.run()).claimed, 0);
    assert.equal(f.state.messages.length, 1);
  });
  it('uncertain or partial outbound requires review rather than first-reply replay', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'out',
      conversationId: 'c1',
      sender: 'AI',
      content: 'hello',
      timestamp: NOW,
      deletedAt: null,
      platformMessageId: null
    });
    await f.run();
    assert.equal(f.state.receipt.lastError, 'outbound_delivery_uncertain');
    assert.equal(f.state.schedules, 0);
  });
  it('confirmed delivered answer completes reconciliation without requeue', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'inbound',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: NOW,
      deletedAt: null
    });
    Object.assign(f.state.receipt, {
      conversationId: 'c1',
      leadMessageId: 'inbound'
    });
    f.state.messages.push({
      id: 'out',
      conversationId: 'c1',
      sender: 'AI',
      content: 'hello',
      timestamp: new Date(NOW.getTime() + 1000),
      deletedAt: null,
      platformMessageId: 'mid-sent'
    });
    await f.run();
    assert.equal(f.state.receipt.status, 'ALREADY_HANDLED');
    assert.equal(f.state.schedules, 0);
  });
  it('retains operator override when away mode is off but still honors generate-only', async () => {
    const f = fixture();
    f.state.account.awayModeInstagram = false;
    f.state.conversation.autoSendOverride = true;
    await f.run();
    assert.equal(f.state.receipt.status, 'QUEUED');
    const held = fixture();
    held.state.account.generateOnlyInstagram = true;
    held.state.conversation.autoSendOverride = true;
    await held.run();
    assert.equal(held.state.receipt.status, 'HELD');
    assert.equal(held.state.schedules, 0);
  });
  it('never replays a historical terminal failed first reply', async () => {
    const f = fixture();
    f.state.jobs.push({
      id: 'old-failed',
      conversationId: 'c1',
      status: 'FAILED',
      createdAt: new Date(NOW.getTime() - 3600_000)
    });
    await f.run();
    assert.equal(
      f.state.receipt.lastError,
      'existing_terminal_delivery_failure'
    );
    assert.equal(f.state.schedules, 0);
  });
  it('partial multi-bubble delivery is review even when one outbound has a Meta ID', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'out',
      conversationId: 'c1',
      sender: 'AI',
      content: 'hello',
      timestamp: NOW,
      deletedAt: null,
      platformMessageId: 'mid-one'
    });
    f.state.groups.push({
      bubbleCount: 2,
      completedAt: null,
      failedAt: NOW,
      messages: [{ platformMessageId: 'mid-one', deletedAt: null }]
    });
    await f.run();
    assert.equal(
      f.state.receipt.lastError,
      'partial_or_uncertain_message_group'
    );
    assert.equal(f.state.schedules, 0);
  });
  it('expired receipt goes to review without ingestion or queueing', async () => {
    const f = fixture();
    f.state.receipt.receivedAt = new Date(NOW.getTime() - 86400_000);
    await f.run();
    assert.equal(f.state.receipt.lastError, 'receipt_expired');
    assert.equal(f.state.messages.length, 1);
  });
  it('late callback saves context without regressing last activity or answering obsolete input', async () => {
    const f = fixture();
    const newer = new Date(NOW.getTime() + 30_000);
    f.state.conversation.lastMessageAt = newer;
    f.state.messages.push({
      id: 'newer',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'another question',
      timestamp: newer,
      deletedAt: null
    });
    await f.run();
    assert.equal(f.state.conversation.lastMessageAt, newer);
    assert.equal(f.state.receipt.lastError, 'newer_conversation_activity');
    assert.equal(f.state.schedules, 0);
  });
  it('lost lease during external identity lookup prevents all context writes', async () => {
    const f = fixture();
    f.state.lead.platformUserId = '1234';
    f.deps.resolveRecipient = async () => {
      f.state.receipt.leaseToken = 'new-owner';
      return '123456789012345';
    };
    const result = await f.run();
    assert.equal(result.leaseLost, 1);
    assert.equal(f.state.messages.length, 1);
    assert.equal(f.state.schedules, 0);
  });
  it('unavailable identity lookup leaves durable intake retryable without state mutation', async () => {
    const f = fixture();
    f.state.lead.platformUserId = '1234';
    f.deps.resolveRecipient = async () => {
      throw new Error('lookup timeout');
    };
    await f.run();
    assert.equal(f.state.receipt.status, 'RETRY');
    assert.equal(f.state.messages.length, 1);
    assert.equal(f.state.schedules, 0);
  });
  it('an in-flight job is deferred, not duplicated', async () => {
    const f = fixture();
    f.state.jobs.push({
      id: 'busy',
      conversationId: 'c1',
      status: 'PROCESSING',
      createdAt: NOW
    });
    await f.run();
    assert.equal(f.state.receipt.status, 'RETRY');
    assert.equal(f.state.schedules, 0);
  });
  it('notification failure cannot commit a silent terminal result and recovery alerts once', async () => {
    const f = fixture();
    f.state.conversation.awaitingHumanReview = true;
    f.state.failNotification = true;
    await f.run();
    assert.equal(f.state.receipt.status, 'RETRY');
    assert.equal(f.state.notifications.length, 0);
    assert.equal(f.state.schedules, 0);
    f.state.failNotification = false;
    f.state.receipt.nextAttemptAt = NOW;
    await f.run();
    assert.equal(f.state.receipt.status, 'HELD');
    assert.equal(f.state.notifications.length, 1);
    assert.ok(f.state.notificationInTransaction >= 2);
    assert.match(f.state.notifications[0].body, /conversation c1/);
    await f.run();
    assert.equal(f.state.notifications.length, 1);
  });
  it('exhausted retry with notification outage retains a recoverable lease instead of terminal silence', async () => {
    const f = fixture();
    f.state.missingLead = true;
    f.state.receipt.attempts = 3;
    f.state.failNotification = true;
    await f.run();
    assert.equal(f.state.receipt.status, 'PROCESSING');
    assert.equal(f.state.receipt.leaseToken, 'lease-token');
    assert.ok(f.state.receipt.leaseUntil > NOW);
    assert.equal(f.state.notifications.length, 0);
  });
  it('native-owned input without a visible job waits for native scheduling, never schedules itself', async () => {
    const f = fixture();
    f.state.messages.push({
      id: 'native',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: NOW,
      deletedAt: null,
      platformMessageId: 'native-mid'
    });
    await f.run();
    assert.equal(f.state.receipt.nativeInboundOwned, true);
    assert.equal(f.state.receipt.status, 'RETRY');
    assert.equal(f.state.schedules, 0);
    f.state.jobs.push({
      id: 'later-native-job',
      conversationId: 'c1',
      status: 'PENDING',
      createdAt: NOW
    });
    f.state.receipt.nextAttemptAt = NOW;
    await f.run();
    assert.equal(f.state.receipt.status, 'QUEUED');
    assert.equal(f.state.receipt.scheduledReplyId, 'later-native-job');
    assert.equal(f.state.schedules, 0);
  });
  it('native scheduling never appearing becomes visible review after bounded checks', async () => {
    const f = fixture();
    f.state.receipt.attempts = 3;
    f.state.messages.push({
      id: 'native',
      conversationId: 'c1',
      sender: 'LEAD',
      content: 'Starting',
      timestamp: NOW,
      deletedAt: null,
      platformMessageId: 'native-mid'
    });
    await f.run();
    assert.equal(f.state.receipt.status, 'NEEDS_REVIEW');
    assert.equal(f.state.notifications.length, 1);
    assert.equal(f.state.schedules, 0);
  });
});
