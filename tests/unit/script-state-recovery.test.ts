import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  computeSystemStage,
  readBranchHistoryEvents
} from '../../src/lib/script-state-recovery';

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

describe('durable per-step branch history', () => {
  const mixedBranchStep = {
    ...baseStep,
    stepNumber: 4,
    title: 'Market Response Routing',
    actions: [],
    branches: [
      {
        branchLabel: 'Generic obstacle ask',
        actions: [
          {
            actionType: 'ask_question',
            content: "What's the main obstacle holding you back?"
          },
          { actionType: 'wait_for_response', content: null }
        ]
      },
      {
        branchLabel: 'Obstacle given — detailed and emotional',
        actions: [
          {
            actionType: 'runtime_judgment',
            content: 'store obstacle'
          },
          {
            actionType: 'send_message',
            content:
              '{{acknowledge in their words. Then add: "give me a bit more context"}}'
          },
          { actionType: 'wait_for_response', content: null }
        ]
      }
    ]
  };
  const jobStep = askStep(
    5,
    'Current Situation — Job',
    'What do you do for work?'
  );
  const step12 = askStep(
    12,
    'Obstacle Identification',
    'What do you feel is holding you back?'
  );
  const step13 = {
    ...baseStep,
    stepNumber: 13,
    title: 'Belief Break',
    actions: [{ actionType: 'send_message', content: 'Belief break copy' }]
  };
  const branchScript = {
    id: 'branch_history_sequence',
    steps: [mixedBranchStep, jobStep, step12, step13]
  } as any;

  it('bug-45-branch-history-persisted', () => {
    const points = {
      branchHistory: [
        {
          eventType: 'branch_selected',
          stepNumber: 4,
          stepTitle: 'Market Response Routing',
          selectedBranchLabel: 'Obstacle given — detailed and emotional',
          suggestionId: 'sug_4',
          aiMessageId: null,
          aiMessageIds: [],
          leadMessageId: 'lead_obstacle',
          sentAt: null,
          completedAt: null,
          createdAt: '2026-05-11T00:00:00.000Z'
        }
      ]
    };

    const stage = computeSystemStage(branchScript, points as any, [
      {
        id: 'ai_step4',
        suggestionId: 'sug_4',
        sender: 'AI',
        content: 'I hear you. give me a bit more context',
        timestamp: '2026-05-11T00:01:00.000Z'
      },
      {
        id: 'lead_step4_reply',
        sender: 'LEAD',
        content: 'I get tilted and keep adding more',
        timestamp: '2026-05-11T00:02:00.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 5);
    const completed = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'step_completed'
    );
    assert.equal(completed?.stepNumber, 4);
    assert.equal(
      completed?.selectedBranchLabel,
      'Obstacle given — detailed and emotional'
    );
    assert.equal(completed?.aiMessageId, 'ai_step4');
    assert.equal(completed?.leadMessageId, 'lead_step4_reply');
  });

  it('bug-46-state-no-rollback', () => {
    const points = {
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber: 12,
          stepTitle: 'Obstacle Identification',
          selectedBranchLabel: 'Default',
          suggestionId: 'sug_12',
          aiMessageId: 'ai_12',
          aiMessageIds: ['ai_12'],
          leadMessageId: 'lead_12',
          sentAt: '2026-05-11T00:11:00.000Z',
          completedAt: '2026-05-11T00:12:00.000Z',
          createdAt: '2026-05-11T00:12:01.000Z'
        }
      ]
    };

    const stage = computeSystemStage(branchScript, points as any, [], {
      previousCurrentScriptStep: 5,
      maxAdvanceSteps: 1
    });

    assert.equal(stage.step?.stepNumber, 13);
    assert.match(stage.reason, /branch_history_floor/);
  });

  it('bug-47-cross-branch-contamination-prevented', () => {
    const points = {
      branchHistory: [
        {
          eventType: 'branch_selected',
          stepNumber: 4,
          stepTitle: 'Market Response Routing',
          selectedBranchLabel: 'Obstacle given — detailed and emotional',
          suggestionId: 'sug_4',
          aiMessageId: null,
          aiMessageIds: [],
          leadMessageId: 'lead_obstacle',
          sentAt: null,
          completedAt: null,
          createdAt: '2026-05-11T00:00:00.000Z'
        }
      ]
    };

    const stage = computeSystemStage(branchScript, points as any, [
      {
        id: 'ai_step12',
        suggestionId: 'sug_12',
        sender: 'AI',
        content: 'What do you feel is holding you back?',
        timestamp: '2026-05-11T00:12:00.000Z'
      },
      {
        id: 'lead_step12',
        sender: 'LEAD',
        content: 'Honestly my biggest issue is emotional control',
        timestamp: '2026-05-11T00:13:00.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 4);
  });

  it('bug-48-fallback-no-history', () => {
    const stage = computeSystemStage(branchScript, {}, [
      {
        id: 'ai_step12',
        suggestionId: 'sug_12',
        sender: 'AI',
        content: 'What do you feel is holding you back?',
        timestamp: '2026-05-11T00:12:00.000Z'
      },
      {
        id: 'lead_step12',
        sender: 'LEAD',
        content: 'Honestly my biggest issue is emotional control',
        timestamp: '2026-05-11T00:13:00.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 5);
  });
});
