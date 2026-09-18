import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  manyChatCompleteSchema,
  processManyChatComplete
} from '../../src/lib/manychat-complete';
import {
  manyChatCompletionScheduledFor,
  queueManyChatCompletionReply
} from '../../src/lib/manychat-completion-queue';

const NOW = new Date('2026-09-18T20:00:00.000Z');
type Row = Record<string, any>;

function baseState() {
  const account = {
    id: 'account',
    manyChatWebhookKey: 'secret',
    awayModeInstagram: true,
    awayModeFacebook: true,
    generateOnlyInstagram: false,
    generateOnlyFacebook: false,
    responseDelayMin: 45,
    responseDelayMax: 120,
    debounceWindowSeconds: 45,
    maxDebounceWindowSeconds: 120
  };
  const lead = {
    id: 'lead',
    accountId: account.id,
    platform: 'FACEBOOK',
    platformUserId: 'fb-psid',
    account
  };
  const conversation = {
    id: 'conversation',
    lead,
    aiActive: true,
    awaitingHumanReview: false,
    distressDetected: false,
    schedulingConflict: false,
    autoSendOverride: false,
    awaitingAiResponse: false,
    awaitingSince: null,
    generationClaimAt: null,
    generationClaimMessageId: null
  };
  const messages: Row[] = [
    {
      id: 'lead-message',
      conversationId: conversation.id,
      sender: 'LEAD',
      content: 'I am ready',
      timestamp: new Date(NOW.getTime() - 1000),
      deletedAt: null
    }
  ];
  return {
    account,
    lead,
    conversation,
    messages,
    groups: [] as Row[],
    jobs: [] as Row[],
    writes: [] as string[],
    locks: 0
  };
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (
      expected === null ||
      expected instanceof Date ||
      typeof expected !== 'object'
    ) {
      return actual === expected;
    }
    if ('not' in expected) return actual !== expected.not;
    if ('in' in expected) return expected.in.includes(actual);
    if ('gt' in expected) return actual > expected.gt;
    if ('gte' in expected) return actual >= expected.gte;
    return matches(actual ?? {}, expected);
  });
}

function queueDb(state = baseState()) {
  const find = (rows: Row[], args: Row) => {
    const found = rows.filter((row) => matches(row, args.where));
    if (args.orderBy) {
      const [key, direction] = Object.entries(args.orderBy)[0] as [
        string,
        string
      ];
      found.sort(
        (a, b) =>
          (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) *
          (direction === 'desc' ? -1 : 1)
      );
    }
    return found;
  };
  const db: Row = {
    async $transaction(run: (tx: Row) => Promise<unknown>) {
      return run(db);
    },
    async $executeRaw() {
      state.locks++;
      return 1;
    },
    conversation: {
      async findFirst(args: Row) {
        return matches(state.conversation, args.where)
          ? state.conversation
          : null;
      },
      async update({ data }: Row) {
        state.writes.push('conversation.update');
        Object.assign(state.conversation, data);
        return state.conversation;
      }
    },
    message: {
      async findFirst(args: Row) {
        return find(state.messages, args)[0] ?? null;
      }
    },
    messageGroup: {
      async findFirst(args: Row) {
        return find(state.groups, args)[0] ?? null;
      }
    },
    scheduledReply: {
      async findMany(args: Row) {
        return find(state.jobs, args);
      },
      async findFirst(args: Row) {
        return find(state.jobs, args)[0] ?? null;
      },
      async create({ data }: Row) {
        state.writes.push('scheduledReply.create');
        if (
          state.jobs.some(
            (job) =>
              job.id === data.id ||
              (job.conversationId === data.conversationId &&
                job.status === 'PENDING')
          )
        ) {
          throw Object.assign(new Error('unique constraint'), {
            code: 'P2002'
          });
        }
        const row = { createdAt: NOW, ...data };
        state.jobs.push(row);
        return row;
      }
    }
  };
  return { state, db };
}

describe('ManyChat completion callback', () => {
  it('keeps legacy Instagram payloads valid and rejects a Facebook payload with no identity', () => {
    assert.equal(
      manyChatCompleteSchema.safeParse({ instagramUserId: '123' }).success,
      true
    );
    assert.equal(
      manyChatCompleteSchema.safeParse({ platform: 'facebook' }).success,
      false
    );
  });

  it('resolves Facebook by PSID and queues through the Facebook pipeline without running the IG resolver', async () => {
    let leadWhere: Row | undefined;
    let resolvedInstagram = 0;
    let queued: unknown[] | undefined;
    const result = await processManyChatComplete({
      webhookKey: 'secret',
      payload: {
        platform: 'facebook',
        facebookUserId: 'fb-psid',
        manyChatSubscriberId: 'subscriber'
      },
      deps: {
        db: {
          account: {
            findUnique: async () => ({ id: 'account' })
          },
          lead: {
            findMany: async (args: Row) => {
              leadWhere = args.where;
              return [
                {
                  id: 'lead',
                  platformUserId: 'fb-psid',
                  conversation: {
                    id: 'conversation',
                    aiActive: true,
                    awaitingAiResponse: false
                  }
                }
              ];
            }
          }
        } as any,
        resolveInstagramRecipient: async () => {
          resolvedInstagram++;
          return 'ignored';
        },
        queueReply: async (...args: unknown[]) => {
          queued = args;
          return { status: 'scheduled', scheduledReplyId: 'job' };
        }
      }
    });
    assert.equal(leadWhere?.platform, 'FACEBOOK');
    assert.deepEqual(
      leadWhere?.OR.map((item: Row) => item.platformUserId),
      ['fb-psid', 'subscriber']
    );
    assert.equal(resolvedInstagram, 0);
    assert.deepEqual(queued?.slice(0, 3), [
      'conversation',
      'account',
      'FACEBOOK'
    ]);
    assert.equal(result.processingStatus, 'scheduled');
    assert.equal(result.scheduledReplyId, 'job');
  });

  it('keeps the Instagram resolver on the legacy default platform', async () => {
    let resolvedInstagram = 0;
    const result = await processManyChatComplete({
      webhookKey: 'secret',
      payload: {
        instagramUserId: '17841400000000000',
        instagramUsername: 'lead'
      },
      deps: {
        db: {
          account: { findUnique: async () => ({ id: 'account' }) },
          lead: {
            findMany: async () => [
              {
                id: 'lead',
                platformUserId: 'old-id',
                conversation: { id: 'conversation' }
              }
            ]
          }
        } as any,
        resolveInstagramRecipient: async () => {
          resolvedInstagram++;
          return '17841400000000000';
        },
        queueReply: async () => ({
          status: 'already_scheduled',
          scheduledReplyId: 'existing'
        })
      }
    });
    assert.equal(resolvedInstagram, 1);
    assert.equal(result.alreadyHandedOff, true);
    assert.equal(result.scheduledReplyId, 'existing');
  });

  it('rejects conflicting callback identities instead of selecting an arbitrary lead', async () => {
    let queued = 0;
    await assert.rejects(
      processManyChatComplete({
        webhookKey: 'secret',
        payload: {
          platform: 'facebook',
          facebookUserId: 'fb-psid',
          manyChatSubscriberId: 'subscriber'
        },
        deps: {
          db: {
            account: { findUnique: async () => ({ id: 'account' }) },
            lead: {
              findMany: async () => [
                {
                  id: 'lead-a',
                  platformUserId: 'fb-psid',
                  conversation: { id: 'conversation-a' }
                },
                {
                  id: 'lead-b',
                  platformUserId: 'subscriber',
                  conversation: { id: 'conversation-b' }
                }
              ]
            }
          } as any,
          queueReply: async () => {
            queued++;
            return { status: 'scheduled', scheduledReplyId: 'job' };
          }
        }
      }),
      (error: any) =>
        error.status === 409 && error.message === 'contact_identity_conflict'
    );
    assert.equal(queued, 0);
  });

  it('bounds a slow Instagram identity lookup before queuing scheduler work', async () => {
    let queued = 0;
    const result = await processManyChatComplete({
      webhookKey: 'secret',
      payload: {
        instagramUserId: 'subscriber-id',
        instagramUsername: 'lead'
      },
      deps: {
        db: {
          account: { findUnique: async () => ({ id: 'account' }) },
          lead: {
            findMany: async () => [
              {
                id: 'lead',
                platformUserId: 'old-id',
                conversation: { id: 'conversation' }
              }
            ]
          }
        } as any,
        resolveInstagramRecipient: async () =>
          new Promise<string | null>(() => {}),
        instagramResolutionTimeoutMs: 1,
        queueReply: async () => {
          queued++;
          return { status: 'scheduled', scheduledReplyId: 'job' };
        }
      }
    });
    assert.equal(queued, 1);
    assert.equal(result.processingStatus, 'scheduled');
  });
});

describe('ManyChat completion queue', () => {
  it('uses the configured delay and debounce floors', () => {
    const scheduled = manyChatCompletionScheduledFor(
      {
        now: NOW,
        earliestLeadAt: new Date(NOW.getTime() - 1000),
        minDelay: 45,
        maxDelay: 120,
        debounceSeconds: 60,
        maxDebounceSeconds: 120
      },
      () => 45
    );
    assert.equal(scheduled.getTime(), NOW.getTime() + 60000);
  });

  it('creates one deterministic job and adopts it on a repeated callback', async () => {
    const fixture = queueDb();
    const first = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW, drawDelay: () => 45 }
    );
    const second = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW, drawDelay: () => 45 }
    );
    assert.equal(first.status, 'scheduled');
    assert.equal(second.status, 'already_scheduled');
    assert.equal(fixture.state.jobs.length, 1);
    assert.equal(fixture.state.jobs[0].id, 'manychat-complete-lead-message');
    assert.equal(fixture.state.conversation.awaitingAiResponse, true);
    assert.equal(fixture.state.locks, 2);
  });

  for (const [label, mutate] of [
    [
      'human review',
      (state: ReturnType<typeof baseState>) =>
        (state.conversation.awaitingHumanReview = true)
    ],
    [
      'scheduling conflict',
      (state: ReturnType<typeof baseState>) =>
        (state.conversation.schedulingConflict = true)
    ],
    [
      'distress hold',
      (state: ReturnType<typeof baseState>) => {
        state.conversation.distressDetected = true;
        state.conversation.awaitingHumanReview = true;
      }
    ]
  ] as const) {
    it(`does not queue or change state while ${label}`, async () => {
      const state = baseState();
      mutate(state);
      const fixture = queueDb(state);
      const result = await queueManyChatCompletionReply(
        'conversation',
        'account',
        'FACEBOOK',
        { db: fixture.db as any, now: () => NOW }
      );
      assert.equal(result.status, 'held');
      assert.deepEqual(state.writes, []);
      assert.equal(state.jobs.length, 0);
    });
  }

  for (const [label, mutate] of [
    [
      'AI off',
      (state: ReturnType<typeof baseState>) =>
        (state.conversation.aiActive = false)
    ],
    [
      'generate only',
      (state: ReturnType<typeof baseState>) =>
        (state.account.generateOnlyFacebook = true)
    ],
    [
      'Away Mode off without an override',
      (state: ReturnType<typeof baseState>) => {
        state.account.awayModeFacebook = false;
        state.conversation.autoSendOverride = false;
      }
    ]
  ] as const) {
    it(`queues existing scheduler work without changing ${label}`, async () => {
      const state = baseState();
      mutate(state);
      const before = {
        aiActive: state.conversation.aiActive,
        autoSendOverride: state.conversation.autoSendOverride,
        awayModeFacebook: state.account.awayModeFacebook,
        generateOnlyFacebook: state.account.generateOnlyFacebook
      };
      const fixture = queueDb(state);
      const result = await queueManyChatCompletionReply(
        'conversation',
        'account',
        'FACEBOOK',
        { db: fixture.db as any, now: () => NOW, drawDelay: () => 45 }
      );
      assert.equal(result.status, 'scheduled');
      assert.equal(state.jobs.length, 1);
      assert.deepEqual(
        {
          aiActive: state.conversation.aiActive,
          autoSendOverride: state.conversation.autoSendOverride,
          awayModeFacebook: state.account.awayModeFacebook,
          generateOnlyFacebook: state.account.generateOnlyFacebook
        },
        before
      );
    });
  }

  it('can resume the normal supportive path after distress review is cleared', async () => {
    const state = baseState();
    state.conversation.distressDetected = true;
    state.conversation.awaitingHumanReview = false;
    const fixture = queueDb(state);
    const result = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW, drawDelay: () => 45 }
    );
    assert.equal(result.status, 'scheduled');
    assert.equal(state.jobs.length, 1);
  });

  it('does not answer when a ManyChat or human outbound is newer than the lead', async () => {
    const state = baseState();
    state.messages.push({
      id: 'newer',
      conversationId: 'conversation',
      sender: 'MANYCHAT',
      content: 'one more automation step',
      timestamp: NOW,
      deletedAt: null
    });
    const fixture = queueDb(state);
    const result = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW }
    );
    assert.equal(result.status, 'no_lead_input');
    assert.equal(state.jobs.length, 0);
  });

  it('does not resurrect terminal failed work for the current lead turn', async () => {
    const state = baseState();
    state.jobs.push({
      id: 'failed',
      conversationId: 'conversation',
      accountId: 'account',
      status: 'FAILED',
      createdAt: NOW
    });
    const fixture = queueDb(state);
    const result = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW }
    );
    assert.equal(result.status, 'needs_review');
    assert.equal(state.jobs.length, 1);
  });

  it('adopts an older processing reply instead of creating a concurrent pending reply', async () => {
    const state = baseState();
    state.jobs.push({
      id: 'older-processing',
      conversationId: 'conversation',
      accountId: 'account',
      status: 'PROCESSING',
      createdAt: new Date(NOW.getTime() - 60_000)
    });
    const fixture = queueDb(state);
    const result = await queueManyChatCompletionReply(
      'conversation',
      'account',
      'FACEBOOK',
      { db: fixture.db as any, now: () => NOW }
    );
    assert.equal(result.status, 'already_scheduled');
    assert.equal(result.scheduledReplyId, 'older-processing');
    assert.equal(state.jobs.length, 1);
    assert.equal(state.conversation.awaitingAiResponse, true);
  });
});
