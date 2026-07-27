/**
 * Regression coverage for judge-branch routing (Tega 2026-07-27 item 1):
 * response copy must never act as a branch trigger, the LLM tier may answer
 * NONE, and already-delivered required MSGs are never re-injected.
 *
 * Run: npx tsx scripts/test-branch-router.ts
 */
import assert from 'node:assert/strict';
import {
  selectJudgeBranchForLead,
  requiredMsgAlreadyDeliveredInHistory
} from '@/lib/ai-engine';

// Mirrors the live low-ticket step-3 shape (Goal Discovery) with Tega's
// price branch as authored: condition sentence + response instructions in
// ONE runtime_judgment block.
const STEP = {
  stepNumber: 3,
  title: 'Goal Discovery',
  actions: [],
  branches: [
    {
      branchLabel: 'Default',
      conditionDescription: 'Lead gave a concrete goal or number',
      actions: [
        {
          actionType: 'runtime_judgment',
          content: 'They gave a clear goal. Store as {{goal}}.'
        }
      ]
    },
    {
      branchLabel: 'Vague goal',
      conditionDescription: 'Lead is unsure or vague about their goal',
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            'They are unsure, hedging, or vague about what they want from trading.'
        }
      ]
    },
    {
      branchLabel: 'Price Question',
      conditionDescription: '',
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            "They asked about price. Answer it directly and honestly — the link is free to check out, that's the whole point, no catch."
        },
        {
          actionType: 'send_message',
          content:
            "nothing bro, the link's free to check out, that's the whole point. no catch."
        }
      ]
    }
  ]
} as any;

async function run() {
  // 1. "just checking things out" must NOT token-match Price Question even
  //    though the branch copy contains "check out" — condition-only corpus.
  //    Classifier stub declines (returns null) so only token scoring acts.
  const vague = await selectJudgeBranchForLead(
    STEP,
    'honestly not sure yet, just checking things out',
    {
      classifier: async () => ({
        selectedLabel: null,
        error: null,
        timedOut: false
      })
    }
  );
  assert.notEqual(
    vague.branchLabel,
    'Price Question',
    'copy-as-trigger: "checking things out" must not select Price Question'
  );

  // 2. LLM tier may answer NONE — normalized to null selection, no error,
  //    falls back to token confidence (smart mode downstream).
  const checkIn = await selectJudgeBranchForLead(STEP, 'you there?', {
    classifier: async () => 'NONE'
  });
  assert.notEqual(
    checkIn.branchLabel,
    'Price Question',
    'NONE handling: "you there?" must not force a branch'
  );

  // 3. A real price question still routes to the price branch via the LLM
  //    tier (condition text "They asked about price." is intact).
  const price = await selectJudgeBranchForLead(
    STEP,
    'how much does it cost though',
    { classifier: async () => 'Price Question' }
  );
  assert.equal(
    price.branchLabel,
    'Price Question',
    'price question still selects the price branch'
  );

  // 4. Delivered-MSG dedup: the exact price line already in AI history is
  //    treated as satisfied (punctuation/case differences ignored).
  const priceLine =
    "nothing bro, the link's free to check out, that's the whole point. no catch.";
  assert.equal(
    requiredMsgAlreadyDeliveredInHistory(priceLine, [
      'hey Tega, respect for reaching out!',
      "Nothing bro, the link's free to check out — that's the whole point. No catch."
    ]),
    true,
    'delivered dedup: already-sent required MSG is satisfied'
  );
  assert.equal(
    requiredMsgAlreadyDeliveredInHistory(priceLine, [
      'hey Tega, respect for reaching out!'
    ]),
    false,
    'delivered dedup: unsent MSG is not satisfied'
  );

  console.log('branch-router tests passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
