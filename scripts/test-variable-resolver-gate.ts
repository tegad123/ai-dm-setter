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
import {
  buildVariableAskAnchors,
  resolveScriptVariablesForTexts
} from '@/lib/script-variable-resolver';

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

  // Extended explicit-only set (2026-07-23): obstacle / deepWhy / desiredOutcome
  // now also refuse to persist an LLM/branchHistory value when the latest lead
  // message is a non-answer.
  async function resolveVar(varName: string, latestLead: string) {
    const map = await resolveScriptVariablesForTexts(
      [`tell me about your {{${varName}}}`],
      {
        accountId: 'test-account',
        extractor: async () => 'fabricated value',
        context: {
          capturedDataPoints: {},
          conversationHistory: [
            { sender: 'AI', content: 'whats been the hardest part?' },
            { sender: 'LEAD', content: latestLead }
          ]
        }
      }
    );
    return map.resolvedVariables.find(
      (r) => r.variableName.toLowerCase() === varName.toLowerCase()
    );
  }
  for (const varName of ['obstacle', 'deepWhy', 'desiredOutcome']) {
    const blocked = await resolveVar(varName, 'how much does this cost');
    assert.ok(blocked, `resolution exists for ${varName}`);
    assert.equal(
      blocked!.shouldPersist,
      false,
      `F6 extended: ${varName} must NOT persist on a non-answer`
    );
    const ok = await resolveVar(varName, 'i keep blowing my account honestly');
    assert.equal(
      ok!.shouldPersist,
      true,
      `F6 extended: ${varName} SHOULD persist on a real answer`
    );
  }

  console.log('variable-resolver F6 gate tests passed');

  // ---------------------------------------------------------------------------
  // F3 (2026-07-25) — question-anchored binding. Reproduces Tega's run-2
  // slot-offset failure (conv cmrzgulcs000rjm047g6w3t7q): the deep-why answer
  // was bound to `urgency` and the consequence answer to `life_impact` because
  // the resolver extracted whatever the upcoming template needed from the whole
  // history. With anchors, a variable binds ONLY from the reply to its OWN
  // scripted ask.
  // ---------------------------------------------------------------------------
  const RUN2_HISTORY = [
    { sender: 'AI', content: 'Hey Tega, respect for reaching out!' },
    {
      sender: 'AI',
      content:
        'So are you new in the markets or have you been trading for a while?'
    },
    {
      sender: 'LEAD',
      content: 'been trading 2 years, want 10k a month so I can leave my job'
    },
    { sender: 'AI', content: "i respect that bro, that's a real goal." },
    {
      sender: 'AI',
      content: 'but why is 10k a month so important to you though?'
    },
    {
      sender: 'LEAD',
      content:
        "because I'm tired of trading time for money and I want to be free"
    },
    {
      sender: 'AI',
      content:
        "if nothing changes and you're still trading time for money another year from now, what does that do to you?"
    },
    {
      sender: 'LEAD',
      content: "honestly it'd break me, I've already given it two years"
    }
  ];
  // Anchors as buildVariableAskAnchors would derive from the real script.
  const RUN2_ANCHORS = [
    {
      variableName: 'deepWhy',
      stepNumber: 4,
      askContents: [
        'But why is {{their stated goal}} so important to you though?'
      ]
    },
    {
      variableName: 'life_impact',
      stepNumber: 5,
      askContents: [
        'So if you actually hit that, what does that change for you day to day? Like what does life look like on the other side of that?'
      ]
    },
    {
      variableName: 'urgency',
      stepNumber: 6,
      askContents: [
        "Why does that matter to you right now specifically though like why is this the time you're actually doing something about it"
      ]
    }
  ];

  const extractorCalls: Array<{
    variableName: string;
    historyLen: number;
    anchorQuestion?: string;
  }> = [];
  async function resolveAnchored(varName: string) {
    extractorCalls.length = 0;
    const map = await resolveScriptVariablesForTexts([`x {{${varName}}} x`], {
      accountId: 'test-account',
      extractor: async (p: {
        variableName: string;
        conversationHistory: Array<{ sender: string; content: string }>;
        accountId: string;
        anchorQuestion?: string;
      }) => {
        extractorCalls.push({
          variableName: p.variableName,
          historyLen: p.conversationHistory.length,
          anchorQuestion: p.anchorQuestion
        });
        // echo the lead reply it was scoped to — proves WHICH answer binds
        const lead = [...p.conversationHistory]
          .reverse()
          .find((m) => m.sender === 'LEAD');
        return lead?.content ?? null;
      },
      context: {
        capturedDataPoints: {},
        conversationHistory: RUN2_HISTORY,
        askAnchors: RUN2_ANCHORS
      }
    });
    return map.resolvedVariables.find((r) =>
      r.variableName.toLowerCase().includes(varName.toLowerCase())
    );
  }

  // 1. urgency — its scripted ask was NEVER delivered (turn 14 was an
  // off-script consequence probe). Must NOT bind; extractor must not run.
  const urg = await resolveAnchored('urgency');
  assert.ok(urg, 'urgency resolution exists');
  assert.equal(
    urg!.source,
    'fallback',
    `F3: urgency must fall back (no anchored ask) — got source=${urg!.source} value="${urg!.value}"`
  );
  assert.equal(urg!.shouldPersist, false, 'F3: urgency must NOT persist');
  assert.equal(
    extractorCalls.length,
    0,
    'F3: extractor must NOT run for unanchored urgency (no guessing)'
  );

  // 2. life_impact — same: its scripted ask never delivered on run-2. The
  // consequence answer ("it'd break me") must NOT bind to it.
  const li = await resolveAnchored('life_impact');
  assert.equal(
    li!.source,
    'fallback',
    `F3: life_impact must fall back — got source=${li!.source} value="${li!.value}"`
  );
  assert.equal(li!.shouldPersist, false, 'F3: life_impact must NOT persist');

  // 3. deepWhy — its ask WAS delivered ("but why is 10k a month so important
  // to you though?") and answered. Must bind from THAT pair only.
  const dw = await resolveAnchored('deepWhy');
  assert.equal(dw!.source, 'llm', 'F3: deepWhy binds via anchored extraction');
  assert.equal(dw!.shouldPersist, true, 'F3: deepWhy persists (anchored)');
  assert.ok(
    dw!.value.includes('tired of trading time for money'),
    `F3: deepWhy must hold the DEEP-WHY answer, got "${dw!.value}"`
  );
  assert.equal(extractorCalls.length, 1, 'F3: one scoped extractor call');
  assert.equal(
    extractorCalls[0].historyLen,
    2,
    'F3: extractor scoped to the ask→reply PAIR, not full history'
  );
  assert.ok(
    (extractorCalls[0].anchorQuestion ?? '').includes('so important to you'),
    'F3: anchorQuestion threaded to extractor'
  );

  // 4. buildVariableAskAnchors derives anchors from script steps
  const anchors = buildVariableAskAnchors([
    {
      stepNumber: 6,
      title: 'Why That Change Matters Now',
      actions: [
        {
          actionType: 'runtime_judgment',
          content: 'Store as {{urgency}}. This is the final piece.'
        },
        {
          actionType: 'ask_question',
          content: 'Why does that matter to you right now specifically though'
        }
      ]
    },
    {
      stepNumber: 5,
      title: 'Life Impact — What It Changes',
      actions: [
        {
          actionType: 'ask_question',
          content: 'what does that change for you?'
        }
      ]
    }
  ]);
  assert.ok(
    anchors.some((a) => a.variableName === 'urgency' && a.stepNumber === 6),
    'anchor from runtime_judgment {{token}}'
  );
  assert.ok(
    anchors.some((a) => a.variableName === 'life_impact' && a.stepNumber === 5),
    'anchor from step-title hint'
  );

  console.log('variable-resolver F3 anchor tests passed');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
