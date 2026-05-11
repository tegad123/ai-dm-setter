import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { computeSystemStage } from '../../src/lib/script-state-recovery';

const baseStep = {
  stateKey: null,
  recoveryActionType: null,
  canonicalQuestion: null,
  artifactField: null,
  completionRule: null,
  requiredDataPoints: null,
  routingRules: null,
  branches: []
};

function askStep(stepNumber: number, title: string, question: string) {
  return {
    ...baseStep,
    stepNumber,
    title,
    actions: [
      { actionType: 'ask_question', content: question },
      { actionType: 'wait_for_response', content: null }
    ]
  };
}

describe('computeSystemStage generic sequencing', () => {
  const script = {
    id: 'generic_sequence',
    steps: [
      askStep(1, 'Job', 'What do you do for work?'),
      askStep(2, 'Tenure', 'How long have you been doing that?'),
      askStep(3, 'Goal', 'What are you trying to make each month?')
    ]
  } as any;

  it('does not advance null completionRule steps from captured data alone', () => {
    const stage = computeSystemStage(script, {
      workBackground: {
        value: 'nurse',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_1',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:00:00.000Z'
      }
    });

    assert.equal(stage.step?.stepNumber, 1);
  });

  it('advances one step only after the step ask was sent and the lead replied', () => {
    const stage = computeSystemStage(script, {}, [
      {
        sender: 'AI',
        content: 'What do you do for work?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        sender: 'LEAD',
        content: 'I work as a nurse',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ]);

    assert.equal(stage.step?.stepNumber, 2);
  });

  it('caps recomputed position to one step beyond persisted current step', () => {
    const history = [
      {
        sender: 'AI',
        content: 'What do you do for work?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        sender: 'LEAD',
        content: 'I work as a nurse',
        timestamp: new Date('2026-05-11T00:01:00Z')
      },
      {
        sender: 'AI',
        content: 'How long have you been doing that?',
        timestamp: new Date('2026-05-11T00:02:00Z')
      },
      {
        sender: 'LEAD',
        content: '2 years',
        timestamp: new Date('2026-05-11T00:03:00Z')
      }
    ];

    assert.equal(computeSystemStage(script, {}, history).step?.stepNumber, 3);
    assert.equal(
      computeSystemStage(script, {}, history, {
        previousCurrentScriptStep: 1,
        maxAdvanceSteps: 1
      }).step?.stepNumber,
      2
    );
  });

  it('completes [MSG]+[WAIT] steps only after the lead replies', () => {
    const msgWaitScript = {
      id: 'msg_wait_sequence',
      steps: [
        {
          ...baseStep,
          stepNumber: 1,
          title: 'Silent acknowledgment',
          actions: [
            { actionType: 'send_message', content: 'I hear you bro.' },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        askStep(2, 'Next question', 'What happened next?')
      ]
    } as any;

    const noReply = computeSystemStage(msgWaitScript, {}, [
      {
        sender: 'AI',
        content: 'I hear you bro.',
        timestamp: new Date('2026-05-11T00:00:00Z')
      }
    ]);
    const withReply = computeSystemStage(msgWaitScript, {}, [
      {
        sender: 'AI',
        content: 'I hear you bro.',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        sender: 'LEAD',
        content: 'yeah it was rough',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ]);

    assert.equal(noReply.step?.stepNumber, 1);
    assert.equal(withReply.step?.stepNumber, 2);
  });
});
