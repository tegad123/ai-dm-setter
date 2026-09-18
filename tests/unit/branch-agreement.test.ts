// Branch selection on judge+FSM agreement (M5 items 3-4, 2026-09-15).
//
// The failure this prevents: when the LLM judge names a branch but its
// confidence does not "lock", the legacy engine left selectedCurrentJudgeBranch
// NULL. A null branch widens the required-[MSG] set from the selected branch to
// the WHOLE step, and the injectors then ship other branches' copy. Local
// Daniel v2 runs, 2026-09-15:
//   • flow 6 (decline): judge said "Hesitant", branch stayed null, and the
//     YES branch's Discord link was appended to a lead who had just said no.
//   • flow 3 (solicitation): judge said "Solicitation / non-lead" (a silent
//     branch), branch stayed null, and the ask-step gate demanded a question.
// Two independent routers agreeing (judge label == compiled-FSM edge) is a
// stronger signal than one classifier's confidence score, so the engine adopts
// the branch in that case even while the FSM is still in shadow mode.
//
// Run: npx tsx --test tests/unit/branch-agreement.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compileScript,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';
import { nodeForStep, selectEdge } from '../../src/lib/script-fsm/runtime';
import {
  enforceOfferBranchPreconditions,
  enforceSendThenAskSequence,
  runtimeJudgmentOnlyBranchShouldStaySilent
} from '../../src/lib/ai-engine';
import { getStepActionShape } from '../../src/lib/script-step-progression';

const A = (actionType: string, content = '') => ({ actionType, content });

// Daniel v2 step 6 "Send the Link": YES carries the link, Hesitant is a
// softer re-ask, Soft exit is send-and-stop.
const v2: CompilableStep[] = [
  {
    stepNumber: 6,
    title: 'Send the Link',
    branches: [
      {
        branchLabel: 'YES',
        conditionDescription: 'the lead said yes to the link',
        actions: [
          A('send_message', 'bet, here you go 💯'),
          A('send_link'),
          A(
            'send_message',
            "jump in and introduce yourself in the intro channel, I'm in there daily."
          ),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'Hesitant',
        conditionDescription: 'the lead is unsure or hesitant',
        actions: [
          A(
            'send_message',
            "no pressure, it's completely free. just a room where I post setups and answer questions."
          ),
          A('ask_question', 'worth a look?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'Soft exit',
        conditionDescription: 'the lead declined',
        actions: [
          A('send_message', "all good bro, door's open whenever 🙏🏽"),
          A('runtime_judgment', 'End of script. No link, no second pitch.')
        ]
      }
    ]
  },
  {
    stepNumber: 7,
    title: 'Follow-Up',
    branches: [
      {
        branchLabel: 'Check-in',
        conditionDescription: 'default',
        actions: [
          A('send_message', 'yo {{name}}, you make it into the discord?'),
          A('wait_for_response')
        ]
      }
    ]
  }
];

const fsm = compileScript(v2);
const step6 = nodeForStep(fsm, 6)!;

const STRUCTURAL_REASONS = ['default', 'source', 'always', 'data'];

/** The engine's rule, extracted: adopt the branch when the judge named it and
 *  the FSM selected the same one (even at low judge confidence), OR when the
 *  judge abstained entirely and the FSM made a structural pick. A judge label
 *  that disagrees with the FSM adopts nothing. */
function adoptedBranch(params: {
  lockedBranchLabel: string | null;
  judgeLabel: string | null;
  fsmLabel: string | null;
  fsmReason?: string;
}): string | null {
  if (params.lockedBranchLabel) return params.lockedBranchLabel;
  if (!params.fsmLabel) return null;
  if (params.judgeLabel && params.judgeLabel === params.fsmLabel) {
    return params.fsmLabel;
  }
  if (
    params.judgeLabel === null &&
    STRUCTURAL_REASONS.includes(params.fsmReason ?? '')
  ) {
    return params.fsmLabel;
  }
  return null;
}

describe('judge + FSM agreement selects the branch', () => {
  const fsmLabelFor = (judgeLabel: string | null) => {
    const sel = selectEdge(step6, {
      source: 'INBOUND',
      latestLeadText: 'no',
      dataPoints: {},
      judgeLabel
    });
    return sel.kind === 'edge' ? sel.edge.branchLabel : null;
  };

  it('a declining lead lands on Soft exit, and the YES branch is never the adopted one (flow 6)', () => {
    const judgeLabel = 'Soft exit';
    const adopted = adoptedBranch({
      lockedBranchLabel: null,
      judgeLabel,
      fsmLabel: fsmLabelFor(judgeLabel)
    });
    assert.equal(adopted, 'Soft exit');
    assert.notEqual(adopted, 'YES');
  });

  it('the adopted branch scopes the required messages to itself, so the link cannot be appended', () => {
    const adopted = adoptedBranch({
      lockedBranchLabel: null,
      judgeLabel: 'Soft exit',
      fsmLabel: fsmLabelFor('Soft exit')
    });
    const branch = step6.edges.find((e) => e.branchLabel === adopted)!;
    const texts = branch.deliverables
      .filter((d) => d.kind === 'send_message' || d.kind === 'ask')
      .map((d) => (d as { text: string }).text);
    assert.deepEqual(texts, ["all good bro, door's open whenever 🙏🏽"]);
    assert.ok(
      !branch.deliverables.some((d) => d.kind === 'send_link'),
      'the soft-exit branch carries no link'
    );
  });

  it('a locked judge branch still wins outright (existing behaviour preserved)', () => {
    assert.equal(
      adoptedBranch({
        lockedBranchLabel: 'Hesitant',
        judgeLabel: 'Soft exit',
        fsmLabel: 'Soft exit'
      }),
      'Hesitant'
    );
  });

  it('disagreement adopts nothing: one unconfident router is not enough', () => {
    assert.equal(
      adoptedBranch({
        lockedBranchLabel: null,
        judgeLabel: 'Hesitant',
        fsmLabel: 'Soft exit',
        fsmReason: 'judge'
      }),
      null
    );
  });

  it('judge abstains + FSM structural pick adopts the FSM branch (flow 6 step 7: the false "you make it into the discord?" claim)', () => {
    assert.equal(
      adoptedBranch({
        lockedBranchLabel: null,
        judgeLabel: null,
        fsmLabel: 'No response',
        fsmReason: 'default'
      }),
      'No response'
    );
    // but an FSM pick that only came from the judge's own advice, with no
    // judge label, is not structural — adopt nothing.
    assert.equal(
      adoptedBranch({
        lockedBranchLabel: null,
        judgeLabel: null,
        fsmLabel: 'Soft exit',
        fsmReason: 'judge'
      }),
      null
    );
  });

  it('a silent (runtime_judgment-only) branch is adoptable, so the ask gate can be suppressed (flow 3)', () => {
    const silentStep = compileScript([
      {
        stepNumber: 1,
        title: 'Open and Classify',
        branches: [
          {
            branchLabel: 'Cold inbound',
            conditionDescription: 'a greeting or a question',
            actions: [
              A('send_message', 'yo wassup, respect for reaching out!'),
              A('ask_question', 'where you based out of?'),
              A('wait_for_response')
            ]
          },
          {
            branchLabel: 'Solicitation / non-lead',
            conditionDescription: 'a pitch, promotion or bot spam',
            actions: [A('runtime_judgment', 'Send nothing. Do not greet.')]
          }
        ]
      },
      {
        stepNumber: 2,
        title: 'Experience',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always taken',
            actions: [A('ask_question', 'how long?'), A('wait_for_response')]
          }
        ]
      }
    ]);
    const node = nodeForStep(silentStep, 1)!;
    const sel = selectEdge(node, {
      source: 'INBOUND',
      latestLeadText: 'JOIN MY TRADING CHANNEL',
      dataPoints: {},
      judgeLabel: 'Solicitation / non-lead'
    });
    assert.equal(sel.kind, 'edge');
    if (sel.kind !== 'edge') return;
    const adopted = adoptedBranch({
      lockedBranchLabel: null,
      judgeLabel: 'Solicitation / non-lead',
      fsmLabel: sel.edge.branchLabel
    });
    assert.equal(adopted, 'Solicitation / non-lead');
    assert.equal(sel.edge.completion.kind, 'routing_only');
    assert.deepEqual(
      sel.edge.deliverables.filter(
        (d) => d.kind === 'send_message' || d.kind === 'ask'
      ),
      [],
      'a send-nothing branch has no lead-facing copy to require'
    );
  });
});

describe('offer branch preconditions', () => {
  const step = v2[0] as never;

  it('locks YES when an acceptance appears anywhere in the post-offer lead burst', () => {
    const selected = enforceOfferBranchPreconditions({
      step,
      history: [
        {
          sender: 'AI',
          content: 'want me to send you the link?'
        },
        { sender: 'LEAD', content: 'Yessir' },
        {
          sender: 'LEAD',
          content: "I'll start looking into incorporating it frfr"
        }
      ],
      selectedBranch: v2[0].branches[2] as never,
      priorSelectedBranchLabels: []
    });
    assert.equal(selected?.branchLabel, 'YES');
  });

  it('routes a first decline to Hesitant because Soft exit requires Hesitant first', () => {
    const selected = enforceOfferBranchPreconditions({
      step,
      history: [
        { sender: 'AI', content: 'want me to send you the link?' },
        { sender: 'LEAD', content: 'nah not right now' }
      ],
      selectedBranch: v2[0].branches[2] as never,
      priorSelectedBranchLabels: []
    });
    assert.equal(selected?.branchLabel, 'Hesitant');
  });

  it('allows Soft exit after the Hesitant branch already ran', () => {
    const selected = enforceOfferBranchPreconditions({
      step,
      history: [
        { sender: 'AI', content: 'worth a look?' },
        { sender: 'LEAD', content: 'no thanks' }
      ],
      selectedBranch: v2[0].branches[2] as never,
      priorSelectedBranchLabels: ['Hesitant']
    });
    assert.equal(selected?.branchLabel, 'Soft exit');
  });
});

describe('selected branch SEND plus ASK sequence', () => {
  const required = [
    "love to see it, most people don't even take the first step."
  ];
  const asks = ['what got you looking into trading in the first place?'];

  it('inserts a dropped SEND before the emitted ASK', () => {
    const result = enforceSendThenAskSequence({
      bubbles: ['so what got you looking into trading in the first place?'],
      requiredMessages: required,
      scriptedQuestions: asks,
      priorAiMessages: []
    });
    assert.deepEqual(result.bubbles, [
      required[0],
      'so what got you looking into trading in the first place?'
    ]);
    assert.deepEqual(result.injected, required);
  });

  it('does not duplicate a SEND already delivered in this turn or history', () => {
    for (const priorAiMessages of [[], required]) {
      const bubbles =
        priorAiMessages.length === 0 ? [...required, asks[0]] : [asks[0]];
      const result = enforceSendThenAskSequence({
        bubbles,
        requiredMessages: required,
        scriptedQuestions: asks,
        priorAiMessages
      });
      assert.deepEqual(result.bubbles, bubbles);
      assert.deepEqual(result.injected, []);
    }
  });

  it('does not split a combined bubble that already contains SEND plus ASK', () => {
    const combined = `${required[0]} ${asks[0]}`;
    const result = enforceSendThenAskSequence({
      bubbles: [combined],
      requiredMessages: required,
      scriptedQuestions: asks,
      priorAiMessages: []
    });
    assert.deepEqual(result.bubbles, [combined]);
    assert.deepEqual(result.injected, []);
  });

  it('does nothing for a branch without an ASK', () => {
    const result = enforceSendThenAskSequence({
      bubbles: ['model copy'],
      requiredMessages: required,
      scriptedQuestions: [],
      priorAiMessages: []
    });
    assert.deepEqual(result, { bubbles: ['model copy'], injected: [] });
  });
});

// N1c: runtime_judgment is an instruction carrier. It can explicitly request
// silence, but Daniel's reaction branches also use it to require an improvised
// acknowledgement, probe, or transition. Only the first class is suppressed.
describe('explicitly silent branch suppression (N1c)', () => {
  it('danny.6rown and syed_10129: preserves Step 7 Obstacle — React output that must react and probe', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'Default (vague / no clear symptom given)',
          conditionDescription:
            'The lead gave a vague answer or no clear symptom.',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                "React genuinely to whatever they actually said about what's holding them back. If the answer is vague, gently probe for the specific thing."
            }
          ]
        },
        conversationHistory: [{ sender: 'AI' }, { sender: 'LEAD' }]
      }),
      false
    );
  });

  it('richest_puppi: preserves Step 12 Qualification — React output that must acknowledge and advance to the link', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'Qualified (yes they can afford it)',
          conditionDescription: 'The lead qualifies for the next step.',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                'briefly acknowledge they are good with the price, then advance immediately to Send Product Link'
            }
          ]
        },
        conversationHistory: [{ sender: 'LEAD' }]
      }),
      false
    );
  });

  it('preserves a response-required runtime judgment even on a solicitation route', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'Solicitation / non-lead',
          conditionDescription: 'A real person is pitching a service.',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                'Reply with one polite decline, then end the conversation.'
            }
          ]
        },
        conversationHistory: [{ sender: 'LEAD' }]
      }),
      false
    );
  });

  it('aloysx7: keeps Step 8 Urgency runtime judgment plus wait response-bearing and marks its question completion signal', () => {
    const branch = {
      branchLabel: 'Default',
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            'Ask whether now is the right time to overcome their stated obstacle and reach their desired outcome.'
        },
        { actionType: 'wait_for_response', content: '' }
      ]
    };
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch,
        conversationHistory: [{ sender: 'LEAD' }]
      }),
      false
    );
    const shape = getStepActionShape(
      {
        steps: [
          {
            stepNumber: 8,
            actions: [],
            branches: [branch]
          }
        ]
      },
      8
    );
    assert.equal(shape?.hasRuntimeJudgmentWait, true);
    assert.equal(shape?.hasSilentBranch, false);
  });

  it("v2's Solicitation branch compiles to a send-nothing shape with no deliverables", () => {
    const compiled = compileScript([
      {
        stepNumber: 1,
        title: 'Open and Classify',
        branches: [
          {
            branchLabel: 'Cold inbound',
            conditionDescription: 'a greeting',
            actions: [
              A('send_message', 'yo wassup, respect for reaching out!'),
              A('ask_question', 'where you based out of?'),
              A('wait_for_response')
            ]
          },
          {
            branchLabel: 'Solicitation / non-lead',
            conditionDescription: 'a pitch, promotion or bot spam',
            actions: [
              A(
                'runtime_judgment',
                'Send nothing. Do not greet, do not ask location.'
              )
            ]
          }
        ]
      },
      {
        stepNumber: 2,
        title: 'Experience',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always taken',
            actions: [A('ask_question', 'how long?'), A('wait_for_response')]
          }
        ]
      }
    ]);
    const solicitation = nodeForStep(compiled, 1)!.edges.find(
      (e) => e.branchLabel === 'Solicitation / non-lead'
    )!;
    assert.deepEqual(
      solicitation.deliverables.filter(
        (d) => d.kind === 'send_message' || d.kind === 'ask'
      ),
      []
    );
    assert.equal(solicitation.completion.kind, 'routing_only');
  });

  it('does not silence a fresh lead reply routed to a No response branch', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'No response',
          conditionDescription: 'The lead has not replied to the check-in.',
          actions: [
            {
              actionType: 'runtime_judgment',
              content: 'End the script and hand off to follow-up cadence.'
            }
          ]
        },
        conversationHistory: [{ sender: 'AI' }, { sender: 'LEAD' }]
      }),
      false
    );
  });

  it('keeps No response silent when the lead has not replied', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'No response',
          conditionDescription: 'The lead did not reply.',
          actions: [{ actionType: 'runtime_judgment', content: 'End.' }]
        },
        conversationHistory: [{ sender: 'AI' }]
      }),
      true
    );
  });

  it('keeps solicitation branches silent after a lead message', () => {
    assert.equal(
      runtimeJudgmentOnlyBranchShouldStaySilent({
        branch: {
          branchLabel: 'Solicitation / non-lead',
          conditionDescription: 'A pitch, promotion, or bot spam.',
          actions: [
            { actionType: 'runtime_judgment', content: 'Send nothing.' }
          ]
        },
        conversationHistory: [{ sender: 'LEAD' }]
      }),
      true
    );
  });
});
