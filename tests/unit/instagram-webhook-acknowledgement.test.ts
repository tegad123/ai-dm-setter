import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

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

function harness(
  options: {
    credentialError?: boolean;
    incomingError?: boolean;
    credentialFailures?: number;
    skipReply?: boolean;
    validSignature?: boolean;
  } = {}
) {
  const ownershipRecords: unknown[] = [];
  const calls = {
    credentials: 0,
    incoming: 0,
    admin: 0,
    conversation: 0,
    scheduled: 0
  };
  const prisma = {
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
    '@/lib/instagram-ownership-events': {
      extractInstagramOwnershipEvents(entry: any) {
        const controls = (entry.messaging ?? []).filter(
          (event: any) =>
            event.pass_thread_control ||
            event.take_thread_control ||
            event.request_thread_control ||
            event.messaging_handover
        );
        return [...controls, ...(entry.standby ?? [])];
      },
      async recordInstagramOwnershipEvents(params: unknown) {
        ownershipRecords.push(params);
        return 1;
      }
    }
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
