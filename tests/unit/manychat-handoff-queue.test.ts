import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const NOW = new Date('2026-09-18T18:00:00.000Z');
class FixedDate extends Date {
  constructor(value?: string | number | Date) {
    super(
      value === undefined
        ? NOW.getTime()
        : value instanceof Date
          ? value.getTime()
          : value
    );
  }
  static now() {
    return NOW.getTime();
  }
}

// Execute the actual functions; database/network/engine modules cannot load.
function loadModule(
  path: string,
  prisma: unknown,
  delay = (min: number) => min
) {
  const code = ts.transpileModule(
    readFileSync(resolve(process.cwd(), path), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }
  ).outputText;
  const exports: Record<string, Function> = {};
  runInNewContext(code, {
    exports,
    Date: FixedDate,
    require(name: string) {
      if (name === '@/lib/prisma') return { default: prisma };
      if (name === '@/lib/delay-utils') return { humanResponseDelay: delay };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  return exports;
}

type Row = Record<string, any>;
type State = Record<
  | 'manyChatHandoffReceipt'
  | 'conversation'
  | 'message'
  | 'messageGroup'
  | 'scheduledReply',
  Row[]
>;
function baseline(): State {
  return {
    manyChatHandoffReceipt: [
      {
        id: 'receipt',
        accountId: 'account',
        conversationId: 'conv',
        platform: 'INSTAGRAM',
        status: 'PROCESSING',
        leaseToken: 'worker-token',
        leaseUntil: new Date(NOW.getTime() + 60000),
        receivedAt: new Date(NOW.getTime() - 2000),
        leadMessageId: 'inbound',
        scheduledReplyId: null
      }
    ],
    conversation: [
      {
        id: 'conv',
        aiActive: true,
        awaitingHumanReview: false,
        distressDetected: false,
        schedulingConflict: false,
        autoSendOverride: false,
        awaitingAiResponse: false,
        awaitingSince: null,
        generationClaimAt: null,
        generationClaimMessageId: null,
        lead: {
          accountId: 'account',
          platform: 'INSTAGRAM',
          account: {
            awayModeInstagram: true,
            generateOnlyInstagram: false,
            awayModeFacebook: false,
            generateOnlyFacebook: false,
            responseDelayMin: 45,
            responseDelayMax: 120,
            debounceWindowSeconds: 45,
            maxDebounceWindowSeconds: 120
          }
        }
      }
    ],
    message: [
      {
        id: 'inbound',
        conversationId: 'conv',
        sender: 'LEAD',
        content: 'I am starting',
        timestamp: new Date(NOW.getTime() - 1000),
        platformMessageId: null,
        deletedAt: null
      }
    ],
    messageGroup: [],
    scheduledReply: []
  };
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (
      expected === null ||
      typeof expected !== 'object' ||
      expected instanceof Date
    )
      return actual === expected;
    if ('not' in expected) return actual !== expected.not;
    if ('in' in expected) return expected.in.includes(actual);
    if ('gt' in expected) return actual > expected.gt;
    if ('gte' in expected) return actual >= expected.gte;
    return matches(actual ?? {}, expected);
  });
}
function database(initial = baseline(), failOn?: string) {
  let state = structuredClone(initial);
  const writes: string[] = [];
  const locks: unknown[][] = [];
  const prisma = {
    async $transaction(run: (tx: any) => Promise<unknown>) {
      const draft = structuredClone(state);
      const tx: Record<string, unknown> = {
        async $executeRaw(
          _strings: TemplateStringsArray,
          ...values: unknown[]
        ) {
          locks.push(values);
          return 1;
        }
      };
      for (const table of Object.keys(draft) as (keyof State)[]) {
        const find = ({ where, orderBy }: Row) => {
          const rows = draft[table].filter((row) => matches(row, where));
          if (orderBy) {
            const [key, direction] = Object.entries(orderBy)[0];
            rows.sort(
              (a, b) =>
                (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) *
                (direction === 'desc' ? -1 : 1)
            );
          }
          return rows;
        };
        tx[table] = {
          async findFirst(args: Row) {
            return find(args)[0] ?? null;
          },
          async findMany(args: Row) {
            return find(args);
          },
          async create({ data }: Row) {
            writes.push(`${table}.create`);
            if (failOn === `${table}.create`)
              throw new Error('injected persistence failure');
            if (
              table === 'scheduledReply' &&
              draft.scheduledReply.some(
                (row) =>
                  row.id === data.id ||
                  (row.conversationId === data.conversationId &&
                    row.status === 'PENDING' &&
                    data.status === 'PENDING')
              )
            )
              throw Object.assign(new Error('unique constraint'), {
                code: 'P2002'
              });
            const row = {
              id: `created-${draft[table].length}`,
              createdAt: NOW,
              ...data
            };
            draft[table].push(row);
            return row;
          },
          async update({ where, data }: Row) {
            writes.push(`${table}.update`);
            if (failOn === `${table}.update`)
              throw new Error('injected persistence failure');
            const row = find({ where })[0];
            assert.ok(row, `Missing ${table} row`);
            Object.assign(row, data);
            return row;
          }
        };
      }
      const result = await run(tx);
      state = draft; // A throw discards all mutations, like a transaction rollback.
      return result;
    }
  };
  return { prisma, writes, locks, state: () => state };
}
function queue(db: ReturnType<typeof database>) {
  const fn = loadModule(
    'src/lib/manychat-handoff-queue.ts',
    db.prisma
  ).queueManyChatFirstReply;
  return (conversationId: string, accountId: string, receiptId: string) =>
    fn(conversationId, accountId, receiptId, 'worker-token');
}
function native(db: ReturnType<typeof database>) {
  return loadModule('src/lib/manychat-inbound-reconciliation.ts', db.prisma)
    .persistManyChatNativeInbound;
}
function job(id: string, status: string) {
  return {
    id,
    status,
    conversationId: 'conv',
    accountId: 'account',
    createdAt: NOW
  };
}

const timing = loadModule(
  'src/lib/manychat-handoff-queue.ts',
  {}
).firstReplyScheduledFor;
const timingArgs = {
  now: NOW,
  earliestLeadAt: NOW,
  minDelay: 45,
  maxDelay: 120,
  debounceSeconds: 45,
  maxDebounceSeconds: 120
};
test('response-delay floor is preserved independently of the debounce cap', () => {
  const result = timing(
    { ...timingArgs, minDelay: 600, maxDelay: 600 },
    () => 600
  );
  assert.equal(result.getTime(), NOW.getTime() + 608000);
});
test('an old batch caps debounce but retains the eight-second collection period', () => {
  const result = timing(
    {
      ...timingArgs,
      earliestLeadAt: new Date(NOW.getTime() - 180000),
      minDelay: 0,
      maxDelay: 0
    },
    () => 0
  );
  assert.equal(result.getTime(), NOW.getTime() + 9000);
});
test('a fresh batch keeps the configured debounce floor', () => {
  assert.equal(
    timing(
      { ...timingArgs, minDelay: 0, maxDelay: 0, debounceSeconds: 60 },
      () => 0
    ).getTime(),
    NOW.getTime() + 68000
  );
});
test('normalizes invalid negative delay bounds before drawing the delay', () => {
  let seen: number[] = [];
  const result = timing(
    {
      ...timingArgs,
      minDelay: -4,
      maxDelay: -9,
      debounceSeconds: -2,
      maxDebounceSeconds: -3
    },
    (min: number, max: number) => {
      seen = [min, max];
      return min;
    }
  );
  assert.deepEqual(seen, [0, 0]);
  assert.equal(result.getTime(), NOW.getTime() + 9000);
});

for (const [label, change] of [
  [
    'paused AI',
    (s: State) => {
      s.conversation[0].aiActive = false;
    }
  ],
  [
    'human review',
    (s: State) => {
      s.conversation[0].awaitingHumanReview = true;
    }
  ],
  [
    'distress',
    (s: State) => {
      s.conversation[0].distressDetected = true;
    }
  ],
  [
    'scheduling conflict',
    (s: State) => {
      s.conversation[0].schedulingConflict = true;
    }
  ],
  [
    'generate-only despite override',
    (s: State) => {
      s.conversation[0].lead.account.generateOnlyInstagram = true;
      s.conversation[0].autoSendOverride = true;
    }
  ],
  [
    'away mode off without override',
    (s: State) => {
      s.conversation[0].lead.account.awayModeInstagram = false;
    }
  ]
] as const) {
  test(`does not mutate settings, context, or work for ${label}`, async () => {
    const state = baseline();
    change(state);
    const db = database(state);
    await assert.rejects(
      queue(db)('conv', 'account', 'receipt'),
      /HANDOFF_HELD/
    );
    assert.deepEqual(db.state(), state);
    assert.deepEqual(db.writes, []);
  });
}
test('an explicit operator override permits enqueueing while away mode is off without changing either', async () => {
  const state = baseline();
  state.conversation[0].lead.account.awayModeInstagram = false;
  state.conversation[0].autoSendOverride = true;
  const db = database(state);
  await queue(db)('conv', 'account', 'receipt');
  assert.equal(db.state().scheduledReply.length, 1);
  assert.equal(
    db.state().conversation[0].lead.account.awayModeInstagram,
    false
  );
  assert.equal(db.state().conversation[0].autoSendOverride, true);
});
test('Facebook receipt uses Facebook delivery flags and queues one reply', async () => {
  const state = baseline();
  state.manyChatHandoffReceipt[0].platform = 'FACEBOOK';
  state.conversation[0].lead.platform = 'FACEBOOK';
  state.conversation[0].lead.account.awayModeInstagram = false;
  state.conversation[0].lead.account.awayModeFacebook = true;
  const db = database(state);
  await queue(db)('conv', 'account', 'receipt');
  assert.equal(db.state().scheduledReply.length, 1);
  assert.equal(db.state().conversation[0].lead.platform, 'FACEBOOK');
});
test('Facebook generate-only holds first reply without mutating state', async () => {
  const state = baseline();
  state.manyChatHandoffReceipt[0].platform = 'FACEBOOK';
  state.conversation[0].lead.platform = 'FACEBOOK';
  state.conversation[0].lead.account.awayModeFacebook = true;
  state.conversation[0].lead.account.generateOnlyFacebook = true;
  const db = database(state);
  await assert.rejects(queue(db)('conv', 'account', 'receipt'), /HANDOFF_HELD/);
  assert.deepEqual(db.state(), state);
  assert.deepEqual(db.writes, []);
});
test('defers to a current native generation claim without canceling or clearing it', async () => {
  const state = baseline();
  state.conversation[0].generationClaimAt = new Date(NOW.getTime() - 30000);
  state.conversation[0].generationClaimMessageId = 'inbound';
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /HANDOFF_DEFERRED/
  );
  assert.deepEqual(db.state(), state);
  assert.deepEqual(db.writes, []);
});
test('defers when existing work is PROCESSING, even if another PENDING row exists', async () => {
  const state = baseline();
  state.scheduledReply = [
    job('processing', 'PROCESSING'),
    job('pending', 'PENDING')
  ];
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /HANDOFF_DEFERRED/
  );
  assert.deepEqual(db.state(), state);
  assert.deepEqual(db.writes, []);
});
test('adopts existing PENDING work rather than replacing it or redrawing its schedule', async () => {
  const state = baseline();
  state.scheduledReply = [
    {
      ...job('native-job', 'PENDING'),
      scheduledFor: new Date(NOW.getTime() + 60000)
    }
  ];
  const db = database(state);
  await queue(db)('conv', 'account', 'receipt');
  assert.deepEqual(db.state().scheduledReply, state.scheduledReply);
  assert.equal(
    db.state().manyChatHandoffReceipt[0].scheduledReplyId,
    'native-job'
  );
  assert.deepEqual(db.writes, ['manyChatHandoffReceipt.update']);
});
test('native-owned input cannot enqueue during a gap in native scheduling', async () => {
  const state = baseline();
  state.manyChatHandoffReceipt[0].nativeInboundOwned = true;
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /HANDOFF_DEFERRED/
  );
  assert.deepEqual(db.writes, []);
});
test('a later native MID does not steal worker-owned scheduling', async () => {
  const state = baseline();
  state.manyChatHandoffReceipt[0].nativeInboundOwned = false;
  state.message[0].platformMessageId = 'native-mid';
  const db = database(state);
  await queue(db)('conv', 'account', 'receipt');
  assert.equal(db.state().scheduledReply.length, 1);
});
for (const status of ['FAILED', 'FAILED_QUALITY_GATE', 'SENT']) {
  test(`does not replay ${status} work`, async () => {
    const state = baseline();
    state.scheduledReply = [job('old', status)];
    const db = database(state);
    await assert.rejects(
      queue(db)('conv', 'account', 'receipt'),
      /HANDOFF_REVIEW/
    );
    assert.deepEqual(db.writes, []);
  });
}
test('prior uncertain message-group delivery is held without enqueueing', async () => {
  const state = baseline();
  state.messageGroup = [
    { id: 'partial', conversationId: 'conv', completedAt: null }
  ];
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /prior or uncertain outbound/
  );
  assert.deepEqual(db.writes, []);
});
test('does not answer input already followed by a human response', async () => {
  const state = baseline();
  state.message.push({
    id: 'human',
    conversationId: 'conv',
    sender: 'HUMAN',
    timestamp: NOW,
    deletedAt: null
  });
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /no longer the latest input/
  );
  assert.deepEqual(db.writes, []);
});
test('rejects expired input and an expired worker lease before mutations', async () => {
  for (const expired of ['input', 'lease']) {
    const state = baseline();
    if (expired === 'input')
      state.message[0].timestamp = new Date(NOW.getTime() - 24 * 3600000);
    else state.manyChatHandoffReceipt[0].leaseUntil = NOW;
    const db = database(state);
    await assert.rejects(
      queue(db)('conv', 'account', 'receipt'),
      /HANDOFF_REVIEW/
    );
    assert.deepEqual(db.writes, []);
  }
});
test('new work and receipt link commit atomically under a contact lock', async () => {
  const db = database();
  await queue(db)('conv', 'account', 'receipt');
  const state = db.state();
  assert.equal(state.scheduledReply.length, 1);
  assert.equal(state.scheduledReply[0].id, 'manychat-first-receipt');
  assert.equal(state.scheduledReply[0].status, 'PENDING');
  assert.equal(state.scheduledReply[0].generatedResult, undefined);
  assert.equal(
    state.manyChatHandoffReceipt[0].scheduledReplyId,
    state.scheduledReply[0].id
  );
  assert.equal(state.conversation[0].awaitingAiResponse, true);
  assert.equal(
    state.conversation[0].awaitingSince.getTime(),
    state.message[0].timestamp.getTime()
  );
  assert.ok(db.locks.flat().includes('manychat-first-reply:conv'));
});
test('receipt-link failure rolls back newly created work; retry creates exactly one linked job', async () => {
  const initial = baseline();
  const db = database(initial, 'manyChatHandoffReceipt.update');
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /injected persistence failure/
  );
  assert.deepEqual(db.state(), initial);
  const retry = database(db.state());
  await queue(retry)('conv', 'account', 'receipt');
  assert.equal(retry.state().scheduledReply.length, 1);
  await queue(retry)('conv', 'account', 'receipt');
  assert.equal(retry.state().scheduledReply.length, 1);
});
test('a cancelled deterministic handoff job is reviewed instead of resurrected', async () => {
  const state = baseline();
  state.scheduledReply = [job('manychat-first-receipt', 'CANCELLED')];
  const db = database(state);
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /previous handoff work was cancelled/
  );
  assert.deepEqual(db.writes, []);
});

const nativeInput = {
  conversationId: 'conv',
  sender: 'LEAD',
  content: 'I am starting',
  timestamp: NOW,
  platformMessageId: 'meta-mid',
  deletedAt: null
};
test('native inbound attaches its Meta ID to the receipt-linked first input without duplicating content', async () => {
  const db = database();
  const result = await native(db)('account', 'conv', nativeInput);
  assert.equal(result.reused, true);
  assert.equal(result.message.id, 'inbound');
  assert.equal(db.state().message.length, 1);
  assert.equal(db.state().message[0].platformMessageId, 'meta-mid');
  assert.deepEqual(db.writes, ['message.update']);
  assert.ok(db.locks.flat().includes('manychat-first-reply:conv'));
});
for (const status of ['HELD', 'NEEDS_REVIEW']) {
  test(`native inbound still reuses the receipt-linked input after the worker ends ${status}`, async () => {
    const state = baseline();
    state.manyChatHandoffReceipt[0].status = status;
    state.manyChatHandoffReceipt[0].leaseToken = null;
    state.manyChatHandoffReceipt[0].leaseUntil = null;
    const db = database(state);
    const result = await native(db)('account', 'conv', nativeInput);
    assert.equal(result.reused, true);
    assert.equal(result.skipReply, true);
    assert.equal(result.message.id, 'inbound');
    assert.equal(db.state().message.length, 1);
    assert.equal(db.state().message[0].platformMessageId, 'meta-mid');
  });
}
test('native inbound with different text follows ordinary message creation', async () => {
  const db = database();
  const result = await native(db)('account', 'conv', {
    ...nativeInput,
    content: 'Also I live in Houston'
  });
  assert.equal(result.reused, false);
  assert.equal(db.state().message.length, 2);
  assert.equal(db.state().message[0].platformMessageId, null);
  assert.deepEqual(db.writes, ['message.create']);
});
test('reconciliation does not borrow a receipt belonging to another account', async () => {
  const db = database();
  const result = await native(db)('different-account', 'conv', nativeInput);
  assert.equal(result.reused, false);
  assert.deepEqual(db.writes, ['message.create']);
});
test('a later repeated phrase with a different Meta ID remains a new message', async () => {
  const state = baseline();
  state.message[0].platformMessageId = 'earlier-meta-mid';
  const db = database(state);
  const result = await native(db)('account', 'conv', nativeInput);
  assert.equal(result.reused, false);
  assert.equal(db.state().message.length, 2);
});
test('an old receipt cannot absorb a later native message merely because the text matches', async () => {
  const state = baseline();
  state.manyChatHandoffReceipt[0].receivedAt = new Date(
    NOW.getTime() - 6 * 60000
  );
  const db = database(state);
  const result = await native(db)('account', 'conv', nativeInput);
  assert.equal(result.reused, false);
  assert.deepEqual(db.writes, ['message.create']);
});

test('a worker that lost its lease token cannot enqueue or change another worker receipt', async () => {
  const db = database();
  const fn = loadModule(
    'src/lib/manychat-handoff-queue.ts',
    db.prisma
  ).queueManyChatFirstReply;
  await assert.rejects(
    fn('conv', 'account', 'receipt', 'stale-token'),
    /receipt lease or input missing/
  );
  assert.deepEqual(db.writes, []);
});
test('queue insertion failure leaves no acknowledgement link or awaiting flag', async () => {
  const state = baseline();
  const db = database(state, 'scheduledReply.create');
  await assert.rejects(
    queue(db)('conv', 'account', 'receipt'),
    /injected persistence failure/
  );
  assert.deepEqual(db.state(), state);
});
