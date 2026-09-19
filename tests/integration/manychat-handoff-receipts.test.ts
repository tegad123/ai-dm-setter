import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import prisma from '../../src/lib/prisma';
import { POST } from '../../src/app/api/webhooks/manychat-handoff/route';
import { GET as cron } from '../../src/app/api/cron/process-manychat-handoffs/route';
import { createManyChatHandoffReceiptWorker } from '../../src/lib/manychat-handoff-worker';
import { queueManyChatFirstReply } from '../../src/lib/manychat-handoff-queue';
import { persistManyChatNativeInbound } from '../../src/lib/manychat-inbound-reconciliation';
import { processIncomingMessage } from '../../src/lib/webhook-processor';

// Never run fixtures against a connected client database, even accidentally.
const url = new URL(process.env.DATABASE_URL || 'postgresql://invalid/invalid');
assert.ok(
  ['127.0.0.1', 'localhost'].includes(url.hostname),
  'isolated local PostgreSQL required'
);
assert.equal(process.env.MANYCHAT_LOCAL_INTEGRATION_TEST, 'true');
const accountIds: string[] = [];
const opener = 'Thanks for following! Are you starting or already trading?';
const firstReply = 'I am just starting';

before(async () => {
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "ScheduledReply_one_pending_per_conversation" ON "ScheduledReply" ("conversationId") WHERE status = 'PENDING'`
  );
});
after(async () => {
  await prisma.scheduledReply.deleteMany({
    where: { accountId: { in: accountIds } }
  });
  await prisma.manyChatHandoffReceipt.deleteMany({
    where: { accountId: { in: accountIds } }
  });
  await prisma.conversation.deleteMany({
    where: { lead: { accountId: { in: accountIds } } }
  });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

async function fixture(platform: 'INSTAGRAM' | 'FACEBOOK' = 'INSTAGRAM') {
  const id = randomUUID();
  const account = await prisma.account.create({
    data: {
      name: 'Local handoff test',
      slug: `local-handoff-${id}`,
      awayModeInstagram: true,
      awayModeFacebook: true,
      responseDelayMin: 45,
      responseDelayMax: 45
    }
  });
  accountIds.push(account.id);
  const persona = await prisma.aIPersona.create({
    data: {
      accountId: account.id,
      personaName: 'Test',
      fullName: 'Test',
      systemPrompt: 'Test only'
    }
  });
  const isFacebook = platform === 'FACEBOOK';
  const platformUserId = isFacebook ? '27000000000000001' : '915133958000000';
  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: 'Test',
      handle: `test-${id}`,
      platform,
      platformUserId,
      triggerType: 'DM',
      conversation: {
        create: {
          personaId: persona.id,
          aiActive: true,
          source: 'MANYCHAT',
          manyChatOpenerMessage: opener,
          manyChatFiredAt: new Date(Date.now() - 60_000)
        }
      }
    },
    include: { conversation: true }
  });
  const payload = {
    processingMode: 'queued_first_reply',
    platform: platform.toLowerCase(),
    instagramUserId: isFacebook ? '' : '322000000',
    instagramUsername: isFacebook ? '' : lead.handle,
    facebookUserId: isFacebook ? platformUserId : undefined,
    contactName: isFacebook ? 'Local Facebook test' : undefined,
    manyChatSubscriberId: isFacebook ? platformUserId : '322000000',
    openerMessage: opener,
    triggerType: 'new_follower',
    leadResponseText: firstReply,
    scheduleAi: true
  };
  return { account, lead, conversationId: lead.conversation!.id, payload };
}

async function accept(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides = {},
  key = f.account.manyChatWebhookKey
) {
  return POST(
    new NextRequest('http://localhost/api/webhooks/manychat-handoff', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-QualifyDMs-Key': key },
      body: JSON.stringify({ ...f.payload, ...overrides })
    })
  );
}

function worker(schedule = queueManyChatFirstReply) {
  return createManyChatHandoffReceiptWorker({
    db: prisma,
    now: () => new Date(),
    token: randomUUID,
    resolveRecipient: async () => {
      throw new Error('known recipient must not make an external lookup');
    },
    schedule
  });
}

test('Facebook first reply never adopts an unrelated same-name unresolved contact', async () => {
  const f = await fixture('FACEBOOK');
  await prisma.lead.update({
    where: { id: f.lead.id },
    data: {
      platformUserId: 'unresolved-recipient',
      handle: f.payload.contactName
    }
  });
  const accepted = await accept(f);
  assert.equal(accepted.status, 200);
  const { receiptId } = await accepted.json();
  let schedules = 0;
  await worker(async () => {
    schedules++;
  })();
  const receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: receiptId }
  });
  assert.equal(receipt.status, 'RETRY');
  assert.equal(receipt.lastError, 'original_context_not_found');
  assert.equal(receipt.conversationId, null);
  assert.equal(schedules, 0);
  assert.equal(
    (await prisma.lead.findUniqueOrThrow({ where: { id: f.lead.id } }))
      .platformUserId,
    'unresolved-recipient'
  );
  assert.equal(
    await prisma.message.count({ where: { conversationId: f.conversationId } }),
    0
  );
});

test('real callback accepts once under concurrent retries, stores no key and does not schedule inline', async () => {
  const f = await fixture();
  const began = Date.now();
  const responses = await Promise.all(
    Array.from({ length: 6 }, () =>
      accept(f, { arbitrarySecret: 'must-not-persist' })
    )
  );
  for (const response of responses) assert.equal(response.status, 200);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(bodies.map((r) => r.receiptId)).size, 1);
  assert.ok(
    bodies.every((r) => r.handoffAccepted && r.processingStatus === 'PENDING')
  );
  assert.ok(
    Date.now() - began < 3000,
    'local acknowledgements should be below three seconds'
  );
  const receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: bodies[0].receiptId }
  });
  assert.ok(
    !JSON.stringify(receipt.payload).includes(f.account.manyChatWebhookKey)
  );
  assert.ok(!JSON.stringify(receipt.payload).includes('must-not-persist'));
  assert.equal(
    await prisma.scheduledReply.count({ where: { accountId: f.account.id } }),
    0
  );
  assert.equal(
    (await accept(f, { leadResponseText: 'Different answer' })).status,
    409
  );
  assert.equal((await accept(f, {}, 'wrong-key')).status, 401);
  assert.equal((await accept(f, { scheduleAi: false })).status, 400);
});

test('Facebook queued intake deduplicates, rejects conflicts and schedules through the Facebook conversation', async () => {
  const f = await fixture('FACEBOOK');
  const first = await accept(f);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.handoffAccepted, true);
  const duplicate = await accept(f);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).receiptId, body.receiptId);
  assert.equal(
    (await accept(f, { leadResponseText: 'Different Facebook answer' })).status,
    409
  );
  await worker()();
  const receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: body.receiptId }
  });
  assert.equal(receipt.platform, 'FACEBOOK');
  assert.equal(receipt.status, 'QUEUED');
  assert.equal(
    await prisma.scheduledReply.count({
      where: { conversationId: f.conversationId }
    }),
    1
  );
});

test('Facebook worker-owned first reply absorbs the later native MID without replacing its job', async () => {
  const f = await fixture('FACEBOOK');
  const nativeMid = `facebook-native-${randomUUID()}`;
  const body = await (await accept(f)).json();
  await worker()();

  const before = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: body.receiptId }
  });
  assert.equal(before.status, 'QUEUED');
  assert.ok(before.leadMessageId);
  assert.ok(before.scheduledReplyId);

  const result = await processIncomingMessage({
    accountId: f.account.id,
    platformUserId: f.lead.platformUserId!,
    platform: 'FACEBOOK',
    senderName: f.lead.name,
    senderHandle: f.lead.handle,
    messageText: firstReply,
    triggerType: 'DM',
    platformMessageId: nativeMid
  });
  assert.equal(result.skipReply, true);
  assert.equal(result.messageId, before.leadMessageId);

  const after = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: body.receiptId }
  });
  const leadMessages = await prisma.message.findMany({
    where: { conversationId: f.conversationId, sender: 'LEAD' }
  });
  const jobs = await prisma.scheduledReply.findMany({
    where: { conversationId: f.conversationId }
  });
  assert.equal(leadMessages.length, 1);
  assert.equal(leadMessages[0].id, after.leadMessageId);
  assert.equal(leadMessages[0].platformMessageId, nativeMid);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, after.scheduledReplyId);
  assert.equal(jobs[0].status, 'PENDING');
});

test('legacy context-only payload retains response shape and saves its context', async () => {
  const f = await fixture();
  const response = await accept(f, {
    processingMode: 'legacy',
    scheduleAi: false,
    instagramUserId: f.lead.platformUserId,
    leadResponseText: undefined
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.conversationId, f.conversationId);
  assert.equal(body.handoffAccepted, undefined);
  assert.equal(
    await prisma.manyChatHandoffReceipt.count({
      where: { accountId: f.account.id }
    }),
    0
  );
  assert.equal(
    await prisma.message.count({
      where: { conversationId: f.conversationId, sender: 'MANYCHAT' }
    }),
    0,
    'context-only handoff must not manufacture a sent opener'
  );
});

test('database failure returns an error without a successful handoff acknowledgement', async () => {
  const f = await fixture();
  const transaction = prisma.$transaction;
  prisma.$transaction = (() =>
    Promise.reject(
      new Error('simulated database outage')
    )) as typeof prisma.$transaction;
  try {
    const response = await accept(f);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).handoffAccepted, undefined);
  } finally {
    prisma.$transaction = transaction;
  }
  assert.equal(
    await prisma.manyChatHandoffReceipt.count({
      where: { accountId: f.account.id }
    }),
    0
  );
});

test('legacy Facebook context callback remains compatible', async () => {
  const f = await fixture();
  const response = await accept(f, {
    processingMode: 'legacy',
    platform: 'facebook',
    scheduleAi: false,
    instagramUserId: '',
    instagramUsername: '',
    facebookUserId: '27000000000000001',
    contactName: 'Local Facebook test',
    leadResponseText: undefined
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.handoffAccepted, undefined);
  assert.equal(
    await prisma.manyChatHandoffReceipt.count({
      where: { accountId: f.account.id }
    }),
    0
  );
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: body.conversationId },
    include: { lead: true }
  });
  assert.equal(conversation.lead.platform, 'FACEBOOK');
});

test('atomic concurrent worker claims schedule one first reply and late native copy reuses its message', async () => {
  const f = await fixture();
  const body = await (await accept(f)).json();
  const run = worker();
  await Promise.all([run(), run()]);
  const receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: body.receiptId }
  });
  assert.equal(receipt.status, 'QUEUED');
  assert.equal(
    await prisma.scheduledReply.count({
      where: { conversationId: f.conversationId }
    }),
    1
  );
  const native = await persistManyChatNativeInbound(
    f.account.id,
    f.conversationId,
    'INSTAGRAM',
    {
      conversationId: f.conversationId,
      sender: 'LEAD',
      content: firstReply,
      platformMessageId: `native-${randomUUID()}`,
      timestamp: new Date()
    }
  );
  assert.equal(native.reused, true);
  assert.equal(native.message.id, receipt.leadMessageId);
  assert.equal(
    await prisma.message.count({
      where: { conversationId: f.conversationId, sender: 'LEAD' }
    }),
    1
  );
});

test('native-first and simultaneous intake choose one scheduling owner and adopt native work', async () => {
  for (const mode of ['before', 'simultaneous'] as const) {
    const f = await fixture();
    const body = await (await accept(f)).json();
    const native = () =>
      persistManyChatNativeInbound(
        f.account.id,
        f.conversationId,
        'INSTAGRAM',
        {
          conversationId: f.conversationId,
          sender: 'LEAD',
          content: firstReply,
          platformMessageId: `native-${randomUUID()}`,
          timestamp: new Date()
        }
      );
    if (mode === 'before') {
      await native();
      await worker()();
    } else await Promise.all([native(), worker()()]);
    let receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
      where: { id: body.receiptId }
    });
    if (receipt.nativeInboundOwned) {
      assert.equal(receipt.status, 'RETRY');
      assert.equal(
        await prisma.scheduledReply.count({
          where: { conversationId: f.conversationId }
        }),
        0
      );
      // Model native scheduler's delayed enqueue after the worker's reconciliation.
      // Worker cannot create a competing job even while native has no row yet.
      await prisma.scheduledReply.create({
        data: {
          accountId: f.account.id,
          conversationId: f.conversationId,
          status: 'PENDING',
          scheduledFor: new Date(Date.now() + 60_000)
        }
      });
      await prisma.manyChatHandoffReceipt.update({
        where: { id: receipt.id },
        data: { nextAttemptAt: new Date(0) }
      });
      await worker()();
      receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
        where: { id: receipt.id }
      });
    }
    assert.equal(receipt.status, 'QUEUED');
    assert.equal(
      await prisma.lead.count({ where: { accountId: f.account.id } }),
      1
    );
    assert.equal(
      await prisma.message.count({
        where: { conversationId: f.conversationId, sender: 'LEAD' }
      }),
      1
    );
    assert.equal(
      await prisma.scheduledReply.count({
        where: { conversationId: f.conversationId }
      }),
      1
    );
  }
});

test('crash after durable enqueue is reconciled without another job', async () => {
  const f = await fixture();
  const body = await (await accept(f)).json();
  await worker(async (...args) => {
    await queueManyChatFirstReply(...args);
    throw new Error('simulated interruption after commit');
  })();
  const receipt = await prisma.manyChatHandoffReceipt.findUniqueOrThrow({
    where: { id: body.receiptId }
  });
  assert.equal(receipt.status, 'QUEUED');
  assert.equal(
    await prisma.scheduledReply.count({
      where: { conversationId: f.conversationId }
    }),
    1
  );
});

test('cron requires authentication and pause switch prevents intake and processing', async () => {
  assert.equal(
    (
      await cron(
        new NextRequest('http://localhost/api/cron/process-manychat-handoffs')
      )
    ).status,
    401
  );
  const f = await fixture();
  process.env.MANYCHAT_QUEUED_HANDOFF_PAUSED = 'true';
  try {
    assert.equal((await accept(f)).status, 503);
  } finally {
    delete process.env.MANYCHAT_QUEUED_HANDOFF_PAUSED;
  }
  assert.equal(
    await prisma.manyChatHandoffReceipt.count({
      where: { accountId: f.account.id }
    }),
    0
  );
  const intakeFailure = await prisma.notification.findFirstOrThrow({
    where: {
      accountId: f.account.id,
      title: 'ManyChat first-reply intake failed'
    },
    orderBy: { createdAt: 'desc' }
  });
  assert.match(intakeFailure.body ?? '', /Queued first-reply intake is paused/);
});

test('ambiguous native copy after outbound is preserved for review without another reply', async () => {
  const f = await fixture();
  await accept(f);
  await worker()();
  await prisma.message.create({
    data: {
      conversationId: f.conversationId,
      sender: 'AI',
      content: 'Local test answer',
      platformMessageId: `local-outbound-${randomUUID()}`
    }
  });
  const result = await persistManyChatNativeInbound(
    f.account.id,
    f.conversationId,
    'INSTAGRAM',
    {
      conversationId: f.conversationId,
      sender: 'LEAD',
      content: firstReply,
      platformMessageId: `local-late-native-${randomUUID()}`
    }
  );
  assert.equal(result.reused, false);
  assert.equal(result.skipReply, true);
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: f.conversationId }
  });
  assert.equal(conversation.awaitingHumanReview, true);
  assert.equal(
    await prisma.notification.count({ where: { accountId: f.account.id } }),
    1
  );
  assert.equal(
    await prisma.scheduledReply.count({
      where: { conversationId: f.conversationId }
    }),
    1
  );
});
