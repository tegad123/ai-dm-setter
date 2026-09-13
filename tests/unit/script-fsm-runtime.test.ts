// M5 items 3–4 — FSM runtime (pure): edge selection, credit rules, history fold.
// Run: npx tsx --test tests/unit/script-fsm-runtime.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compileScript,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';
import {
  foldHistory,
  fsmTransition,
  initialCursor,
  selectEdge,
  nodeForStep
} from '../../src/lib/script-fsm/runtime';
import type { FsmCursor, LeadFacts } from '../../src/lib/script-fsm/types';

const A = (actionType: string, content = '') => ({ actionType, content });

// Shaped like Daniel's live script (the shadow oracle): step 1 has a
// two-ask warm branch, step 3 forks between an ask+wait branch and a
// routing-only default, step 4 is judgment+wait, step 5 is the soft offer.
const script: CompilableStep[] = [
  {
    stepNumber: 1,
    title: 'Pick Up From ManyChat',
    branches: [
      {
        branchLabel: 'Default (ManyChat lead — already answered)',
        conditionDescription: 'Lead came in through ManyChat',
        actions: [
          A('runtime_judgment', 'read'),
          A('ask_question', 'Where are you currently based out of?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: "Warm Inbound (DM'd directly — no ManyChat)",
        conditionDescription: 'DMd directly',
        actions: [
          A('send_message', 'yo wassup, respect for reaching out bro'),
          A('ask_question', 'Where are you currently based out of?'),
          A('wait_for_response'),
          A('send_message', "That's awesome, I'm over in here in Texas."),
          A(
            'ask_question',
            'So are you new in the markets or been in the game for a while?'
          ),
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
        conditionDescription: 'already trades',
        actions: [
          A(
            'ask_question',
            "Okay great so you're not totally new to the game. How long have you been in the market for?"
          ),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'New to markets',
        conditionDescription: 'new',
        actions: [
          A('send_message', 'Love to see it, most people never even start'),
          A('ask_question', 'So what got you into trading in the first place?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 3,
    title: 'Obstacle — React',
    branches: [
      {
        branchLabel: 'They give a symptom',
        conditionDescription: 'symptom',
        actions: [
          A(
            'send_message',
            "Bro what if I told you 99% of traders that say that don't actually know what the real problem is"
          ),
          A(
            'send_message',
            'What they truly need is to stop treating the surface and dig deeper'
          ),
          A(
            'ask_question',
            'So let me ask you this, when that happens, what do you think is actually causing it?'
          ),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'Default (vague / no clear symptom given)',
        conditionDescription: 'vague',
        actions: [
          A('runtime_judgment', 'React genuinely to whatever they said')
        ]
      }
    ]
  },
  {
    stepNumber: 4,
    title: 'Urgency (Only If Needed)',
    branches: [
      {
        branchLabel: 'Default',
        conditionDescription: 'default',
        actions: [
          A('runtime_judgment', 'Ask whether now is the right time'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'Alternative',
        conditionDescription: 'alt',
        actions: [
          A(
            'ask_question',
            'So why is now so important for you to let go of these obstacles and overcome them bro? why now?'
          ),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 5,
    title: 'Soft Offer — Ask',
    branches: [
      {
        branchLabel: 'Default',
        conditionDescription: 'always taken',
        actions: [
          A('runtime_judgment', 'summarise'),
          A(
            'ask_question',
            'What if I had something that could genuinely help you out here? Would you be interested in that?'
          ),
          A('wait_for_response')
        ]
      }
    ]
  }
];
const fsm = compileScript(script);
const facts = (over: Partial<LeadFacts>): LeadFacts => ({
  source: null,
  latestLeadText: null,
  dataPoints: {},
  judgeLabel: null,
  ...over
});
const LEAD = (content: string) => ({ sender: 'LEAD', content });
const AI = (content: string) => ({ sender: 'AI', content });
const HUMAN = (content: string) => ({ sender: 'HUMAN', content });
const MANYCHAT = (content: string) => ({ sender: 'MANYCHAT', content });

describe('selectEdge', () => {
  const s1 = nodeForStep(fsm, 1)!;
  const s2 = nodeForStep(fsm, 2)!;
  it('routes step 1 by SOURCE, deterministically, ignoring the judge', () => {
    const mc = selectEdge(
      s1,
      facts({
        source: 'MANYCHAT',
        judgeLabel: "Warm Inbound (DM'd directly — no ManyChat)"
      })
    );
    assert.equal(mc.kind, 'edge');
    if (mc.kind === 'edge') {
      assert.match(mc.edge.branchLabel, /^Default \(ManyChat/);
      assert.equal(mc.reason, 'source');
    }
    const inb = selectEdge(
      s1,
      facts({
        source: 'INBOUND',
        judgeLabel: 'Default (ManyChat lead — already answered)'
      })
    );
    assert.equal(inb.kind, 'edge');
    if (inb.kind === 'edge') {
      assert.match(inb.edge.branchLabel, /^Warm/);
      assert.equal(inb.reason, 'source');
    }
  });
  it('unknown source on step 1 falls to the warm default, never null', () => {
    const r = selectEdge(s1, facts({}));
    assert.equal(r.kind, 'edge');
    if (r.kind === 'edge') {
      assert.match(r.edge.branchLabel, /^Warm/);
      assert.equal(r.reason, 'default');
    }
  });
  it('verbatim label match wins outright', () => {
    const r = selectEdge(
      s2,
      facts({
        latestLeadText: 'new to markets',
        judgeLabel: 'Already in markets'
      })
    );
    assert.equal(r.kind, 'edge');
    if (r.kind === 'edge') {
      assert.equal(r.edge.branchLabel, 'New to markets');
      assert.equal(r.reason, 'verbatim');
    }
  });
  it('advisory judge picks among siblings when nothing structural applies', () => {
    const r = selectEdge(
      s2,
      facts({
        latestLeadText: 'been at it 2 years',
        judgeLabel: 'already in markets'
      })
    );
    assert.equal(r.kind, 'edge');
    if (r.kind === 'edge') {
      assert.equal(r.edge.branchLabel, 'Already in markets');
      assert.equal(r.reason, 'judge');
    }
  });
  it('no signal at all → the default edge (implicit last), never a null branch', () => {
    const r = selectEdge(s2, facts({ latestLeadText: 'idk' }));
    assert.equal(r.kind, 'edge');
    if (r.kind === 'edge') {
      assert.equal(r.reason, 'default');
      assert.equal(r.edge.isDefault, true);
    }
  });
  it('a node with no edges is a typed hold', () => {
    const r = selectEdge({ ...s2, edges: [] }, facts({}));
    assert.deepEqual(r, { kind: 'hold', reason: 'no_edges' });
  });
});

describe('fsmTransition credit rules', () => {
  const start: FsmCursor = initialCursor(fsm);
  it('compiles wait counts: warm step-1 branch needs two replies, ManyChat branch one', () => {
    const s1 = nodeForStep(fsm, 1)!;
    const warm = s1.edges.find((e) => /^Warm/.test(e.branchLabel))!;
    const mc = s1.edges.find((e) => /^Default/.test(e.branchLabel))!;
    assert.deepEqual(warm.completion, {
      kind: 'lead_reply_after_ask',
      waits: 2
    });
    assert.deepEqual(mc.completion, { kind: 'lead_reply_after_ask', waits: 1 });
  });
  it("a lead's first message before we spoke credits nothing (cold start / generate-only)", () => {
    const r = fsmTransition(fsm, start, {
      type: 'LEAD_REPLIED',
      text: 'Escape'
    });
    assert.equal(r.advanced, false);
    assert.equal(r.reason, 'reply_before_outbound');
    assert.equal(r.cursor.stepNumber, 1);
  });
  it('judgment + ask + wait branch completes on the reply to OUR ask (Tega item 4)', () => {
    const c1 = fsmTransition(fsm, start, {
      type: 'EDGE_SELECTED',
      branchLabel: 'Default (ManyChat lead — already answered)'
    });
    assert.equal(c1.advanced, false);
    const c2 = fsmTransition(fsm, c1.cursor, {
      type: 'OUTBOUND',
      text: 'Where are you currently based out of?',
      sender: 'AI'
    });
    assert.equal(c2.cursor.spokeInStep, true);
    const c3 = fsmTransition(fsm, c2.cursor, {
      type: 'LEAD_REPLIED',
      text: 'Houston'
    });
    assert.equal(c3.advanced, true);
    assert.equal(c3.cursor.stepNumber, 2);
    assert.deepEqual(c3.cursor.completedSteps, [1]);
  });
  it('a two-wait branch holds after the first credited reply and advances on the second', () => {
    const sel = fsmTransition(fsm, start, {
      type: 'EDGE_SELECTED',
      branchLabel: "Warm Inbound (DM'd directly — no ManyChat)"
    }).cursor;
    const a1 = fsmTransition(fsm, sel, {
      type: 'OUTBOUND',
      text: 'Where are you currently based out of?',
      sender: 'AI'
    }).cursor;
    const r1 = fsmTransition(fsm, a1, {
      type: 'LEAD_REPLIED',
      text: 'Houston'
    });
    assert.equal(r1.advanced, false);
    assert.equal(r1.reason, 'awaiting_more_replies_1_of_2');
    assert.equal(r1.cursor.spokeInStep, false);
    // a double text before we speak again is not a second credit
    const dbl = fsmTransition(fsm, r1.cursor, {
      type: 'LEAD_REPLIED',
      text: 'you?'
    });
    assert.equal(dbl.advanced, false);
    assert.equal(dbl.reason, 'reply_before_outbound');
    const a2 = fsmTransition(fsm, dbl.cursor, {
      type: 'OUTBOUND',
      text: 'So are you new in the markets or been in the game for a while?',
      sender: 'AI'
    }).cursor;
    const r2 = fsmTransition(fsm, a2, { type: 'LEAD_REPLIED', text: 'new' });
    assert.equal(r2.advanced, true);
    assert.equal(r2.cursor.stepNumber, 2);
  });
  it('a routing-only edge advances immediately on selection', () => {
    const c = fsmTransition(
      fsm,
      { ...start, stepNumber: 3 },
      {
        type: 'EDGE_SELECTED',
        branchLabel: 'Default (vague / no clear symptom given)'
      }
    );
    assert.equal(c.advanced, true);
    assert.equal(c.cursor.stepNumber, 4);
  });
  it('a send-only step completes on our outbound, not on a lead reply', () => {
    const only = compileScript([
      {
        stepNumber: 1,
        title: 'link',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always taken',
            actions: [A('send_message', 'here is the link'), A('send_link')]
          }
        ]
      },
      {
        stepNumber: 2,
        title: 'next',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always',
            actions: [A('ask_question', 'q?'), A('wait_for_response')]
          }
        ]
      }
    ]);
    const s = initialCursor(only);
    const a = fsmTransition(only, s, { type: 'LEAD_REPLIED', text: 'hi' });
    assert.equal(a.advanced, false);
    const b = fsmTransition(only, s, {
      type: 'OUTBOUND',
      text: 'here is the link',
      sender: 'AI'
    });
    assert.equal(b.advanced, true);
    assert.equal(b.cursor.stepNumber, 2);
    assert.equal(b.cursor.spokeInStep, true);
  });
  it('is monotonic and terminal-safe', () => {
    const term = { ...start, stepNumber: 5, spokeInStep: true };
    const r = fsmTransition(fsm, term, { type: 'LEAD_REPLIED', text: 'yes' });
    assert.equal(r.advanced, false);
    assert.equal(r.reason, 'terminal');
    assert.equal(r.cursor.stepNumber, 5);
  });
});

describe('foldHistory (position as a pure function of the conversation)', () => {
  it('cold-start warm inbound: first lead message does not advance; both asks answered → step 2', () => {
    const r1 = foldHistory(fsm, [LEAD('Escape')]);
    assert.equal(r1.cursor.stepNumber, 1);
    assert.equal(r1.lastReason, 'reply_before_outbound');
    const r2 = foldHistory(fsm, [
      LEAD('Escape'),
      AI('yo wassup, respect for reaching out bro'),
      AI('Where are you currently based out of?'),
      LEAD('Houston')
    ]);
    assert.equal(r2.cursor.stepNumber, 1);
    assert.equal(
      r2.cursor.selectedBranchLabel,
      "Warm Inbound (DM'd directly — no ManyChat)"
    );
    const r3 = foldHistory(fsm, [
      LEAD('Escape'),
      AI('yo wassup, respect for reaching out bro'),
      AI('Where are you currently based out of?'),
      LEAD('Houston'),
      AI("That's awesome, I'm over in here in Texas."),
      AI('So are you new in the markets or been in the game for a while?'),
      LEAD('new')
    ]);
    assert.equal(r3.cursor.stepNumber, 2);
    assert.deepEqual(
      r3.advances.map((a) => a.to),
      [2]
    );
  });
  it('ManyChat automation rows are not our outbound: the lead reply to them credits nothing', () => {
    const r = foldHistory(fsm, [
      MANYCHAT('are you new or been in the game a while?'),
      LEAD('1 year')
    ]);
    assert.equal(r.cursor.stepNumber, 1);
    assert.equal(r.lastReason, 'reply_before_outbound');
  });
  it('the judge-selected branch comes from the ledger; a reply before the NEXT ask does not advance (Frances, conv cmtyob45n003rl604wqtyaj0f)', () => {
    const history = [
      AI(
        "Bro what if I told you 99% of traders that say that don't actually know what the real problem is"
      ),
      AI(
        'So let me ask you this, when that happens, what do you think is actually causing it?'
      ),
      LEAD('Absolutely!'),
      LEAD('The market is manipulated')
    ];
    const labels = (step: number) =>
      step === 3 ? 'They give a symptom' : null;
    const r = foldHistory(fsm, history, { startStep: 3, labelForStep: labels });
    // step 3 (ask+wait) completed on "Absolutely!" → 4; the second lead text
    // lands at 4 before the urgency ask went out → no credit.
    assert.equal(r.cursor.stepNumber, 4);
    assert.equal(r.lastReason, 'reply_before_outbound');
    const r2 = foldHistory(
      fsm,
      [
        ...history,
        AI(
          'So why is now so important for you to let go of these obstacles and overcome them bro? why now?'
        ),
        LEAD('Which is why learning order flow matters')
      ],
      { startStep: 3, labelForStep: labels }
    );
    assert.equal(r2.cursor.stepNumber, 5);
  });
  it('infers the delivered branch from copy when the ledger has no selection', () => {
    const r = foldHistory(
      fsm,
      [
        AI(
          "Bro what if I told you 99% of traders that say that don't actually know what the real problem is"
        ),
        LEAD('hmm')
      ],
      { startStep: 3 }
    );
    assert.equal(r.cursor.stepNumber, 4);
    assert.equal(r.advances[0]?.reason, 'lead_reply_after_ask');
  });
  it('routing-only default passes through on our outbound and carries spoke into the next step', () => {
    const r = foldHistory(
      fsm,
      [AI('makes sense, a lot of people feel that way'), LEAD('yeah')],
      { startStep: 3 }
    );
    // outbound at 3 matched no branch copy → default (routing-only) → 4 with spoke carried; the reply credits step 4 (1 wait) → 5
    assert.deepEqual(
      r.advances.map((a) => `${a.from}>${a.to}`),
      ['3>4', '4>5']
    );
  });
  it('a human operator message counts as our outbound', () => {
    const r = foldHistory(fsm, [
      LEAD('hey'),
      HUMAN('Where are you currently based out of?'),
      LEAD('Houston')
    ]);
    assert.equal(r.cursor.repliesInStep, 1);
    assert.equal(r.cursor.stepNumber, 1);
  });
});
