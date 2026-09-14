// M5 item 7 — required-ask evaluator (pure).
// Run: npx tsx --test tests/unit/required-ask.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  compileScript,
  type CompilableStep
} from '../../src/lib/script-fsm/compiler';
import { nodeForStep } from '../../src/lib/script-fsm/runtime';
import { evaluateRequiredAsk } from '../../src/lib/state-machine/required-ask';

const A = (actionType: string, content = '') => ({ actionType, content });
// Daniel's steps 10–12 shape (soft-offer react → qualification ask → react).
const script: CompilableStep[] = [
  {
    stepNumber: 10,
    title: 'Soft Offer — React',
    branches: [
      {
        branchLabel: 'YES',
        conditionDescription: 'they said yes',
        actions: [A('runtime_judgment', 'Briefly acknowledge their yes')]
      },
      {
        branchLabel: 'Hesitant / unsure',
        conditionDescription: 'unsure',
        actions: [
          A(
            'send_message',
            'No pressure at all bro, just want to make sure it is the right fit'
          ),
          A(
            'ask_question',
            'Would you at least be open to hearing what it is?'
          ),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 11,
    title: 'Qualification — Ask',
    branches: [
      {
        branchLabel: 'Default',
        conditionDescription: 'always taken',
        actions: [
          A(
            'send_message',
            "For sure bro, to be transparent, it's $200 USD. Nothing crazy, just enough to get your feet wet and really break down execution."
          ),
          A('ask_question', 'Would that be realistic for you?'),
          A('wait_for_response')
        ]
      }
    ]
  },
  {
    stepNumber: 12,
    title: 'Qualification — React',
    branches: [
      {
        branchLabel: 'Qualified (yes they can afford it)',
        conditionDescription: 'yes',
        actions: [A('runtime_judgment', 'Briefly acknowledge')]
      },
      {
        branchLabel: 'Not qualified',
        conditionDescription: 'no',
        actions: [
          A(
            'send_message',
            'No worries bro! I appreciate you being real about it.'
          ),
          A('send_link'),
          A('wait_for_response'),
          A('runtime_judgment', 'End')
        ]
      }
    ]
  }
];
const fsm = compileScript(script);
const s10 = nodeForStep(fsm, 10)!;
const s11 = nodeForStep(fsm, 11)!;
const s12 = nodeForStep(fsm, 12)!;

describe('evaluateRequiredAsk', () => {
  it('the freelance case (conv cmtws66km0003l504a5toczil): step 11 turn without the $200 ask is MISSING', () => {
    const v = evaluateRequiredAsk(
      s11,
      null,
      [
        'bet bro, i got you',
        "what's the main thing you want more help with right now, getting consistency or just understanding the setup better?"
      ],
      ['what if i had something that could genuinely help you out here?']
    );
    assert.equal(v.status, 'missing');
    assert.equal(v.asks[0], 'Would that be realistic for you?');
  });
  it('the scripted ask present (drift-tolerant) is SATISFIED', () => {
    const v = evaluateRequiredAsk(
      s11,
      null,
      [
        "For sure bro, to be transparent, it's $200 USD. Nothing crazy, just enough to get your feet wet and really break down execution.",
        'would that be realistic for you'
      ],
      []
    );
    assert.equal(v.status, 'satisfied');
  });
  it('an ask that already went out earlier in the step is ALREADY_ASKED, not missing', () => {
    const v = evaluateRequiredAsk(
      s11,
      null,
      ['no rush bro, take your time'],
      ['Would that be realistic for you?']
    );
    assert.equal(v.status, 'already_asked');
  });
  it('a routing-only branch has no ask: NOT_APPLICABLE', () => {
    assert.equal(
      evaluateRequiredAsk(s10, 'YES', ['bet bro, i got you'], []).status,
      'not_applicable'
    );
    assert.equal(
      evaluateRequiredAsk(
        s12,
        'Qualified (yes they can afford it)',
        ['love it'],
        []
      ).status,
      'not_applicable'
    );
  });
  it('on a fork with unknown selection, any branch ask satisfies; none present on an ask-branch fork is MISSING', () => {
    const ok = evaluateRequiredAsk(
      s10,
      null,
      ['Would you at least be open to hearing what it is?'],
      []
    );
    assert.equal(ok.status, 'satisfied');
    const miss = evaluateRequiredAsk(s10, null, ['makes sense bro'], []);
    assert.equal(miss.status, 'missing');
  });
  it('an ask under the matcher floor ("Why now?") is NOT_APPLICABLE, never a false missing', () => {
    const tiny = compileScript([
      {
        stepNumber: 1,
        title: 't',
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: 'always',
            actions: [A('ask_question', 'Why now?'), A('wait_for_response')]
          }
        ]
      }
    ]);
    const v = evaluateRequiredAsk(
      nodeForStep(tiny, 1)!,
      null,
      ['so why is now the time for you?'],
      []
    );
    assert.equal(v.status, 'not_applicable');
  });
});
