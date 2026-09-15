// M5 items 2–4 — script compiler (pure).
// Run: npx tsx --test tests/unit/script-fsm.test.ts

import { strict as assert } from 'node:assert';
import { selectEdge } from '../../src/lib/script-fsm/runtime';
import { describe, it } from 'node:test';

import {
  compileScript,
  deriveCompletion,
  hasCompileErrors,
  formatCompileErrors,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';

const A = (
  actionType: string,
  content = '',
  extra: Record<string, unknown> = {}
) => ({
  actionType,
  content,
  ...extra
});

// A faithful reduction of the daetradez "DAE — AI DM Setter Script" (14 steps
// in prod; the shapes that matter are steps 1, 2, 3, 11, 12).
const dae: CompilableStep[] = [
  {
    stepNumber: 1,
    title: 'Pick Up From ManyChat',
    branches: [
      {
        branchLabel: 'Default (ManyChat lead — already answered)',
        conditionDescription:
          'Lead came in through the ManyChat flow and has already replied to the opener',
        actions: [
          A('runtime_judgment', 'Read their ManyChat reply. Classify.'),
          A('ask_question', 'Where are you based?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: "Warm Inbound (DM'd directly — no ManyChat)",
        conditionDescription:
          'Lead DMd the account directly with no ManyChat history',
        actions: [
          A('send_message', 'yo wassup, respect for reaching out!'),
          A('ask_question', 'Where are you currently based out of?'),
          A('wait_for_response'),
          A('send_message', "That's awesome, I'm over in here in Texas."),
          A('ask_question', 'Are you totally new to trading?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 2,
    title: 'Experience Branch',
    branches: [
      {
        branchLabel: 'Already in markets',
        conditionDescription: "Lead's reply says they already trade",
        actions: [
          A(
            'send_message',
            'Okay great so you are not totally new to the game.'
          ),
          A('ask_question', 'How long have you been in?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'New to markets',
        conditionDescription: "Lead's reply says they are new",
        actions: [
          A('send_message', 'Love that you are starting fresh.'),
          A('ask_question', 'What made you want to start?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 3,
    title: 'Current Situation — Ask',
    branches: [
      {
        branchLabel: 'Default',
        conditionDescription:
          'Always taken on entry to this step — asks the lead what they do',
        actions: [
          A('ask_question', 'What do you do for work right now?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 4,
    title: 'Qualification — Ask',
    branches: [
      {
        branchLabel: 'Default',
        conditionDescription:
          'Always taken on entry — states the $200 USD price',
        actions: [
          A(
            'send_message',
            'For sure bro — to be transparent, it is $200 USD.'
          ),
          A('ask_question', 'Would that be realistic for you?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 5,
    title: 'Qualification — React',
    branches: [
      {
        branchLabel: 'Qualified (yes they can afford it)',
        conditionDescription:
          "Lead's response confirms they can afford the $200",
        actions: [A('runtime_judgment', 'Briefly acknowledge')]
      },
      {
        branchLabel: "Not qualified (can't afford the price)",
        conditionDescription: "Lead's response says they cannot afford",
        actions: [
          A('send_message', 'No worries bro!'),
          A('send_link'),
          A('wait_for_response'),
          A('runtime_judgment', 'End of script.')
        ]
      }
    ]
  }
];

describe('compileScript on a daetradez-shaped script', () => {
  const fsm = compileScript(dae);
  it('compiles every step into a node, in order, terminal last', () => {
    assert.equal(fsm.nodes.length, 5);
    assert.deepEqual(
      fsm.nodes.map((n) => n.stepNumber),
      [1, 2, 3, 4, 5]
    );
    assert.equal(fsm.nodes[4].isTerminal, true);
    assert.equal(fsm.entryNodeId, 'step-1');
  });
  it('has NO compile errors (daetradez must compile clean)', () => {
    assert.deepEqual(formatCompileErrors(fsm), []);
    assert.equal(hasCompileErrors(fsm), false);
  });
  it('step 1 is source-routed: pick-up = MANYCHAT, warm = INBOUND/OUTBOUND, warm is the default', () => {
    const s1 = fsm.nodes[0];
    const pick = s1.edges.find((e) =>
      e.branchLabel.startsWith('Default (ManyChat')
    )!;
    const warm = s1.edges.find((e) => e.branchLabel.startsWith('Warm'))!;
    assert.equal(pick.derivedFrom, 'source');
    assert.deepEqual(pick.predicate, { op: 'source_is', source: 'MANYCHAT' });
    assert.equal(warm.derivedFrom, 'source');
    assert.equal(warm.isDefault, true);
    assert.equal(pick.isDefault, false);
  });
  it('step 1 pick-up branch completes on the lead reply (judgment + ask + wait)', () => {
    const pick = fsm.nodes[0].edges[0];
    assert.equal(pick.completion.kind, 'lead_reply_after_ask');
  });
  it('a lone "Always taken on entry" branch is unconditional', () => {
    const s3 = fsm.nodes[2];
    assert.equal(s3.edges.length, 1);
    assert.deepEqual(s3.edges[0].predicate, { op: 'always' });
    assert.equal(s3.edges[0].isDefault, true);
  });
  it('judge-classified siblings get verbatim-label + advisory-judge predicates and an implicit default (warning, not error)', () => {
    const s2 = fsm.nodes[1];
    assert.equal(
      s2.edges.every((e) => e.derivedFrom === 'judge'),
      true
    );
    assert.deepEqual(s2.edges[0].predicate, {
      op: 'or',
      clauses: [
        { op: 'verbatim_label', label: 'Already in markets' },
        { op: 'judge_label_is', label: 'Already in markets' }
      ]
    });
    assert.equal(s2.edges.filter((e) => e.isDefault).length, 1);
    const warn = fsm.diagnostics.find(
      (d) => d.code === 'implicit_default' && d.stepNumber === 2
    );
    assert.ok(warn, 'implicit default is surfaced as a warning');
  });
  it('the "can\'t afford" branch with judgment after a wait is judgment_after_wait; the judgment-only branch is routing_only', () => {
    const s5 = fsm.nodes[4];
    const q = s5.edges.find((e) => e.branchLabel.startsWith('Qualified'))!;
    const nq = s5.edges.find((e) => e.branchLabel.startsWith('Not'))!;
    assert.equal(q.completion.kind, 'routing_only');
    assert.equal(nq.completion.kind, 'judgment_after_wait');
  });
});

describe('validator rejects broken scripts with readable errors', () => {
  it('ask without a wait', () => {
    const fsm = compileScript([
      {
        stepNumber: 1,
        title: 'x',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: null,
            actions: [A('ask_question', 'Where are you based?')]
          }
        ]
      }
    ]);
    assert.equal(hasCompileErrors(fsm), true);
    assert.match(formatCompileErrors(fsm)[0], /never waits for the reply/);
  });
  it('duplicate branch labels', () => {
    const fsm = compileScript([
      {
        stepNumber: 1,
        title: 'x',
        branches: [
          {
            branchLabel: 'Yes',
            conditionDescription: null,
            actions: [A('send_message', 'a'), A('wait_for_response')]
          },
          {
            branchLabel: 'yes',
            conditionDescription: null,
            actions: [A('send_message', 'b'), A('wait_for_response')]
          }
        ]
      }
    ]);
    assert.ok(formatCompileErrors(fsm).some((m) => /labelled "yes"/.test(m)));
  });
  it('empty step', () => {
    const fsm = compileScript([
      {
        stepNumber: 1,
        title: 'nothing',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: null,
            actions: [A('wait_for_response')]
          }
        ]
      }
    ]);
    assert.ok(
      formatCompileErrors(fsm).some((m) => /could never act on it/.test(m))
    );
  });
  it('no steps', () => {
    assert.equal(hasCompileErrors(compileScript([])), true);
  });
});

describe('deriveCompletion', () => {
  it('maps action shapes to completion specs', () => {
    assert.equal(
      deriveCompletion([A('ask_question', 'q'), A('wait_for_response')]).kind,
      'lead_reply_after_ask'
    );
    assert.equal(
      deriveCompletion([A('runtime_judgment', 'j'), A('wait_for_response')])
        .kind,
      'judgment_after_wait'
    );
    assert.equal(
      deriveCompletion([A('runtime_judgment', 'j')]).kind,
      'routing_only'
    );
    assert.equal(
      deriveCompletion([A('send_message', 'm'), A('send_link')]).kind,
      'send_only'
    );
  });
});

describe('step-1 routing mode (v1 source-routed vs v2 content-routed)', () => {
  const A2 = (actionType: string, content = '') => ({ actionType, content });
  it('Daniel v2: content-keyed first step gets NO source predicates; every branch is judge/verbatim-routed', () => {
    const fsm = compileScript([
      {
        stepNumber: 1,
        title: 'Open and Classify',
        branches: [
          {
            branchLabel: 'Already answered',
            conditionDescription:
              'The lead\'s first message already states their experience level or intent. Examples: "starting", "brand new", "I\'m in the markets"',
            actions: [
              A2('runtime_judgment', 'Classify'),
              A2(
                'ask_question',
                'yo wassup, respect for reaching out 🙏🏽 where you based out of?'
              ),
              A2('wait_for_response')
            ]
          },
          {
            branchLabel: 'Cold inbound',
            conditionDescription:
              'The lead DMd with a greeting, a compliment, a question, or anything that shows real interest but does not yet state their experience level.',
            actions: [
              A2(
                'send_message',
                "yo wassup, respect for reaching out! let's see if I can help you out here"
              ),
              A2('ask_question', 'where you based out of?'),
              A2('wait_for_response')
            ]
          },
          {
            branchLabel: 'Solicitation / non-lead',
            conditionDescription: 'The message is a pitch, promotion, bot spam',
            actions: [A2('runtime_judgment', 'Send nothing.')]
          },
          {
            branchLabel: 'Distress',
            conditionDescription:
              'The lead describes financial crisis, total loss of capital',
            actions: [
              A2('runtime_judgment', 'One short human line'),
              A2('runtime_judgment', 'Flag for human review.')
            ]
          },
          {
            branchLabel: 'No signal',
            conditionDescription:
              'The message carries no answerable content: a lone emoji, "[Image]"',
            actions: [
              A2(
                'ask_question',
                "yo what's good bro, what you tryna figure out?"
              ),
              A2('wait_for_response')
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
            actions: [
              A2('ask_question', 'how long you been in the markets?'),
              A2('wait_for_response')
            ]
          }
        ]
      }
    ]);
    const s1 = fsm.nodes[0];
    assert.equal(
      s1.edges.some((e) => JSON.stringify(e.predicate).includes('source_is')),
      false,
      'no source predicates on a content-keyed step 1'
    );
    // The judge (advisory) decides: with judgeLabel "Already answered" that branch wins over Cold inbound.
    const pick = selectEdge(s1, {
      source: 'INBOUND',
      latestLeadText: 'brand new to trading',
      dataPoints: {},
      judgeLabel: 'Already answered'
    });
    assert.equal(pick.kind, 'edge');
    if (pick.kind === 'edge')
      assert.equal(pick.edge.branchLabel, 'Already answered');
  });
  it('Daniel v1: a first step that names ManyChat keeps source routing', () => {
    const fsm = compileScript([
      {
        stepNumber: 1,
        title: 'Pick Up From ManyChat',
        branches: [
          {
            branchLabel: 'Default (ManyChat lead — already answered)',
            conditionDescription: 'Lead came in through ManyChat',
            actions: [
              A2('runtime_judgment', 'read'),
              A2('ask_question', 'Where are you currently based out of?'),
              A2('wait_for_response')
            ]
          },
          {
            branchLabel: "Warm Inbound (DM'd directly — no ManyChat)",
            conditionDescription: 'DMd directly',
            actions: [
              A2('send_message', 'yo wassup'),
              A2('ask_question', 'Where are you currently based out of?'),
              A2('wait_for_response')
            ]
          }
        ]
      },
      {
        stepNumber: 2,
        title: 'x',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always taken',
            actions: [A2('ask_question', 'q?'), A2('wait_for_response')]
          }
        ]
      }
    ]);
    assert.equal(
      fsm.nodes[0].edges.some((e) =>
        JSON.stringify(e.predicate).includes('source_is')
      ),
      true
    );
  });
});
