#!/usr/bin/env tsx
/* eslint-disable no-console */
// Persona testing harness runner.
//
// MUST import ./lib/safety-guard FIRST. The guard rewrites
// process.env.DATABASE_URL to TEST_DATABASE_URL before any prisma
// import runs. Reordering this import will silently scribble over the
// production DB.

import './lib/safety-guard';

import { readdirSync } from 'fs';
import { resolve, join } from 'path';
import { HARNESS_CONFIG, assertTestDb, getPrisma } from './lib/safety-guard';
import {
  newIdResolver,
  seedAccount,
  seedIntegrationCredential,
  seedPersona,
  seedScenarioLead,
  seedScriptFixture,
  seedTrainingFixture
} from './lib/db-seed';
import { cleanupByPersona, cleanupAll, reportOrphans } from './lib/db-cleanup';
import {
  installFetchStub,
  uninstallFetchStub,
  resetTelemetry,
  snapshotTelemetry
} from './lib/network-stub';
import { runTurn } from './lib/invoke-pipeline';
import { evaluateAssertion } from './lib/assertions';
import { BudgetExceededError, RateLimitExhaustedError } from './lib/errors';
import type {
  PersonaResult,
  PersonaScenario,
  Scenario,
  ScenarioResult,
  ScenarioResultStatus,
  TurnResult
} from './types';
import type { TurnOutcome } from './lib/invoke-pipeline';

const PERSONAS_DIR = resolve(__dirname, 'personas');

async function loadPersonas(): Promise<PersonaScenario[]> {
  const files = readdirSync(PERSONAS_DIR).filter(
    (f) => f.endsWith('.persona.ts') && !f.startsWith('_')
  );
  const personas: PersonaScenario[] = [];
  for (const f of files) {
    const mod = await import(join(PERSONAS_DIR, f));
    if (!mod.persona) {
      throw new Error(`${f} does not export a "persona" object`);
    }
    personas.push(mod.persona);
  }
  return personas;
}

async function runScenario(
  persona: PersonaScenario,
  scenario: Scenario,
  accountId: string,
  personaId: string,
  allowedUrls: string[]
): Promise<ScenarioResult> {
  const startMs = Date.now();
  const seeded = await seedScenarioLead(
    accountId,
    personaId,
    persona.slug,
    scenario.id
  );

  resetTelemetry();
  installFetchStub({ fastPath: scenario.fastPath ?? true });

  const turns: TurnResult[] = [];
  let status: ScenarioResultStatus = 'PASS';
  let errorMsg: string | undefined;
  let lastOutcome: TurnOutcome | null = null;
  let turnIndex = 0;

  try {
    for (const turn of scenario.turns) {
      if (turn.role === 'lead') {
        const outcome = await runTurn({
          accountId,
          conversationId: seeded.conversationId,
          platformUserId: seeded.platformUserId,
          messageText: turn.content
        });
        lastOutcome = outcome;
        turns.push({
          index: turnIndex,
          leadContent: turn.content,
          aiReply: outcome.aiReplyText,
          assertions: []
        });
      } else {
        if (!lastOutcome) {
          throw new Error(
            `scenario ${scenario.id}: assertions block before any lead turn`
          );
        }
        const results = turn.expect.map((a) =>
          evaluateAssertion(a, lastOutcome!, { allowedUrls })
        );
        const lastTurn = turns[turns.length - 1];
        if (lastTurn) lastTurn.assertions.push(...results);
        if (results.some((r) => !r.passed)) {
          status = 'FAIL';
        }
      }
      turnIndex += 1;
    }
  } catch (err) {
    if (err instanceof RateLimitExhaustedError) {
      status = 'RATE_LIMIT_EXHAUSTED';
      errorMsg = err.message;
    } else {
      status = 'HARNESS_ERROR';
      errorMsg = err instanceof Error ? err.message : String(err);
    }
  } finally {
    uninstallFetchStub();
  }

  const telemetry = snapshotTelemetry();

  if (scenario.expected === 'fail' && status === 'FAIL') {
    status = 'EXPECTED_FAIL';
  }

  return {
    scenarioId: scenario.id,
    status,
    elapsedMs: Date.now() - startMs,
    turns,
    llmCalls: telemetry.totalCalls,
    costUsd: telemetry.totalUsd,
    error: errorMsg
  };
}

async function runPersona(persona: PersonaScenario): Promise<PersonaResult> {
  const startMs = Date.now();
  console.log(`\n──── persona: ${persona.slug} ────`);
  let accountId: string;
  let personaId: string;
  let allowedUrls: string[] = [];
  try {
    const account = await seedAccount(persona.slug, persona.accountConfig);
    accountId = account.id;
    await seedIntegrationCredential(accountId);
    const seededPersona = await seedPersona(
      accountId,
      persona.slug,
      persona.personaConfig
    );
    personaId = seededPersona.id;
    allowedUrls = seededPersona.allowedUrls;

    // Optional prod-dump extras
    if (
      persona.scriptConfig ||
      (persona.trainingUploads && persona.trainingUploads.length)
    ) {
      const resolver = newIdResolver(persona.slug, accountId, personaId);
      if (persona.scriptConfig) {
        await seedScriptFixture(
          accountId,
          persona.slug,
          persona.scriptConfig,
          resolver
        );
        console.log(
          `  seeded script: ${persona.scriptConfig.steps.length} step(s), ${persona.scriptConfig.branches.length} branch(es), ${persona.scriptConfig.actions.length} action(s)`
        );
      }
      if (persona.trainingUploads && persona.trainingUploads.length) {
        const seeded = await seedTrainingFixture(
          accountId,
          personaId,
          persona.slug,
          persona.trainingUploads,
          persona.trainingConversations ?? [],
          persona.trainingMessages ?? [],
          resolver
        );
        console.log(
          `  seeded training: ${seeded.uploadIds.length} upload(s), ${seeded.conversationIds.length} conv(s), ${seeded.messageIds.length} msg(s)`
        );
      }
    }
  } catch (err) {
    console.error(`[harness] seed failed for ${persona.slug}:`, err);
    throw err;
  }

  const scenarioResults: ScenarioResult[] = [];
  try {
    for (const scenario of persona.scenarios) {
      const r = await runScenario(
        persona,
        scenario,
        accountId,
        personaId,
        allowedUrls
      );
      scenarioResults.push(r);
      console.log(
        `  scenario ${r.scenarioId}: ${r.status} (${r.elapsedMs}ms, ${r.llmCalls} LLM calls, $${r.costUsd.toFixed(4)})`
      );
      // Print per-turn detail for any non-PASS outcome — including
      // HARNESS_ERROR. Earlier runs swallowed assertion results when
      // a turn threw, which hid prior-turn signal behind the error.
      const isUnsuccessful =
        r.status === 'FAIL' ||
        r.status === 'HARNESS_ERROR' ||
        r.status === 'RATE_LIMIT_EXHAUSTED';
      if (isUnsuccessful) {
        // Count how many assertions actually evaluated before the throw.
        let evaluatedAssertions = 0;
        let failedAssertions = 0;
        for (const t of r.turns) {
          for (const a of t.assertions) {
            evaluatedAssertions += 1;
            if (!a.passed) {
              failedAssertions += 1;
              console.log(`    × turn ${t.index}: ${a.message}`);
            }
          }
        }
        const turnsCompleted = r.turns.length;
        const totalTurns = persona.scenarios.find((s) => s.id === r.scenarioId)
          ?.turns.length;
        console.log(
          `    turns ran: ${turnsCompleted}${
            totalTurns ? ` / ${totalTurns}` : ''
          } | assertions: ${evaluatedAssertions - failedAssertions} pass, ${failedAssertions} fail`
        );
        if (r.error) {
          console.log(`    error: ${r.error.split('\n')[0]}`);
        }
        if (r.status === 'HARNESS_ERROR') {
          console.log(
            `    note: HARNESS_ERROR halts the scenario; downstream assertions did not run.`
          );
        }
      }
    }
  } finally {
    const counts = await cleanupByPersona(persona.slug);
    console.log(
      `  cleanup: ${counts.messages}m ${counts.scheduled}sr ${counts.conversations}c ${counts.leads}l ${counts.personas}p ${counts.accounts}a`
    );
  }

  const totalLlmCalls = scenarioResults.reduce((s, r) => s + r.llmCalls, 0);
  const totalCostUsd = scenarioResults.reduce((s, r) => s + r.costUsd, 0);

  return {
    slug: persona.slug,
    scenarios: scenarioResults,
    totalElapsedMs: Date.now() - startMs,
    totalLlmCalls,
    totalCostUsd,
    providerBreakdown: {}
  };
}

async function main(): Promise<void> {
  await assertTestDb();
  const prisma = await getPrisma();
  console.log(
    `[harness] connected to test DB: ${HARNESS_CONFIG.testDatabaseName} @ ${HARNESS_CONFIG.testDatabaseHost}`
  );

  // Pre-sweep — any orphan rows from a previous aborted run.
  await cleanupAll();

  const personas = await loadPersonas();
  if (personas.length === 0) {
    console.log('[harness] no personas to run — exiting.');
    await prisma.$disconnect();
    return;
  }

  console.log(`[harness] running ${personas.length} persona(s)`);

  const results: PersonaResult[] = [];
  let realFailureCount = 0;
  let rateLimitedCount = 0;

  for (const persona of personas) {
    const r = await runPersona(persona);
    results.push(r);
    for (const s of r.scenarios) {
      if (s.status === 'FAIL' || s.status === 'HARNESS_ERROR') {
        realFailureCount += 1;
      } else if (s.status === 'RATE_LIMIT_EXHAUSTED') {
        rateLimitedCount += 1;
      }
    }

    if (r.totalCostUsd > HARNESS_CONFIG.maxCostUsd) {
      console.error(
        `[harness] BUDGET_EXCEEDED: persona ${r.slug} cost $${r.totalCostUsd.toFixed(4)} > $${HARNESS_CONFIG.maxCostUsd}`
      );
      throw new BudgetExceededError(
        `persona ${r.slug} exceeded harness budget`,
        HARNESS_CONFIG.maxCostUsd,
        r.totalCostUsd
      );
    }

    console.log(
      `Persona ${r.slug}: ${r.totalLlmCalls} LLM calls, $${r.totalCostUsd.toFixed(4)}, ${Math.round(r.totalElapsedMs / 1000)}s`
    );
    if (r.totalElapsedMs > 60_000) {
      console.warn(
        `[harness] WARNING: persona ${r.slug} exceeded 60s budget (${Math.round(r.totalElapsedMs / 1000)}s)`
      );
    }
  }

  // Final belt-and-braces sweep
  await cleanupAll();
  const orphans = await reportOrphans();

  console.log('\n──── summary ────');
  const totalCalls = results.reduce((s, r) => s + r.totalLlmCalls, 0);
  const totalUsd = results.reduce((s, r) => s + r.totalCostUsd, 0);
  console.log(
    `Total: ${results.length} personas, ${totalCalls} LLM calls, $${totalUsd.toFixed(4)}`
  );
  if (rateLimitedCount > 0) {
    console.log(
      `${rateLimitedCount} scenario(s) failed due to rate limits (not script bugs)`
    );
  }
  if (realFailureCount > 0) {
    console.log(`${realFailureCount} scenario(s) FAILED`);
  }
  if (orphans > 0) {
    console.error(
      `[harness] ${orphans} orphan account(s) remain — purge manually.`
    );
  }

  await prisma.$disconnect();

  // Exit code semantics:
  //   - real script failures or harness errors -> 1
  //   - rate-limited only -> 0 (infra issue, not regression)
  //   - orphan rows -> 2 (cleanup integrity broken)
  if (realFailureCount > 0) process.exit(1);
  if (orphans > 0) process.exit(2);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('[harness] fatal:', err);
  try {
    await cleanupAll();
  } catch (cleanupErr) {
    console.error('[harness] cleanup-on-fatal failed:', cleanupErr);
  }
  process.exit(1);
});
