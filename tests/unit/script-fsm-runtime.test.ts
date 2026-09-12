// M5 items 3–4 — FSM runtime (pure).
// Run: npx tsx --test tests/unit/script-fsm-runtime.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compileScript,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';
import {
  fsmTransition,
  selectEdge,
  nodeForStep
} from '../../src/lib/script-fsm/runtime';
import type { FsmCursor, LeadFacts } from '../../src/lib/script-fsm/types';

const A = (actionType: string, content = '') => ({ actionType, content });
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
          A('ask_question', 'Where are you based?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: "Warm Inbound (DM'd directly — no ManyChat)",
        conditionDescription: 'DMd directly',
        actions: [
          A('send_message', 'yo wassup'),
          A('ask_question', 'Where are you based out of?'),
          A('wait_for_response'),
          A('send_message', "That's awesome, I'm over in here in Texas.")
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
          A('send_message', 'ok great'),
          A('ask_question', 'How long?'),
          A('wait_for_response')
        ]
      },
      {
        branchLabel: 'New to markets',
        conditionDescription: 'new',
        actions: [
          A('send_message', 'love it'),
          A('ask_question', 'Why now?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 3,
    title: 'Qualification — React',
    branches: [
      {
        branchLabel: 'Qualified',
        conditionDescription: 'can afford',
        actions: [A('runtime_judgment', 'ack')]
      },
      {
        branchLabel: 'Not qualified',
        conditionDescription: 'cannot',
        actions: [
          A('send_message', 'no worries'),
          A('wait_for_response'),
          A('runtime_judgment', 'end')
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

describe('fsmTransition', () => {
  const start: FsmCursor = {
    stepNumber: 1,
    selectedBranchLabel: null,
    completedSteps: [],
    compilerVersion: 1
  };
  it('judgment + ask + wait branch completes on the lead reply (Tega item 4)', () => {
    const c1 = fsmTransition(fsm, start, {
      type: 'EDGE_SELECTED',
      branchLabel: 'Default (ManyChat lead — already answered)'
    });
    assert.equal(c1.advanced, false);
    const c2 = fsmTransition(fsm, c1.cursor, {
      type: 'LEAD_REPLIED',
      text: 'Houston'
    });
    assert.equal(c2.advanced, true);
    assert.equal(c2.cursor.stepNumber, 2);
    assert.deepEqual(c2.cursor.completedSteps, [1]);
  });
  it('advances at most one step per event and is monotonic', () => {
    const c = fsmTransition(
      fsm,
      { ...start, stepNumber: 2 },
      { type: 'LEAD_REPLIED', text: 'x' }
    );
    assert.equal(c.cursor.stepNumber, 3);
    const again = fsmTransition(fsm, c.cursor, {
      type: 'LEAD_REPLIED',
      text: 'y'
    });
    // step 3's default is the last branch (judgment after wait) → completes on reply, but it's terminal
    assert.equal(again.advanced, false);
    assert.equal(again.reason, 'terminal');
  });
  it('a routing-only edge advances immediately on selection', () => {
    const c = fsmTransition(
      fsm,
      { ...start, stepNumber: 3 },
      { type: 'EDGE_SELECTED', branchLabel: 'Qualified' }
    );
    assert.equal(c.reason, 'terminal'); // terminal node: nowhere to go, but not stuck
  });
  it('a send-only step needs DELIVERABLES_SENT, not a lead reply', () => {
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
    const a = fsmTransition(only, start, { type: 'LEAD_REPLIED', text: 'hi' });
    assert.equal(a.advanced, false);
    const b = fsmTransition(only, start, { type: 'DELIVERABLES_SENT' });
    assert.equal(b.advanced, true);
    assert.equal(b.cursor.stepNumber, 2);
  });
});
