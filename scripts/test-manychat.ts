/* eslint-disable no-console */
// Pure-logic + static-shape tests for the ManyChat integration
// (2026-04-30). Network calls to ManyChat are mocked via fetch
// stub so the test runs hermetically. Verifies:
//   1. verifyApiKey returns valid=true on success and surfaces
//      pageName from the response payload.
//   2. verifyApiKey returns valid=false when ManyChat returns
//      a non-200 OR non-success status payload.
//   3. findSubscriberByInstagramUsername returns the subscriber
//      when last_interaction is within the freshness window.
//   4. findSubscriberByInstagramUsername returns null when the
//      subscriber's last_interaction is older than the window.
//   5. looksLikeManyChatHandoff returns false on missing/empty
//      inputs (defensive contract — webhook-processor relies on
//      this for fail-closed behavior).
//
// Static structural checks:
//   6. webhook-processor.ts new-lead path passes `source` and
//      `leadSource` to the conversation create call.
//   7. ai-engine.ts injects the outbound_context block when
//      conversationCallState.source === 'MANYCHAT'.
//   8. integrations route lists 'MANYCHAT' as a valid provider.
//   9. verify route handles the 'MANYCHAT' case and returns
//      pageName when the key is valid.
import {
  verifyApiKey,
  findSubscriberByInstagramUsername,
  looksLikeManyChatHandoff
} from '../src/lib/manychat';
import { readFileSync } from 'fs';
import { resolve } from 'path';

interface FetchCall {
  url: string;
  init?: RequestInit;
}
const fetchCalls: FetchCall[] = [];
const originalFetch = global.fetch;

function stubFetch(handler: (url: string) => { ok: boolean; json: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = (async (url: any, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: u, init });
    const res = handler(u);
    return new Response(JSON.stringify(res.json), {
      status: res.ok ? 200 : 401,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof global.fetch;
}

function restoreFetch() {
  global.fetch = originalFetch;
  fetchCalls.length = 0;
}

let pass = 0;
let fail = 0;

function record(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? '\n      ' + detail : ''}`);
  }
}

async function run() {
  // 1. verifyApiKey happy path.
  stubFetch(() => ({
    ok: true,
    json: { status: 'success', data: { id: '123', name: 'Daetradez Page' } }
  }));
  const ok1 = await verifyApiKey('valid-key');
  record(
    'verifyApiKey: valid key returns valid=true with pageName',
    ok1.valid === true && ok1.pageName === 'Daetradez Page'
  );
  restoreFetch();

  // 2. verifyApiKey error path.
  stubFetch(() => ({ ok: false, json: { status: 'error' } }));
  const ok2 = await verifyApiKey('bad-key');
  record(
    'verifyApiKey: invalid key returns valid=false',
    ok2.valid === false && ok2.error === 'invalid_or_unreachable'
  );
  restoreFetch();

  // 3. findSubscriber within freshness window.
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  stubFetch(() => ({
    ok: true,
    json: {
      status: 'success',
      data: {
        id: 'sub_1',
        ig_username: 'testlead',
        last_interaction: recent,
        name: 'Test Lead'
      }
    }
  }));
  const sub3 = await findSubscriberByInstagramUsername('key', 'testlead');
  record(
    'findSubscriber: recent interaction returns subscriber',
    sub3 !== null && sub3.id === 'sub_1'
  );
  restoreFetch();

  // 4. findSubscriber outside window.
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  stubFetch(() => ({
    ok: true,
    json: {
      status: 'success',
      data: { id: 'sub_2', ig_username: 'oldlead', last_interaction: old }
    }
  }));
  const sub4 = await findSubscriberByInstagramUsername('key', 'oldlead', {
    windowDays: 7
  });
  record(
    'findSubscriber: stale interaction (>window) returns null',
    sub4 === null
  );
  restoreFetch();

  // 5. looksLikeManyChatHandoff defensive contracts.
  const empty1 = await looksLikeManyChatHandoff('', 'username');
  const empty2 = await looksLikeManyChatHandoff('key', '');
  record(
    'looksLikeManyChatHandoff: empty key or username → false',
    empty1 === false && empty2 === false
  );

  // 6. Static check — webhook-processor passes source + leadSource.
  const webhook = readFileSync(
    resolve(__dirname, '..', 'src/lib/webhook-processor.ts'),
    'utf-8'
  );
  record(
    'webhook-processor: new-lead path sets source + leadSource',
    /source:\s*initialSource[\s\S]{0,200}leadSource:\s*initialSource\s*===\s*'MANYCHAT'/.test(
      webhook
    )
  );
  record(
    'webhook-processor: looksLikeManyChatHandoff is called for INSTAGRAM platform',
    /platform === 'INSTAGRAM'[\s\S]{0,500}looksLikeManyChatHandoff/.test(
      webhook
    )
  );

  // 7. ai-engine outbound_context injection.
  const aiEngine = readFileSync(
    resolve(__dirname, '..', 'src/lib/ai-engine.ts'),
    'utf-8'
  );
  record(
    'ai-engine: outbound_context block prepends when source===MANYCHAT',
    /conversationCallState\?\.source\s*===\s*'MANYCHAT'[\s\S]{0,1500}<outbound_context>/.test(
      aiEngine
    )
  );

  // 8. integrations API includes MANYCHAT.
  const providerRoute = readFileSync(
    resolve(
      __dirname,
      '..',
      'src/app/api/settings/integrations/[provider]/route.ts'
    ),
    'utf-8'
  );
  record(
    "integrations API: VALID_PROVIDERS includes 'MANYCHAT'",
    /VALID_PROVIDERS\s*=\s*\[[\s\S]{0,300}'MANYCHAT'/.test(providerRoute)
  );

  // 9. verify route handles MANYCHAT.
  const verifyRoute = readFileSync(
    resolve(
      __dirname,
      '..',
      'src/app/api/settings/integrations/verify/route.ts'
    ),
    'utf-8'
  );
  record(
    "verify route: 'MANYCHAT' case calls verifyApiKey from manychat module",
    /case 'MANYCHAT'[\s\S]{0,500}verifyApiKey/.test(verifyRoute)
  );

  console.log(
    `\n${pass}/${pass + fail} passed${fail > 0 ? `, ${fail} failed` : ''}`
  );
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
