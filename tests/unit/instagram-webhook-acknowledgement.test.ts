import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';
import * as crypto from 'node:crypto';

// Execute the real route with all external dependencies replaced. In particular,
// never import the real Prisma singleton or webhook processor (or load .env).
const routeSource = readFileSync(
  resolve(process.cwd(), 'src/app/api/webhooks/instagram/route.ts'),
  'utf8'
);
const routeCode = ts.transpileModule(routeSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

// Exercise the real extractor, hashing and persistence together with the route.
// Only the database boundary is mocked; no .env or real Prisma is loaded.
function ownershipModule(prisma: unknown) {
  const source = readFileSync(
    resolve(process.cwd(), 'src/lib/instagram-ownership-events.ts'),
    'utf8'
  );
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name: string) {
      if (name === 'node:crypto') return crypto;
      assert.equal(name, '@/lib/prisma');
      return { default: prisma };
    },
    Date
  });
  return exports;
}

function harness(
  options: {
    ownershipFailureAt?: number;
    credentialError?: boolean;
    incomingError?: boolean;
    credentialFailures?: number;
    skipReply?: boolean;
    validSignature?: boolean;
  } = {}
) {
  const ownershipRecords: Array<{ payloadHash: string }> = [];
  let ownershipWrites = 0;
  const ownershipHashes = new Set<string>();
  const calls = {
    credentials: 0,
    incoming: 0,
    admin: 0,
    deletion: 0,
    conversation: 0,
    scheduled: 0
  };
  const prisma = {
    instagramOwnershipEventLog: {
      async createMany(params: {
        data: Array<{ payloadHash: string }>;
        skipDuplicates: boolean;
      }) {
        ownershipWrites++;
        if (ownershipWrites === options.ownershipFailureAt)
          throw new Error('audit storage unavailable');
        assert.equal(params.skipDuplicates, true);
        let count = 0;
        for (const row of params.data) {
          if (ownershipHashes.has(row.payloadHash)) continue;
          ownershipHashes.add(row.payloadHash);
          ownershipRecords.push(row);
          count++;
        }
        return { count };
      }
    },
    integrationCredential: {
      async findMany() {
        calls.credentials++;
        if (
          options.credentialError ||
          calls.credentials <= (options.credentialFailures ?? 0)
        ) {
          throw Object.assign(new Error('connection pool checkout timed out'), {
            code: 'ECHECKOUTTIMEOUT'
          });
        }
        return [
          {
            id: 'credential',
            provider: 'INSTAGRAM',
            accountId: 'account',
            metadata: { igProfessionalAccountId: 'business' }
          }
        ];
      }
    },
    conversation: {
      async findUnique() {
        calls.conversation++;
        return { aiActive: true, awaitingHumanReview: false };
      }
    }
  };
  const processor = {
    async processMessageDeletion() {
      calls.deletion++;
    },
    async processAdminMessage() {
      calls.admin++;
    },
    async processIncomingMessage() {
      calls.incoming++;
      if (options.incomingError)
        throw new Error('processing failed after entry started');
      return {
        conversationId: 'conversation',
        skipReply: options.skipReply ?? false
      };
    },
    async computeReplyDelaySeconds() {
      return 60;
    },
    async scheduleAIReply() {
      calls.scheduled++;
    }
  };
  const dependencies: Record<string, unknown> = {
    'next/server': {
      NextResponse: {
        json: (body: unknown, init: { status: number }) => ({
          body,
          status: init.status
        })
      },
      after() {
        throw new Error('unexpected inline execution');
      }
    },
    '@/lib/instagram': {
      verifyWebhookSignature: () => options.validSignature ?? true,
      getUserProfile: async () => ({ name: 'Test', username: 'test' })
    },
    '@/lib/prisma': { default: prisma },
    '@/lib/webhook-processor': processor,
    '@/lib/platform-not-connected-alert': {},
    '@/lib/quality-gate-escalation': {},
    '@/lib/meta-delivery-errors': {},
    '@/lib/instagram-ownership-events': ownershipModule(prisma)
  };
  const exports: Record<string, any> = {};
  runInNewContext(routeCode, {
    exports,
    require(name: string) {
      assert.ok(name in dependencies, `unexpected real dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { NODE_ENV: 'production' } },
    console: { log() {}, warn() {}, error() {} },
    URL,
    Date,
    Set
  });
  return {
    calls,
    ownershipRecords,
    post: (body: unknown, raw = false) =>
      exports.POST({
        text: async () => (raw ? body : JSON.stringify(body)),
        headers: { get: () => 'test-signature' }
      })
  };
}

const inbound = {
  object: 'instagram',
  entry: [
    {
      id: 'business',
      messaging: [
        {
          sender: { id: 'lead' },
          recipient: { id: 'business' },
          message: { mid: 'message-1', text: 'Hello' }
        }
      ]
    }
  ]
};

test('credential checkout failure returns 503 before processing or persistence', async () => {
  const h = harness({ credentialError: true });
  const response = await h.post(inbound);
  assert.equal(response.status, 503);
  assert.deepEqual(h.calls, {
    credentials: 1,
    incoming: 0,
    admin: 0,
    deletion: 0,
    conversation: 0,
    scheduled: 0
  });
  assert.equal(
    JSON.stringify(response.body).includes('ECHECKOUTTIMEOUT'),
    false
  );
});

test('valid delivery enqueues work and acknowledges 200 after credentials recover', async () => {
  const h = harness();
  assert.equal((await h.post(inbound)).status, 200);
  assert.deepEqual(h.calls, {
    credentials: 1,
    incoming: 1,
    admin: 0,
    deletion: 0,
    conversation: 1,
    scheduled: 1
  });
});

test('duplicate skipReply decision remains acknowledged without scheduling twice', async () => {
  const h = harness({ skipReply: true });
  assert.equal((await h.post(inbound)).status, 200);
  assert.deepEqual(h.calls, {
    credentials: 1,
    incoming: 1,
    admin: 0,
    deletion: 0,
    conversation: 0,
    scheduled: 0
  });
});

test('malformed JSON and invalid envelopes return 400 without database access', async () => {
  const h = harness();
  for (const body of [
    '{',
    'null',
    '[]',
    '{}',
    '{"object":"instagram","entry":{}}'
  ]) {
    assert.equal((await h.post(body, true)).status, 400);
  }
  assert.equal(h.calls.credentials, 0);
});

test('unrelated object remains acknowledged and does not access credentials', async () => {
  const h = harness();
  assert.equal((await h.post({ object: 'page', entry: [] })).status, 200);
  assert.equal(h.calls.credentials, 0);
});

test('echo opener credential failure is retried before admin classification', async () => {
  const h = harness({ credentialFailures: 1 });
  const echo = {
    object: 'instagram',
    entry: [
      {
        id: 'business',
        messaging: [
          {
            sender: { id: 'business' },
            recipient: { id: 'lead' },
            message: {
              mid: 'opener-mid',
              text: 'Hey there! Thanks for following me',
              is_echo: true
            }
          }
        ]
      }
    ]
  };
  assert.equal((await h.post(echo)).status, 503);
  assert.equal(h.calls.admin, 0);
  assert.equal(h.calls.incoming, 0);
  assert.equal((await h.post(echo)).status, 200);
  assert.equal(h.calls.admin, 1);
  assert.equal(h.calls.credentials, 2);
  assert.equal(h.calls.scheduled, 0);
});

test('identical inbound redelivery succeeds after the initial credential failure', async () => {
  const h = harness({ credentialFailures: 1 });
  assert.equal((await h.post(inbound)).status, 503);
  assert.equal(h.calls.incoming, 0);
  assert.equal((await h.post(inbound)).status, 200);
  assert.equal(h.calls.incoming, 1);
  assert.equal(h.calls.scheduled, 1);
});

test('invalid signature remains 401 before parsing or credential lookup', async () => {
  const h = harness({ validSignature: false });
  assert.equal((await h.post(inbound)).status, 401);
  assert.equal(h.calls.credentials, 0);
  assert.equal(h.calls.incoming, 0);
  assert.equal(h.calls.admin, 0);
});

// Later failures may follow committed writes. This patch intentionally does not
// request whole-batch redelivery for those existing per-event failure paths.
test('failure after event processing starts retains existing acknowledgement', async () => {
  const h = harness({ incomingError: true });
  assert.equal((await h.post(inbound)).status, 200);
  assert.equal(h.calls.credentials, 1);
  assert.equal(h.calls.incoming, 1);
  assert.equal(h.calls.scheduled, 0);
});

test('standby messages are logged without entering the reply pipeline', async () => {
  const h = harness();
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'business',
        standby: [
          {
            sender: { id: 'lead' },
            recipient: { id: 'business' },
            timestamp: 1789600000000,
            message: { mid: 'standby-mid', text: 'hello secondary app' }
          }
        ]
      }
    ]
  };
  assert.equal((await h.post(payload)).status, 200);
  assert.equal(h.ownershipRecords.length, 1);
  assert.equal(h.calls.incoming, 0);
  assert.equal(h.calls.admin, 0);
  assert.equal(h.calls.scheduled, 0);
});

test('standalone control events are logged without changing conversation state', async () => {
  const h = harness();
  const payload = {
    object: 'instagram',
    entry: [
      {
        id: 'business',
        messaging: [
          {
            sender: { id: 'lead' },
            recipient: { id: 'business' },
            timestamp: 1789600000000,
            pass_thread_control: {
              previous_owner_app_id: '532160876956612',
              new_owner_app_id: '2027287141168190'
            }
          }
        ]
      }
    ]
  };
  assert.equal((await h.post(payload)).status, 200);
  assert.equal(h.ownershipRecords.length, 1);
  assert.equal(h.calls.incoming, 0);
  assert.equal(h.calls.conversation, 0);
  assert.equal(h.calls.scheduled, 0);
});

const controlEntry = (timestamp: number) => ({
  id: 'business',
  messaging: [
    {
      sender: { id: 'lead' },
      recipient: { id: 'business' },
      timestamp,
      pass_thread_control: {
        previous_owner_app_id: 'old',
        new_owner_app_id: 'new'
      }
    }
  ]
});

function assertNoMessageEffects(h: ReturnType<typeof harness>) {
  assert.equal(h.calls.incoming, 0);
  assert.equal(h.calls.admin, 0);
  assert.equal(h.calls.deletion, 0);
  assert.equal(h.calls.conversation, 0);
  assert.equal(h.calls.scheduled, 0);
}

test('audit-only storage failure returns 503 and identical redelivery saves once', async () => {
  const h = harness({ ownershipFailureAt: 1 });
  const payload = { object: 'instagram', entry: [controlEntry(1789600000000)] };
  const response = await h.post(payload);
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response.body).includes('audit storage'), false);
  assert.equal(h.ownershipRecords.length, 0);
  assertNoMessageEffects(h);
  assert.equal((await h.post(payload)).status, 200);
  assert.equal((await h.post(payload)).status, 200);
  assert.equal(h.ownershipRecords.length, 1);
  assertNoMessageEffects(h);
});

test('later audit failure prevents earlier-entry messages, echoes and deletions from processing', async () => {
  const h = harness({ ownershipFailureAt: 2 });
  const first = {
    ...inbound.entry[0],
    message_deletions: [{ mid: 'deleted-message' }],
    messaging: [
      ...inbound.entry[0].messaging,
      {
        sender: { id: 'business' },
        recipient: { id: 'lead' },
        message: { mid: 'echo', text: 'human response', is_echo: true }
      }
    ]
  };
  const payload = {
    object: 'instagram',
    entry: [first, controlEntry(1789600000000), controlEntry(1789600001000)]
  };
  assert.equal((await h.post(payload)).status, 503);
  assert.equal(h.ownershipRecords.length, 1);
  assertNoMessageEffects(h);
  // The full batch may be retried: the first audit row is deduplicated, and
  // normal messages are only now processed for the first time.
  assert.equal((await h.post(payload)).status, 200);
  assert.equal(h.ownershipRecords.length, 2);
  assert.equal(h.calls.incoming, 1);
  assert.equal(h.calls.admin, 1);
  assert.equal(h.calls.deletion, 1);
  assert.equal(h.calls.scheduled, 1);
});

test('mixed-entry audit failure blocks normal processing until persistence recovers', async () => {
  const h = harness({ ownershipFailureAt: 1 });
  const payload = {
    object: 'instagram',
    entry: [
      {
        ...inbound.entry[0],
        messaging: [
          ...inbound.entry[0].messaging,
          ...controlEntry(1789600000000).messaging
        ],
        standby: [
          {
            sender: { id: 'business' },
            recipient: { id: 'lead' },
            message: { mid: 'standby-echo', text: 'opener', is_echo: true }
          }
        ]
      }
    ]
  };
  assert.equal((await h.post(payload)).status, 503);
  assertNoMessageEffects(h);
  assert.equal((await h.post(payload)).status, 200);
  assert.equal(h.ownershipRecords.length, 2);
  assert.equal(h.calls.incoming, 1);
  assert.equal(h.calls.admin, 0);
  assert.equal(h.calls.scheduled, 1);
});
