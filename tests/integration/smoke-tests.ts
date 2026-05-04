/* eslint-disable no-console */
// Smoke-test runner — REAL Anthropic + REAL pipeline + REAL test DB.
//
// Usage:
//   npm run test:smoke:seed   # one-time: seed test account/persona
//   npm run test:smoke        # run all 17 scenarios (21 LLM calls)
//
// Each scenario seeds a Conversation, fires one trailing LEAD message
// at scheduleAIReply, waits for the AI Message to land, asserts on
// state, and tears down the conversation rows. Test account/persona
// persist across runs.

import { SMOKE_CONFIG, TEST_URLS } from './smoke-config';
import { SCENARIOS } from './scenarios';
import {
  installFetchStub,
  uninstallFetchStub,
  popMetaCalls,
  seedConversation,
  drainScheduledReply,
  readReplyState,
  deleteConversationTree,
  resolveAccountId,
  resolvePersonaId
} from './smoke-helpers';

interface RunResult {
  id: string;
  name: string;
  passed: boolean;
  reason?: string;
  evidence?: string;
  reply: string;
  durationMs: number;
  metaCallCount: number;
}

async function runOne(
  scenarioIdx: number,
  accountId: string,
  personaId: string
): Promise<RunResult> {
  const scenario = SCENARIOS[scenarioIdx]!;
  const start = Date.now();
  let leadId: string | null = null;
  let conversationId: string | null = null;
  try {
    const seed = await seedConversation({
      accountId,
      personaId,
      history: scenario.history,
      trailingLeadMessage: scenario.trailingLeadMessage,
      igUserIdSuffix: `${scenario.id}_${start}`,
      capturedDataPoints: scenario.capturedDataPoints,
      systemStage: scenario.systemStage
    });
    leadId = seed.leadId;
    conversationId = seed.conversationId;

    popMetaCalls(); // reset stub log
    await drainScheduledReply(
      seed.conversationId,
      accountId,
      seed.trailingMessageTimestamp
    );
    const metaCallCount = popMetaCalls().length;
    const snap = await readReplyState(
      seed.conversationId,
      seed.trailingMessageTimestamp
    );

    const result = scenario.check(snap, TEST_URLS);
    const ret: RunResult = {
      id: scenario.id,
      name: scenario.name,
      passed: result.passed,
      reason: result.passed ? undefined : result.reason,
      evidence: result.passed ? result.evidence : undefined,
      reply: snap.reply.slice(0, 300),
      durationMs: Date.now() - start,
      metaCallCount
    };
    return ret;
  } catch (err) {
    return {
      id: scenario.id,
      name: scenario.name,
      passed: false,
      reason: `exception: ${err instanceof Error ? err.message : String(err)}`,
      reply: '',
      durationMs: Date.now() - start,
      metaCallCount: 0
    };
  } finally {
    if (leadId && conversationId) {
      await deleteConversationTree(leadId, conversationId).catch((e) =>
        console.warn(`[cleanup] ${conversationId}:`, e)
      );
    }
  }
}

async function main() {
  console.log('QualifyDMs Smoke Test Suite');
  console.log('Using REAL LLM + REAL pipeline');
  console.log('================================\n');

  installFetchStub();
  const accountId = await resolveAccountId();
  const personaId = await resolvePersonaId(accountId);
  console.log(
    `Test account: ${SMOKE_CONFIG.testAccountSlug} (${accountId})\nTest persona: ${SMOKE_CONFIG.testPersonaName} (${personaId})\n`
  );

  const results: RunResult[] = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i]!;
    process.stdout.write(`SMOKE ${scenario.id} ${scenario.name}... `);
    const r = await runOne(i, accountId, personaId);
    if (r.passed) {
      process.stdout.write(
        `PASS (${r.durationMs}ms, meta_calls=${r.metaCallCount})\n`
      );
    } else {
      process.stdout.write(`FAIL (${r.durationMs}ms)\n`);
      process.stdout.write(`  reason: ${r.reason}\n`);
      if (r.reply) process.stdout.write(`  reply: "${r.reply}"\n`);
    }
    results.push(r);
  }

  uninstallFetchStub();

  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log('\n================================');
  console.log(`Results: ${passed}/${results.length} passed`);
  if (failed > 0) {
    console.log(`Failures: ${failed}`);
    console.log('\nFailed:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`  SMOKE ${r.id} — ${r.name}`);
        console.log(`    ${r.reason}`);
      });
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(1);
});
