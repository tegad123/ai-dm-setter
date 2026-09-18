import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeManyChatEchoAttribution,
  finalizeManyChatEchoAttributions
} from '../../src/lib/manychat-echo-finalizer';

const NOW = new Date('2026-09-18T18:05:00.000Z');

function fixture(hasNewerActivity = false) {
  const account = {
    id: 'account-1',
    trainingPhase: 'ONBOARDING',
    trainingOverrideCount: 0
  };
  const conversation = {
    id: 'conversation-1',
    personaId: 'persona-1',
    lastMessageAt: new Date('2026-09-18T18:02:00.000Z'),
    awaitingAiResponse: false,
    awaitingSince: null,
    // A source-attribution worker must never clear a safety/review hold.
    awaitingHumanReview: true,
    lead: { accountId: account.id }
  };
  const message: Record<string, any> = {
    id: 'message-1',
    conversationId: conversation.id,
    sender: 'HUMAN',
    content: 'I can take it from here',
    timestamp: new Date('2026-09-18T18:02:00.000Z'),
    deletedAt: null,
    platformMessageId: 'meta-mid-1',
    deliveryStatus: 'META_CONFIRMED',
    humanSource: 'PHONE',
    msgSource: 'UNKNOWN',
    isHumanOverride: false,
    rejectedAISuggestionId: null,
    editedFromSuggestion: false,
    loggedDuringTrainingPhase: false,
    echoAttributionPendingUntil: new Date('2026-09-18T18:04:00.000Z'),
    echoAttributionFinalizedAt: null,
    isVoiceNote: false,
    voiceNoteUrl: null,
    mediaProcessedAt: null
  };
  const suggestion: Record<string, any> = {
    id: 'suggestion-1',
    conversationId: conversation.id,
    responseText: 'I can take it from here',
    messageBubbles: null,
    generatedAt: new Date('2026-09-18T18:01:00.000Z'),
    wasSelected: false,
    wasRejected: false
  };
  const reply = {
    id: 'reply-1',
    conversationId: conversation.id,
    status: 'PENDING',
    createdAt: new Date('2026-09-18T18:01:30.000Z')
  };
  const followUp = {
    id: 'follow-1',
    conversationId: conversation.id,
    messageType: 'FOLLOW_UP_1',
    status: 'PENDING',
    createdAt: new Date('2026-09-18T18:01:00.000Z')
  };
  let locks = 0;

  const tx: Record<string, any> = {
    async $executeRaw() {
      locks++;
      return 1;
    },
    message: {
      async findFirst(args: Record<string, any>) {
        if (args.where?.timestamp?.gt) {
          return hasNewerActivity ? { id: 'newer-lead-message' } : null;
        }
        if (
          message.sender !== 'HUMAN' ||
          message.echoAttributionFinalizedAt ||
          !message.echoAttributionPendingUntil ||
          message.echoAttributionPendingUntil > NOW
        ) {
          return null;
        }
        return { ...message, conversation };
      },
      async update({ data }: Record<string, any>) {
        Object.assign(message, data);
        return message;
      }
    },
    aISuggestion: {
      async findFirst() {
        return suggestion.wasRejected ? null : suggestion;
      },
      async updateMany() {
        if (suggestion.wasRejected || suggestion.wasSelected)
          return { count: 0 };
        suggestion.wasRejected = true;
        return { count: 1 };
      }
    },
    account: {
      async findUnique() {
        return { trainingPhase: account.trainingPhase };
      },
      async update() {
        account.trainingOverrideCount++;
        return account;
      }
    },
    conversation: {
      async updateMany({ data }: Record<string, any>) {
        Object.assign(conversation, data);
        return { count: 1 };
      }
    },
    scheduledReply: {
      async updateMany({ where, data }: Record<string, any>) {
        if (where.createdAt?.lte && reply.createdAt > where.createdAt.lte) {
          return { count: 0 };
        }
        Object.assign(reply, data);
        return { count: 1 };
      }
    },
    scheduledMessage: {
      async updateMany({ where, data }: Record<string, any>) {
        if (where.createdAt?.lte && followUp.createdAt > where.createdAt.lte) {
          return { count: 0 };
        }
        Object.assign(followUp, data);
        return { count: 1 };
      }
    }
  };
  const db: Record<string, any> = {
    message: {
      async findMany() {
        return message.echoAttributionPendingUntil &&
          !message.echoAttributionFinalizedAt
          ? [{ id: message.id, conversationId: message.conversationId }]
          : [];
      }
    },
    async $transaction(run: (client: Record<string, any>) => Promise<unknown>) {
      return run(tx);
    }
  };
  return {
    db,
    message,
    suggestion,
    account,
    conversation,
    reply,
    followUp,
    get locks() {
      return locks;
    }
  };
}

test('expired provisional echo finalizes human side effects once and preserves review holds', async () => {
  const f = fixture();
  const broadcasts: unknown[] = [];
  const first = await finalizeManyChatEchoAttributions({
    db: f.db as any,
    now: NOW,
    broadcast: (...args: unknown[]) => broadcasts.push(args),
    enqueueMedia: async () => ({
      success: true,
      mediaUrl: null,
      transcription: null,
      imageMetadata: null,
      costUsd: null
    })
  });
  const second = await finalizeManyChatEchoAttributions({
    db: f.db as any,
    now: NOW,
    broadcast: (...args: unknown[]) => broadcasts.push(args)
  });

  assert.deepEqual(first, {
    examined: 1,
    finalizedHuman: 1,
    skipped: 0,
    failed: 0
  });
  assert.equal(second.examined, 0);
  assert.equal(f.message.echoAttributionPendingUntil, null);
  assert.equal(f.message.echoAttributionFinalizedAt, NOW);
  assert.equal(f.message.msgSource, 'HUMAN_OVERRIDE');
  assert.equal(f.message.rejectedAISuggestionId, 'suggestion-1');
  assert.equal(f.suggestion.wasRejected, true);
  assert.equal(f.account.trainingOverrideCount, 1);
  assert.equal(f.reply.status, 'CANCELLED');
  assert.equal(f.followUp.status, 'CANCELLED');
  assert.equal(f.conversation.awaitingHumanReview, true);
  assert.equal(f.locks, 1);
  assert.equal(broadcasts.length, 1);
});

test('provider resolution that wins before the finalizer becomes a no-op', async () => {
  const f = fixture();
  f.message.sender = 'MANYCHAT';
  f.message.echoAttributionPendingUntil = null;
  f.message.echoAttributionFinalizedAt = NOW;
  const result = await finalizeManyChatEchoAttributions({
    db: f.db as any,
    now: NOW
  });
  assert.deepEqual(result, {
    examined: 0,
    finalizedHuman: 0,
    skipped: 0,
    failed: 0
  });
  assert.equal(f.account.trainingOverrideCount, 0);
});

test('an ordinary due-now phone echo commits its final marker with human side effects', async () => {
  const f = fixture();
  f.message.echoAttributionPendingUntil = f.message.timestamp;
  const finalized = await finalizeManyChatEchoAttribution({
    messageId: f.message.id,
    conversationId: f.message.conversationId,
    db: f.db as any,
    now: NOW,
    broadcast: () => undefined
  });
  assert.equal(finalized, true);
  assert.equal(f.message.echoAttributionPendingUntil, null);
  assert.equal(f.message.echoAttributionFinalizedAt, NOW);
  assert.equal(f.message.msgSource, 'HUMAN_OVERRIDE');
  assert.equal(f.account.trainingOverrideCount, 1);
  assert.equal(f.reply.status, 'CANCELLED');
  assert.equal(f.followUp.status, 'CANCELLED');
});

test('newer lead activity protects reply and follow-up work created for that later turn', async () => {
  const f = fixture(true);
  f.reply.createdAt = new Date('2026-09-18T18:03:00.000Z');
  f.followUp.createdAt = new Date('2026-09-18T18:03:00.000Z');
  await finalizeManyChatEchoAttributions({
    db: f.db as any,
    now: NOW,
    broadcast: () => undefined
  });
  assert.equal(f.reply.status, 'PENDING');
  assert.equal(f.followUp.status, 'PENDING');
  assert.equal(f.conversation.awaitingHumanReview, true);
});
