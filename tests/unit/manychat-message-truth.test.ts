import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import * as manyChatContact from '../../src/lib/manychat-contact';
import * as manyChatEchoClassifier from '../../src/lib/manychat-echo-classifier';
import * as scheduledReplyOutcome from '../../src/lib/scheduled-reply-outcome';

type Row = Record<string, any>;

const TEST_NOW = new Date('2026-09-18T18:02:00.000Z');

class FixedDate extends Date {
  constructor(value?: string | number | Date) {
    super(value === undefined ? TEST_NOW.getTime() : value);
  }

  static now() {
    return TEST_NOW.getTime();
  }
}

function load(path: string, prisma: Row) {
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }
  ).outputText;
  const exports: Record<string, any> = {};
  runInNewContext(code, {
    exports,
    console,
    Date: FixedDate,
    require(name: string) {
      if (name === '@/lib/prisma') return { default: prisma };
      if (name === 'zod') return { z };
      if (name === '@/lib/manychat-resolve-ig-id')
        return { resolveAndUpgradeInstagramNumericId: async () => null };
      if (name === '@/lib/manychat-contact') return manyChatContact;
      if (name === '@/lib/manychat-echo-classifier')
        return manyChatEchoClassifier;
      if (name === '@/lib/scheduled-reply-outcome')
        return scheduledReplyOutcome;
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return exports;
}

function fixture(initialMessages: Row[] = [], initialJobs: Row[] = []) {
  const messages = structuredClone(initialMessages);
  const jobs = structuredClone(initialJobs);
  const notifications: Row[] = [];
  let locks = 0;
  let leadWhere: Row | null = null;
  let transactionTail: Promise<void> = Promise.resolve();
  const conversation = {
    id: 'conversation-1',
    source: 'MANYCHAT',
    lastMessageAt: new Date('2026-09-18T18:00:00Z'),
    awaitingAiResponse: false,
    awaitingSince: null as Date | null
  };
  const lead = {
    id: 'lead-1',
    platformUserId: '17840000000000000',
    conversation
  };
  function inWindow(value: Date, condition: Row) {
    return (
      (!condition.gte || value >= condition.gte) &&
      (!condition.lte || value <= condition.lte)
    );
  }
  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR')
        return (value as Row[]).some((candidate) => matches(row, candidate));
      if (key === 'timestamp') return inWindow(row.timestamp, value as Row);
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        if ('not' in value) return row[key] !== value.not;
        if ('in' in value) return value.in.includes(row[key]);
        if ('lt' in value) return row[key] < value.lt;
        if ('lte' in value) return row[key] <= value.lte;
      }
      return row[key] === value;
    });
  }
  const tx: Row = {
    async $executeRaw() {
      locks++;
      return 1;
    },
    message: {
      async findFirst({ where, orderBy }: Row) {
        const rows = messages.filter((row) => matches(row, where));
        const ordering = Array.isArray(orderBy)
          ? orderBy
          : orderBy
            ? [orderBy]
            : [];
        rows.sort((a, b) => {
          for (const clause of ordering) {
            const [key, direction] = Object.entries(clause)[0] as [
              string,
              string
            ];
            if (a[key] === b[key]) continue;
            return (a[key] > b[key] ? 1 : -1) * (direction === 'desc' ? -1 : 1);
          }
          return 0;
        });
        return rows[0] ?? null;
      },
      async findMany({ where, orderBy }: Row) {
        const rows = messages.filter((row) => matches(row, where));
        if (orderBy?.timestamp === 'desc')
          rows.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return rows;
      },
      async update({ where, data }: Row) {
        const row = messages.find((candidate) => candidate.id === where.id);
        assert.ok(row);
        Object.assign(row, data);
        return row;
      },
      async create({ data }: Row) {
        const row = {
          id: `message-${messages.length + 1}`,
          deletedAt: null,
          platformMessageId: null,
          providerMessageId: null,
          deliveryStatus: null,
          deliveryReportedAt: null,
          deliveryConfirmedAt: null,
          echoAttributionPendingUntil: null,
          echoAttributionFinalizedAt: null,
          ...data
        };
        messages.push(row);
        return row;
      }
    },
    conversation: {
      async updateMany({ where, data }: Row) {
        if (matches(conversation, where)) {
          Object.assign(conversation, data);
          return { count: 1 };
        }
        return { count: 0 };
      }
    },
    scheduledReply: {
      async updateMany({ where, data }: Row) {
        let count = 0;
        for (const job of jobs) {
          if (!matches(job, where)) continue;
          Object.assign(job, data);
          count++;
        }
        return { count };
      }
    },
    notification: {
      async upsert({ where, create }: Row) {
        const existing = notifications.find((row) => row.id === where.id);
        if (existing) return existing;
        notifications.push(create);
        return create;
      }
    }
  };
  const prisma: Row = {
    account: {
      async findUnique() {
        return { id: 'account-1' };
      }
    },
    lead: {
      async findMany({ where }: Row) {
        leadWhere = where;
        return [lead];
      }
    },
    async $transaction(fn: (client: Row) => Promise<unknown>) {
      const predecessor = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        return await fn(tx);
      } finally {
        release();
      }
    }
  };
  return {
    prisma,
    messages,
    jobs,
    notifications,
    conversation,
    get locks() {
      return locks;
    },
    get leadWhere() {
      return leadWhere;
    }
  };
}

const payload = {
  instagramUserId: '17840000000000000',
  instagramUsername: 'test.contact',
  manyChatSubscriberId: 'subscriber-1',
  messageText: 'Are you starting?',
  sentAt: '2026-09-18T18:01:00.000Z',
  manyChatMessageId: 'manychat-operation-1'
};

test('ManyChat post-send callback records provider evidence without claiming a Meta mid', async () => {
  const f = fixture();
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  const result = await process({ webhookKey: 'key', payload });
  assert.equal(result.duplicate, false);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].providerMessageId, 'manychat-operation-1');
  assert.equal(f.messages[0].platformMessageId, null);
  assert.equal(f.messages[0].deliveryStatus, 'PROVIDER_REPORTED');
  assert.ok(f.messages[0].deliveryReportedAt instanceof Date);
  assert.equal(f.messages[0].msgSource, 'MANYCHAT_FLOW');
  assert.equal(f.locks, 1);
});

test('provider retry reuses one row and remains provider-reported', async () => {
  const f = fixture();
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({ webhookKey: 'key', payload });
  const retry = await process({ webhookKey: 'key', payload });
  assert.equal(retry.duplicate, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].platformMessageId, null);
  assert.equal(f.messages[0].deliveryStatus, 'PROVIDER_REPORTED');
});

test('legacy ManyChat platform id is not reinterpreted as Meta confirmation', async () => {
  const sentAt = new Date(payload.sentAt);
  const f = fixture([
    {
      id: 'legacy-provider-row',
      conversationId: 'conversation-1',
      sender: 'MANYCHAT',
      content: payload.messageText,
      timestamp: sentAt,
      deletedAt: null,
      // Before providerMessageId existed, /manychat-message put a provider id
      // here. Its presence is therefore not native Meta proof.
      platformMessageId: 'legacy-manychat-provider-id',
      providerMessageId: null,
      deliveryStatus: null,
      deliveryReportedAt: null,
      deliveryConfirmedAt: null
    }
  ]);
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({ webhookKey: 'key', payload });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].deliveryStatus, 'PROVIDER_REPORTED');
  assert.equal(f.messages[0].deliveryConfirmedAt, null);
});

test('Facebook post-send callback resolves the Facebook lead by PSID or subscriber id', async () => {
  const f = fixture();
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({
    webhookKey: 'key',
    payload: {
      platform: 'facebook',
      facebookUserId: 'facebook-psid',
      manyChatSubscriberId: 'manychat-subscriber',
      messageText: 'Are you starting?',
      manyChatMessageId: 'facebook-provider-operation'
    }
  });
  assert.equal(f.leadWhere?.platform, 'FACEBOOK');
  assert.equal(
    ((f.leadWhere?.OR ?? []) as Row[])
      .map((candidate) => candidate.platformUserId)
      .join(','),
    'facebook-psid,manychat-subscriber'
  );
  assert.equal(f.messages[0].providerMessageId, 'facebook-provider-operation');
  assert.equal(f.messages[0].deliveryStatus, 'PROVIDER_REPORTED');
});

test('provider callback rejects conflicting identities instead of selecting an arbitrary lead', async () => {
  const f = fixture();
  f.prisma.lead.findMany = async () => [
    {
      id: 'lead-a',
      platformUserId: 'facebook-psid',
      conversation: { id: 'conversation-a', source: 'MANYCHAT' }
    },
    {
      id: 'lead-b',
      platformUserId: 'manychat-subscriber',
      conversation: { id: 'conversation-b', source: 'MANYCHAT' }
    }
  ];
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await assert.rejects(
    process({
      webhookKey: 'key',
      payload: {
        platform: 'facebook',
        facebookUserId: 'facebook-psid',
        manyChatSubscriberId: 'manychat-subscriber',
        messageText: 'Are you starting?'
      }
    }),
    (error: any) =>
      error.status === 409 && error.message === 'contact_identity_conflict'
  );
  assert.equal(f.messages.length, 0);
});

test('provider callback enriches an echo-first row without downgrading Meta confirmation', async () => {
  const sentAt = new Date(payload.sentAt);
  const f = fixture([
    {
      id: 'echo-first',
      conversationId: 'conversation-1',
      sender: 'MANYCHAT',
      content: payload.messageText,
      timestamp: sentAt,
      deletedAt: null,
      platformMessageId: 'meta-mid-1',
      providerMessageId: null,
      deliveryStatus: 'META_CONFIRMED',
      deliveryReportedAt: null,
      deliveryConfirmedAt: sentAt
    }
  ]);
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  const result = await process({ webhookKey: 'key', payload });
  assert.equal(result.duplicate, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].providerMessageId, 'manychat-operation-1');
  assert.equal(f.messages[0].platformMessageId, 'meta-mid-1');
  assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
});

test('provider callback reclassifies an exact native HUMAN echo instead of creating a second bubble', async () => {
  const sentAt = new Date(payload.sentAt);
  const f = fixture([
    {
      id: 'conservative-human-echo',
      conversationId: 'conversation-1',
      sender: 'HUMAN',
      content: payload.messageText,
      timestamp: sentAt,
      deletedAt: null,
      platformMessageId: 'meta-mid-human-first',
      providerMessageId: null,
      deliveryStatus: null,
      deliveryReportedAt: null,
      deliveryConfirmedAt: null,
      humanSource: 'PHONE',
      sentByUserId: null,
      isHumanOverride: true,
      rejectedAISuggestionId: 'suggestion-1',
      editedFromSuggestion: true,
      humanOverrideNote: 'incorrect provisional classification',
      loggedDuringTrainingPhase: true,
      msgSource: 'HUMAN_OVERRIDE'
    }
  ]);
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  const result = await process({ webhookKey: 'key', payload });
  assert.equal(result.duplicate, true);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].sender, 'MANYCHAT');
  assert.equal(f.messages[0].providerMessageId, 'manychat-operation-1');
  assert.equal(f.messages[0].platformMessageId, 'meta-mid-human-first');
  assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
  assert.equal(f.messages[0].humanSource, null);
  assert.equal(f.messages[0].isHumanOverride, false);
  assert.equal(f.messages[0].rejectedAISuggestionId, null);
  assert.equal(f.messages[0].msgSource, 'MANYCHAT_FLOW');
});

test('a current ManyChat automation step cancels older pending AI work', async () => {
  const f = fixture(
    [],
    [
      {
        id: 'pending-before-manychat',
        conversationId: 'conversation-1',
        status: 'PENDING',
        createdAt: new Date('2020-01-01T00:00:00Z')
      }
    ]
  );
  f.conversation.awaitingAiResponse = true;
  f.conversation.awaitingSince = new Date('2026-09-18T18:00:00Z');
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({ webhookKey: 'key', payload });
  assert.equal(f.jobs[0].status, 'CANCELLED');
  assert.equal(f.conversation.awaitingAiResponse, false);
  assert.equal(f.conversation.awaitingSince, null);
});

test('a delayed callback for an older ManyChat step does not cancel a newer lead reply', async () => {
  const newerLeadAt = new Date('2026-09-18T18:02:00Z');
  const f = fixture(
    [
      {
        id: 'newer-lead',
        conversationId: 'conversation-1',
        sender: 'LEAD',
        content: 'I am ready',
        timestamp: newerLeadAt,
        deletedAt: null
      }
    ],
    [
      {
        id: 'pending-for-newer-lead',
        conversationId: 'conversation-1',
        status: 'PENDING',
        createdAt: new Date('2026-09-18T18:02:01Z')
      }
    ]
  );
  f.conversation.lastMessageAt = newerLeadAt;
  f.conversation.awaitingAiResponse = true;
  f.conversation.awaitingSince = newerLeadAt;
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({ webhookKey: 'key', payload });
  assert.equal(f.jobs[0].status, 'PENDING');
  assert.equal(f.conversation.awaitingAiResponse, true);
  assert.equal(f.conversation.awaitingSince, newerLeadAt);
});

test('native Meta echo upgrades the provider row instead of inserting a duplicate', async () => {
  const reportedAt = new Date('2026-09-18T18:01:00Z');
  const f = fixture([
    {
      id: 'provider-row',
      conversationId: 'conversation-1',
      sender: 'MANYCHAT',
      content: payload.messageText,
      timestamp: reportedAt,
      deletedAt: null,
      platformMessageId: null,
      providerMessageId: 'manychat-operation-1',
      deliveryStatus: 'PROVIDER_REPORTED',
      deliveryReportedAt: reportedAt,
      deliveryConfirmedAt: null,
      deliveryFailedAt: null,
      deliveryErrorCode: null
    }
  ]);
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const confirmedAt = new Date('2026-09-18T18:02:00Z');
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: ` ${payload.messageText} `,
    platformMessageId: 'meta-mid-1',
    classifyAsManyChat: true,
    receivedAt: confirmedAt
  });
  assert.equal(result.message.id, 'provider-row');
  assert.equal(result.disposition, 'RECONCILED');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].platformMessageId, 'meta-mid-1');
  assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
  assert.equal(f.messages[0].deliveryConfirmedAt, confirmedAt);
  assert.equal(f.locks, 1);
});

test('native Meta opener evidence persists one confirmed ManyChat flow row', async () => {
  const f = fixture();
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const confirmedAt = new Date('2026-09-18T18:02:00Z');
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: payload.messageText,
    platformMessageId: 'meta-native-opener',
    classifyAsManyChat: true,
    receivedAt: confirmedAt
  });

  assert.equal(result.disposition, 'CREATED');
  assert.equal(result.classification, 'MANYCHAT');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].sender, 'MANYCHAT');
  assert.equal(f.messages[0].msgSource, 'MANYCHAT_FLOW');
  assert.equal(f.messages[0].platformMessageId, 'meta-native-opener');
  assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
  assert.equal(f.messages[0].deliveryConfirmedAt, confirmedAt);
});

test('confirmed opener backfill repairs an older AI-attributed row in place', async () => {
  const originalTimestamp = new Date('2026-09-18T18:01:00Z');
  const f = fixture([
    {
      id: 'old-backfill-row',
      conversationId: 'conversation-1',
      sender: 'AI',
      content: payload.messageText,
      timestamp: originalTimestamp,
      deletedAt: null,
      platformMessageId: 'meta-native-opener',
      providerMessageId: null,
      deliveryStatus: null,
      deliveryConfirmedAt: null,
      deliveryFailedAt: null,
      deliveryErrorCode: null,
      msgSource: 'UNKNOWN'
    }
  ]);
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const confirmedAt = new Date('2026-09-18T18:02:00Z');
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: payload.messageText,
    platformMessageId: 'meta-native-opener',
    classifyAsManyChat: true,
    receivedAt: confirmedAt
  });

  assert.equal(result.disposition, 'RECONCILED');
  assert.equal(result.classification, 'MANYCHAT');
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].sender, 'MANYCHAT');
  assert.equal(f.messages[0].msgSource, 'MANYCHAT_FLOW');
  assert.equal(f.messages[0].platformMessageId, 'meta-native-opener');
  assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
  assert.equal(f.messages[0].deliveryConfirmedAt, confirmedAt);
});

test('unknown native echo is durable and source-pending until provider correlation', async () => {
  const f = fixture();
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const receivedAt = new Date('2026-09-18T18:02:00Z');
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: 'an unrecognized automation step',
    platformMessageId: 'meta-provisional-mid',
    classifyAsManyChat: false,
    deferHumanAttribution: true,
    receivedAt
  });
  assert.equal(result.classification, 'HUMAN');
  assert.equal(result.message.msgSource, 'UNKNOWN');
  assert.equal(
    result.message.echoAttributionPendingUntil.getTime(),
    receivedAt.getTime() + 2 * 60 * 1000
  );
  assert.equal(result.message.echoAttributionFinalizedAt, null);
});

test('ordinary native human echo is durable and due immediately for atomic finalization', async () => {
  const f = fixture();
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const receivedAt = new Date('2026-09-18T18:02:00Z');
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: 'a genuine operator reply',
    platformMessageId: 'meta-human-mid',
    classifyAsManyChat: false,
    deferHumanAttribution: false,
    receivedAt
  });
  assert.equal(result.classification, 'HUMAN');
  assert.equal(result.message.msgSource, 'UNKNOWN');
  assert.equal(result.message.echoAttributionPendingUntil, receivedAt);
  assert.equal(result.message.echoAttributionFinalizedAt, null);
});

test('provider callback resolves a provisional echo as ManyChat under the shared row', async () => {
  const sentAt = new Date(payload.sentAt);
  const pendingUntil = new Date(sentAt.getTime() + 2 * 60 * 1000);
  const f = fixture([
    {
      id: 'provisional-echo',
      conversationId: 'conversation-1',
      sender: 'HUMAN',
      content: payload.messageText,
      timestamp: sentAt,
      deletedAt: null,
      platformMessageId: 'meta-provisional-mid',
      providerMessageId: null,
      deliveryStatus: 'META_CONFIRMED',
      deliveryReportedAt: null,
      deliveryConfirmedAt: sentAt,
      echoAttributionPendingUntil: pendingUntil,
      echoAttributionFinalizedAt: null,
      humanSource: 'PHONE',
      msgSource: 'UNKNOWN'
    }
  ]);
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await process({ webhookKey: 'key', payload });
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].sender, 'MANYCHAT');
  assert.equal(f.messages[0].providerMessageId, payload.manyChatMessageId);
  assert.equal(f.messages[0].echoAttributionPendingUntil, null);
  assert.ok(f.messages[0].echoAttributionFinalizedAt instanceof Date);
  assert.equal(f.messages[0].msgSource, 'MANYCHAT_FLOW');
});

test('late provider callback cannot relabel a finalized immediate human echo', async () => {
  const sentAt = new Date(payload.sentAt);
  const f = fixture([
    {
      id: 'finalized-human-echo',
      conversationId: 'conversation-1',
      sender: 'HUMAN',
      content: payload.messageText,
      timestamp: sentAt,
      deletedAt: null,
      platformMessageId: 'meta-finalized-human-mid',
      providerMessageId: null,
      deliveryStatus: 'META_CONFIRMED',
      deliveryConfirmedAt: sentAt,
      echoAttributionPendingUntil: null,
      echoAttributionFinalizedAt: new Date(sentAt.getTime() + 3 * 60 * 1000),
      humanSource: 'PHONE',
      msgSource: 'HUMAN_OVERRIDE'
    }
  ]);
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      process({ webhookKey: 'key', payload }),
      /echo_attribution_already_finalized/
    );
  }
  assert.equal(f.messages[0].sender, 'HUMAN');
  assert.equal(f.messages[0].providerMessageId, null);
  assert.equal(f.notifications.length, 1);
  assert.equal(
    f.notifications[0].id,
    'manychat-late-provider-finalized-human-echo'
  );
  assert.match(f.notifications[0].body, /conversation-1/);
  assert.match(f.notifications[0].body, /finalized-human-echo/);
  assert.match(f.notifications[0].body, /manychat-operation-1/);
  assert.doesNotMatch(f.notifications[0].body, /Are you starting\?/);
  assert.doesNotMatch(f.notifications[0].body, /\bkey\b/);
});

test('provider callback rejects an unreasonable future sentAt before conversation work', async () => {
  const f = fixture();
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await assert.rejects(
    process({
      webhookKey: 'key',
      payload: {
        ...payload,
        sentAt: new Date(TEST_NOW.getTime() + 5 * 60 * 1000 + 1).toISOString()
      }
    }),
    (error: any) =>
      error.status === 400 && error.message === 'sent_at_out_of_range'
  );
  assert.equal(f.leadWhere, null);
  assert.equal(f.messages.length, 0);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.locks, 0);
});

test('provider callback rejects an unreasonably stale sentAt before conversation work', async () => {
  const f = fixture();
  const process = load(
    'src/lib/manychat-message.ts',
    f.prisma
  ).processManyChatMessage;
  await assert.rejects(
    process({
      webhookKey: 'key',
      payload: {
        ...payload,
        sentAt: new Date(
          TEST_NOW.getTime() - 24 * 60 * 60 * 1000 - 1
        ).toISOString()
      }
    }),
    (error: any) =>
      error.status === 400 && error.message === 'sent_at_out_of_range'
  );
  assert.equal(f.leadWhere, null);
  assert.equal(f.messages.length, 0);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.locks, 0);
});

test('content-only admin event cannot promote provider evidence to Meta confirmed', async () => {
  const reportedAt = new Date('2026-09-18T18:01:00Z');
  const f = fixture([
    {
      id: 'provider-row-no-native-mid',
      conversationId: 'conversation-1',
      sender: 'MANYCHAT',
      content: payload.messageText,
      timestamp: reportedAt,
      deletedAt: null,
      platformMessageId: null,
      providerMessageId: 'manychat-operation-1',
      deliveryStatus: 'PROVIDER_REPORTED',
      deliveryReportedAt: reportedAt,
      deliveryConfirmedAt: null
    }
  ]);
  const persistEcho = load(
    'src/lib/manychat-delivery-evidence.ts',
    f.prisma
  ).persistMetaEchoWithManyChatReconciliation;
  const result = await persistEcho({
    conversationId: 'conversation-1',
    messageText: payload.messageText,
    classifyAsManyChat: true,
    receivedAt: new Date('2026-09-18T18:02:00Z')
  });
  assert.equal(result.disposition, 'EXISTING');
  assert.equal(f.messages[0].deliveryStatus, 'PROVIDER_REPORTED');
  assert.equal(f.messages[0].deliveryConfirmedAt, null);
});

test('concurrent echo-first and provider-first arrivals converge on one confirmed row', async () => {
  for (const echoFirst of [true, false]) {
    const f = fixture();
    const processProvider = load(
      'src/lib/manychat-message.ts',
      f.prisma
    ).processManyChatMessage;
    const persistEcho = load(
      'src/lib/manychat-delivery-evidence.ts',
      f.prisma
    ).persistMetaEchoWithManyChatReconciliation;
    const provider = () => processProvider({ webhookKey: 'key', payload });
    const echo = () =>
      persistEcho({
        conversationId: 'conversation-1',
        messageText: payload.messageText,
        platformMessageId: 'meta-race-mid',
        classifyAsManyChat: false,
        receivedAt: new Date('2026-09-18T18:02:00Z')
      });
    await Promise.all(echoFirst ? [echo(), provider()] : [provider(), echo()]);
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].sender, 'MANYCHAT');
    assert.equal(f.messages[0].providerMessageId, 'manychat-operation-1');
    assert.equal(f.messages[0].platformMessageId, 'meta-race-mid');
    assert.equal(f.messages[0].deliveryStatus, 'META_CONFIRMED');
    assert.equal(f.locks, 2);
  }
});

test('context handoff source contains no opener Message writer', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/lib/manychat-handoff.ts'),
    'utf8'
  );
  assert.doesNotMatch(source, /ensureOpenerMessage/);
  assert.doesNotMatch(
    source,
    /sender:\s*['"]MANYCHAT['"][\s\S]{0,300}manychat-automation/
  );
});
