/**
 * F6/F3 regression: the LLM variable extractor must not produce a PERSISTED
 * binding for explicit-only variables (goal / why / desiredOutcome) when the
 * lead's latest message is a non-answer (deferral / question-back / pricing).
 * Surfaced by the live Seemal repro on 2026-07-23, where goal="consistent
 * profitability" was invented from "never really consistent" after a deferral.
 *
 * Run: npx tsx scripts/test-variable-resolver-gate.ts
 */

import assert from 'node:assert/strict';
import { resolveScriptVariablesForTexts } from '@/lib/script-variable-resolver';

// Stub extractor: always "finds" a value, so the ONLY thing under test is
// whether resolveScriptVariablesForTexts marks it persistable.
const alwaysExtracts = async () => 'consistent profitability';

async function resolveGoal(latestLead: string, extractor = alwaysExtracts) {
  const map = await resolveScriptVariablesForTexts(
    ['why is {{goal}} so important to you though?'],
    {
      accountId: 'test-account',
      extractor,
      context: {
        capturedDataPoints: {},
        conversationHistory: [
          { sender: 'AI', content: 'been trading long?' },
          { sender: 'LEAD', content: 'like 2 years, never really consistent' },
          {
            sender: 'AI',
            content: 'what would making money look like for you?'
          },
          { sender: 'LEAD', content: latestLead }
        ]
      }
    }
  );
  return map.resolvedVariables.find((r) =>
    r.variableName.toLowerCase().includes('goal')
  );
}

async function run() {
  // Non-answers as the LATEST lead message → LLM value must NOT persist.
  const nonAnswers = [
    'before you send me anything just answer me, how long does this take',
    'how much does this cost',
    'why do you need to know that',
    'wait, how long is this gonna take?'
  ];
  for (const t of nonAnswers) {
    const res = await resolveGoal(t);
    assert.ok(res, `resolution exists for goal (latest="${t}")`);
    assert.equal(res!.source, 'llm', `source llm (latest="${t}")`);
    assert.equal(
      res!.shouldPersist,
      false,
      `F6: goal must NOT persist when latest lead message is a non-answer: "${t}"`
    );
  }

  // A real answer as the latest lead message → LLM value MAY persist as before.
  const realAnswers = [
    'i wanna make like 5k a month',
    'i just want to be consistent honestly',
    'to be able to quit my job'
  ];
  for (const t of realAnswers) {
    const res = await resolveGoal(t);
    assert.ok(res, `resolution exists for goal (latest="${t}")`);
    assert.equal(
      res!.shouldPersist,
      true,
      `F6: goal SHOULD persist when latest lead message is a real answer: "${t}"`
    );
  }

  console.log('variable-resolver F6 gate tests passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
