import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  applyConditionalStepSkip,
  computeSystemStage,
  extractCapturedDataPointsForTest,
  parseConditionalStepSkipDirectives,
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

  it('bug-X-booking-info-complete: skips missing-info follow-up when all booking fields are present', () => {
    const bookingScript = {
      id: 'booking_sequence',
      steps: [
        {
          ...baseStep,
          stepNumber: 20,
          title: 'Collect booking info',
          actions: [
            {
              actionType: 'send_message',
              content:
                'Drop me your full name, email, phone number, your timezone, and what day and time works best.'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          ...baseStep,
          stepNumber: 21,
          title: 'Missing info follow-up',
          actions: [
            {
              actionType: 'runtime_judgment',
              content:
                'If full name, email, phone, timezone, and day/time are present, proceed to the next step. Otherwise ask for the missing info.'
            },
            {
              actionType: 'send_message',
              content:
                'Appreciate that bro, just missing your {{specific missing info e.g. "email" / "timezone" / "phone number"}}.'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        askStep(22, 'Confirmation', 'Does that time still work?')
      ]
    } as any;
    const points = {
      fullName: {
        value: 'Tega Umukoro',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:01:00.000Z'
      },
      email: {
        value: 'tegad8@gmail.com',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:01:00.000Z'
      },
      phone: {
        value: '346-295-4688',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:01:00.000Z'
      },
      timezone: {
        value: 'CT',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:01:00.000Z'
      },
      dayAndTime: {
        value: 'wed at 2pm',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:01:00.000Z'
      }
    };
    const stage = computeSystemStage(
      bookingScript,
      points as any,
      [
        {
          id: 'ai_booking',
          sender: 'AI',
          content:
            'Drop me your full name, email, phone number, your timezone, and what day and time works best.',
          timestamp: new Date('2026-05-11T00:00:00Z')
        },
        {
          id: 'lead_booking',
          sender: 'LEAD',
          content:
            'Tega Umukoro, tegad8@gmail.com, 346-295-4688, CT, wed at 2pm',
          timestamp: new Date('2026-05-11T00:01:00Z')
        }
      ],
      {
        previousCurrentScriptStep: 20,
        maxAdvanceSteps: 1
      }
    );

    assert.equal(stage.step?.stepNumber, 22);
    assert.ok(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' &&
          event.stepNumber === 21 &&
          event.stepCompletionReason ===
            'booking_info_complete_skip_missing_info_followup'
      )
    );
  });

  it('bug-X-booking-info-complete: survives durable floor after older stale branch events', () => {
    const bookingScript = {
      id: 'booking_sequence_with_stale_prior_step',
      steps: [
        askStep(16, 'Older stale proposal step', 'Are you ready for the call?'),
        {
          ...baseStep,
          stepNumber: 20,
          title: 'Collect booking info',
          actions: [
            {
              actionType: 'send_message',
              content:
                'Drop me your full name, email, phone number, your timezone, and what day and time works best.'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          ...baseStep,
          stepNumber: 21,
          title: 'Missing Info Follow-Up',
          actions: [],
          branches: [
            {
              branchLabel: 'Default',
              conditionDescription: null,
              actions: [
                {
                  actionType: 'runtime_judgment',
                  content:
                    'Check their reply for all five: name, email, phone number, timezone, and day/time. If any are missing, ask for the specific one(s) they left out.'
                },
                {
                  actionType: 'send_message',
                  content:
                    'Appreciate that bro, just missing your {{specific missing info e.g. "email" / "timezone" / "phone number"}}.'
                },
                { actionType: 'wait_for_response', content: null },
                {
                  actionType: 'runtime_judgment',
                  content: 'Once all five are collected → proceed to STEP 22.'
                }
              ]
            }
          ]
        },
        askStep(22, 'Confirmation', 'Does that time still work?')
      ]
    } as any;
    const points = {
      branchHistory: [
        {
          eventType: 'branch_selected',
          stepNumber: 16,
          stepTitle: 'Older stale proposal step',
          selectedBranchLabel: 'Default',
          suggestionId: 'stale_suggestion',
          aiMessageId: null,
          aiMessageIds: [],
          leadMessageId: 'old_lead',
          sentAt: null,
          completedAt: null,
          createdAt: '2026-05-11T00:00:00.000Z'
        },
        {
          eventType: 'step_completed',
          stepNumber: 20,
          stepTitle: 'Collect booking info',
          selectedBranchLabel: null,
          suggestionId: null,
          aiMessageId: 'ai_booking',
          aiMessageIds: ['ai_booking'],
          leadMessageId: 'lead_booking',
          sentAt: '2026-05-11T00:10:00.000Z',
          completedAt: '2026-05-11T00:11:00.000Z',
          createdAt: '2026-05-11T00:11:01.000Z'
        }
      ],
      fullName: {
        value: 'Tega Umukoro',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:11:00.000Z'
      },
      email: {
        value: 'tegad8@gmail.com',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:11:00.000Z'
      },
      phone: {
        value: '346-295-4688',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:11:00.000Z'
      },
      timezone: {
        value: 'CT',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:11:00.000Z'
      },
      dayAndTime: {
        value: 'wed at 2pm',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_booking',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:11:00.000Z'
      }
    };

    const stage = computeSystemStage(bookingScript, points as any, [], {
      previousCurrentScriptStep: 20,
      maxAdvanceSteps: 1
    });

    assert.equal(stage.step?.stepNumber, 22);
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

  it('bug-49-volunteered-tenure-extracted-from-experience-reply', () => {
    const points = extractCapturedDataPointsForTest({
      history: [
        {
          id: 'ai_step1',
          sender: 'AI',
          content:
            'So are you new in the markets or have you been trading for a while?',
          timestamp: new Date('2026-05-11T00:00:00Z')
        },
        {
          id: 'lead_step1',
          sender: 'LEAD',
          content: 'yes been at it about a year',
          timestamp: new Date('2026-05-11T00:01:00Z')
        }
      ]
    });

    assert.equal(
      (points.tradingExperienceDuration as any)?.value,
      'about a year'
    );
    assert.equal(
      (points.tradingExperienceDuration as any)?.extractedFromMessageId,
      'lead_step1'
    );
  });

  it('bug-50-volunteered-data-auto-completes-next-ask-step', () => {
    const experienceScript = {
      id: 'experience_sequence',
      steps: [
        askStep(
          1,
          'Intro',
          'So are you new in the markets or have you been trading for a while?'
        ),
        {
          ...baseStep,
          stepNumber: 2,
          title: 'Experience Depth',
          actions: [],
          branches: [
            {
              branchLabel: 'Already in markets',
              actions: [
                {
                  actionType: 'send_message',
                  content: "Okay great so you're not totally new."
                },
                {
                  actionType: 'ask_question',
                  content: 'How long have you been in the markets for?'
                },
                { actionType: 'wait_for_response', content: null }
              ]
            },
            {
              branchLabel: 'New to markets',
              actions: [
                {
                  actionType: 'send_message',
                  content: "Love to see it bro, that's a first step."
                },
                {
                  actionType: 'ask_question',
                  content:
                    'So what got you interested in trading in the first place?'
                },
                { actionType: 'wait_for_response', content: null }
              ]
            }
          ]
        },
        askStep(3, 'Job Context', 'What do you do for work?')
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content:
          'So are you new in the markets or have you been trading for a while?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'yes been at it about a year',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({ history });
    const stage = computeSystemStage(experienceScript, points as any, history, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    });

    assert.equal(stage.step?.stepNumber, 3);
    const completion = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'step_completed' && event.stepNumber === 2
    );
    assert.equal(
      completion?.stepCompletionReason,
      'volunteered_data_auto_complete'
    );
    assert.equal(completion?.selectedBranchLabel, 'Already in markets');
    assert.equal(completion?.leadMessageId, 'lead_step1');
  });

  it('bug-52-volunteered-job-tenure-auto-completes-next-ask-step', () => {
    const workScript = {
      id: 'work_tenure_sequence',
      steps: [
        askStep(1, 'Work Background', 'What do you do for work?'),
        {
          ...baseStep,
          stepNumber: 2,
          title: 'Work Tenure',
          actions: [
            {
              actionType: 'send_message',
              content: 'I respect that bro, that is not easy work.'
            },
            {
              actionType: 'ask_question',
              content: 'How long you been doing that?'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        askStep(
          3,
          'Monthly Income',
          'How much is your job bringing in on a monthly basis?'
        )
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content: 'What do you do for work?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'i work in retail management, been doing it 4 years',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({
      history,
      script: workScript
    });
    const stage = computeSystemStage(workScript, points as any, history, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    });

    assert.equal((points.workDuration as any)?.value, '4 years');
    assert.equal(
      (points.workDuration as any)?.extractionMethod,
      'volunteered_workDuration_for_upcoming_ask'
    );
    assert.equal((points.monthlyIncome as any)?.value, undefined);
    assert.equal(stage.step?.stepNumber, 3);

    const completion = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'step_completed' && event.stepNumber === 2
    );
    assert.equal(
      completion?.stepCompletionReason,
      'volunteered_data_auto_complete'
    );
    assert.equal(completion?.leadMessageId, 'lead_step1');
  });

  it('bug-006-regression-auto-completes-work-tenure-from-aliased-captured-key', () => {
    const workScript = {
      id: 'work_tenure_alias_sequence',
      steps: [
        askStep(1, 'Work Background', 'What do you do for work?'),
        askStep(2, 'Work Tenure', 'How long you been doing that?'),
        askStep(
          3,
          'Monthly Income',
          'How much is your job bringing in on a monthly basis?'
        )
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content: 'What do you do for work?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'i work in retail, been doing it about 3 years',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = {
      tenureInYears: {
        value: 'about 3 years',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_step1',
        extractionMethod: 'runtime_judgment_alias',
        extractedAt: '2026-05-11T00:01:00.000Z',
        sourceFieldName: 'tenureInYears',
        sourceStepNumber: 1
      }
    };

    const stage = computeSystemStage(workScript, points as any, history, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    });

    assert.equal(stage.step?.stepNumber, 3);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' &&
          event.stepNumber === 2 &&
          event.stepCompletionReason === 'volunteered_data_auto_complete'
      ),
      true
    );
  });

  it('bug-006-regression-persona-b-work-answer-skips-step-6-to-income-step', () => {
    const workScript = {
      id: 'persona_b_work_sequence',
      steps: [
        {
          ...baseStep,
          stepNumber: 5,
          title: 'Work Background',
          actions: [
            {
              actionType: 'send_message',
              content: 'alright so give me a bit of context bro.'
            },
            {
              actionType: 'ask_question',
              content:
                'what do you do for work? just so i get a better understanding of your current situation.'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        {
          ...baseStep,
          stepNumber: 6,
          title: 'Work Tenure',
          actions: [
            {
              actionType: 'send_message',
              content:
                "yeah i feel you, i mean i'm not an expert in their field haha but i do know it's quite different than trading man."
            },
            {
              actionType: 'ask_question',
              content: 'How long you been doing that?'
            },
            { actionType: 'wait_for_response', content: null }
          ]
        },
        askStep(
          7,
          'Monthly Income',
          'And as of right now, how much is your job bringing in on a monthly basis?'
        )
      ]
    } as any;
    const history = [
      {
        id: 'ai_step5',
        sender: 'AI',
        content:
          'alright so give me a bit of context bro.\n\nwhat do you do for work? just so i get a better understanding of your current situation.',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step5',
        sender: 'LEAD',
        content: 'i work in retail, been doing it about 3 years',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({
      history,
      script: workScript
    });

    const stage = computeSystemStage(workScript, points as any, history, {
      previousCurrentScriptStep: 5,
      maxAdvanceSteps: 1
    });

    assert.equal((points.workDuration as any)?.value, 'about 3 years');
    assert.equal(stage.step?.stepNumber, 7);
  });

  it('bug-008-regression-does-not-auto-complete-multi-branch-routing-step-with-silent-branch', () => {
    const routingScript = {
      id: 'persona_b_market_routing_sequence',
      steps: [
        askStep(
          3,
          'Market Assessment',
          'Nice, so how have the markets been treating you so far? Any main problems coming up?'
        ),
        {
          ...baseStep,
          stepNumber: 4,
          title: 'Market Response Routing',
          actions: [],
          branches: [
            {
              branchLabel: 'Going badly — vague',
              actions: [
                {
                  actionType: 'send_message',
                  content: 'Gotcha, I appreciate you being real about that.'
                },
                {
                  actionType: 'ask_question',
                  content:
                    'What would you say is the main obstacle stopping you from getting where you want to be?'
                },
                { actionType: 'wait_for_response', content: null }
              ]
            },
            {
              branchLabel: 'Obstacle given — detailed and emotional',
              actions: [
                {
                  actionType: 'runtime_judgment',
                  content: 'Store as {{obstacle}}.'
                },
                {
                  actionType: 'send_message',
                  content:
                    '{{acknowledge specifically what they said using their own words}}'
                },
                { actionType: 'wait_for_response', content: null }
              ]
            }
          ]
        },
        askStep(
          5,
          'Current Situation — Job',
          'What do you do for work? Just so I get a better understanding of your current situation.'
        )
      ]
    } as any;
    const history = [
      {
        id: 'ai_step3',
        sender: 'AI',
        content:
          'Nice, so how have the markets been treating you so far? Any main problems coming up?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step3',
        sender: 'LEAD',
        content:
          'honestly its been brutal, i keep blowing my small accounts revenge trading',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = {
      obstacle: {
        value: 'revenge trading',
        confidence: 'HIGH',
        extractedFromMessageId: 'lead_step3',
        extractionMethod: 'runtime_judgment',
        extractedAt: '2026-05-11T00:01:00.000Z',
        sourceFieldName: 'obstacle',
        sourceStepNumber: 3
      }
    };

    const stage = computeSystemStage(routingScript, points as any, history, {
      previousCurrentScriptStep: 3,
      maxAdvanceSteps: 1
    });

    assert.equal(stage.step?.stepNumber, 4);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' && event.stepNumber === 4
      ),
      false
    );
  });

  it('bug-53-current-income-answer-does-not-populate-target-income-goal', () => {
    const incomeScript = {
      id: 'income_semantics_sequence',
      steps: [
        askStep(
          1,
          'Monthly Income',
          'How much is your job bringing in on a monthly basis?'
        ),
        askStep(
          2,
          'Replace vs Supplement',
          'Are you thinking of replacing your job completely with trading or just generating some extra income on the side?'
        ),
        askStep(
          3,
          'Target Trading Income',
          'How much would you need to be making from trading for it to actually matter?'
        ),
        askStep(4, 'Deep Why', 'Why does that number matter to you?')
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content: 'How much is your job bringing in on a monthly basis?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: '3k a month',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({
      history,
      script: incomeScript
    });
    const stage = computeSystemStage(incomeScript, points as any, history, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    });

    assert.equal((points.monthlyIncome as any)?.value, 3000);
    assert.equal((points.incomeGoal as any)?.value, undefined);
    assert.equal(stage.step?.stepNumber, 2);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' && event.stepNumber === 3
      ),
      false
    );
  });

  it('bug-58-target-income-must-be-captured-by-its-own-ask', () => {
    const goalScript = {
      id: 'target_income_volunteered_sequence',
      steps: [
        askStep(
          1,
          'Replace vs Supplement',
          'Are you replacing your job or just looking for extra income on the side?'
        ),
        askStep(
          2,
          'Target Trading Income',
          "And is that how much you'd need if you ever wanted to replace your current income, or how far away would that be?"
        ),
        askStep(3, 'Deep Why', 'Why does that number matter to you?')
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content:
          'Are you replacing your job or just looking for extra income on the side?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'replace it, I need trading to bring in 8k a month',
        timestamp: new Date('2026-05-11T00:01:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({
      history,
      script: goalScript
    });
    const stage = computeSystemStage(goalScript, points as any, history, {
      previousCurrentScriptStep: 1,
      maxAdvanceSteps: 1
    });

    assert.equal((points.replaceOrSupplement as any)?.value, 'replace');
    assert.equal(
      (points.incomeGoal as any)?.value,
      undefined,
      'Step 8 context must not populate the target income field'
    );
    assert.equal(stage.step?.stepNumber, 2);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' && event.stepNumber === 2
      ),
      false
    );
  });

  it('bug-58-step-9-income-goal-ask-completes-after-its-own-answer', () => {
    const goalScript = {
      id: 'target_income_own_ask_sequence',
      steps: [
        askStep(
          1,
          'Replace vs Supplement',
          'Are you replacing your job or just looking for extra income on the side?'
        ),
        askStep(
          2,
          'Target Trading Income',
          'How much would you need to be making from trading for it to actually matter?'
        ),
        askStep(3, 'Deep Why', 'Why does that number matter to you?')
      ]
    } as any;
    const history = [
      {
        id: 'ai_step1',
        sender: 'AI',
        content:
          'Are you replacing your job or just looking for extra income on the side?',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'just extra on the side',
        timestamp: new Date('2026-05-11T00:01:00Z')
      },
      {
        id: 'ai_step2',
        sender: 'AI',
        content:
          'How much would you need to be making from trading for it to actually matter?',
        timestamp: new Date('2026-05-11T00:02:00Z')
      },
      {
        id: 'lead_step2',
        sender: 'LEAD',
        content: '4k a month',
        timestamp: new Date('2026-05-11T00:03:00Z')
      }
    ];
    const points = extractCapturedDataPointsForTest({
      history,
      script: goalScript
    });
    const stage = computeSystemStage(goalScript, points as any, history, {
      previousCurrentScriptStep: 2,
      maxAdvanceSteps: 1
    });

    assert.equal((points.incomeGoal as any)?.value, 4000);
    assert.equal((points.incomeGoal as any)?.sourceStepNumber, 2);
    assert.equal(
      (points.incomeGoal as any)?.extractionMethod,
      'amount_after_step_9_prompt'
    );
    assert.equal(stage.step?.stepNumber, 3);
  });

  it('bug-51-volunteered-data-does-not-skip-when-captured-before-the-cursor', () => {
    const staleDataScript = {
      id: 'stale_volunteered_data_sequence',
      steps: [
        askStep(1, 'Intro', 'Are you already trading?'),
        askStep(2, 'Experience Depth', 'How long have you been trading?'),
        askStep(3, 'Job Context', 'What do you do for work?')
      ]
    } as any;
    const points = {
      tradingExperienceDuration: {
        value: 'about a year',
        confidence: 'HIGH',
        extractedFromMessageId: 'old_lead',
        extractionMethod: 'test',
        extractedAt: '2026-05-11T00:00:00.000Z'
      }
    };
    const history = [
      {
        id: 'old_lead',
        sender: 'LEAD',
        content: 'about a year',
        timestamp: new Date('2026-05-11T00:00:00Z')
      },
      {
        id: 'ai_step1',
        sender: 'AI',
        content: 'Are you already trading?',
        timestamp: new Date('2026-05-11T00:01:00Z')
      },
      {
        id: 'lead_step1',
        sender: 'LEAD',
        content: 'yeah',
        timestamp: new Date('2026-05-11T00:02:00Z')
      }
    ];

    const stage = computeSystemStage(staleDataScript, points as any, history);

    assert.equal(stage.step?.stepNumber, 2);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) =>
          event.eventType === 'step_completed' && event.stepNumber === 2
      ),
      false
    );
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

describe('routing-only branch completion', () => {
  function branchSelectedPoints(
    stepNumber: number,
    stepTitle: string,
    selectedBranchLabel: string,
    suggestionId = `sug_${stepNumber}`
  ) {
    return {
      branchHistory: [
        {
          eventType: 'branch_selected',
          stepNumber,
          stepTitle,
          selectedBranchLabel,
          suggestionId,
          aiMessageId: null,
          aiMessageIds: [],
          leadMessageId: `lead_${stepNumber}`,
          sentAt: null,
          completedAt: null,
          createdAt: '2026-05-11T00:00:00.000Z'
        }
      ]
    };
  }

  function branchStep(
    stepNumber: number,
    title: string,
    branchLabel: string,
    actions: Array<{ actionType: string; content: string | null }>
  ) {
    return {
      ...baseStep,
      stepNumber,
      title,
      actions: [],
      branches: [{ branchLabel, actions }]
    };
  }

  it('auto-completes a selected JUDGE-only branch', () => {
    const step1 = branchStep(1, 'Pure Routing', 'Qualified', [
      { actionType: 'runtime_judgment', content: 'They qualify.' }
    ]);
    const step2 = askStep(2, 'Next Step', 'What time works?');
    const script = { id: 'routing_only', steps: [step1, step2] } as any;
    const points = branchSelectedPoints(1, 'Pure Routing', 'Qualified');

    const stage = computeSystemStage(script, points as any, []);

    assert.equal(stage.step?.stepNumber, 2);
    const completed = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'step_completed'
    );
    assert.equal(completed?.stepNumber, 1);
    assert.equal(
      completed?.stepCompletionReason,
      'routing_only_branch_auto_complete'
    );
  });

  it('auto-completes a selected JUDGE plus MSG branch after its AI message exists', () => {
    const step1 = branchStep(1, 'Capital Routing', '$1,500+ — Qualified', [
      {
        actionType: 'runtime_judgment',
        content: 'If they qualify, proceed to STEP 2.'
      },
      {
        actionType: 'send_message',
        content:
          "That's solid bro, I appreciate you being transparent. Let me get your info."
      }
    ]);
    const step2 = askStep(2, 'Collect Info', 'What is your full name?');
    const script = { id: 'routing_message', steps: [step1, step2] } as any;
    const points = branchSelectedPoints(
      1,
      'Capital Routing',
      '$1,500+ — Qualified'
    );

    const beforeDelivery = computeSystemStage(script, points as any, []);
    assert.equal(beforeDelivery.step?.stepNumber, 1);

    const afterDelivery = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content:
          "That's solid bro, I appreciate you being transparent. Let me get your info.",
        timestamp: '2026-05-11T00:00:30.000Z'
      }
    ]);

    assert.equal(afterDelivery.step?.stepNumber, 2);
    const completed = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'step_completed'
    );
    assert.equal(completed?.aiMessageId, 'ai_1');
    assert.equal(completed?.leadMessageId, 'lead_1');
  });

  it('does not auto-complete JUDGE plus MSG plus WAIT before the lead replies', () => {
    const step1 = branchStep(1, 'Context Ask', 'Needs context', [
      { actionType: 'runtime_judgment', content: 'Acknowledge them.' },
      { actionType: 'send_message', content: 'Give me a bit more context.' },
      { actionType: 'wait_for_response', content: null }
    ]);
    const step2 = askStep(2, 'Next Step', 'What changed?');
    const script = { id: 'routing_wait', steps: [step1, step2] } as any;
    const points = branchSelectedPoints(1, 'Context Ask', 'Needs context');

    const noReply = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content: 'Give me a bit more context.',
        timestamp: '2026-05-11T00:00:30.000Z'
      }
    ]);
    const withReply = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content: 'Give me a bit more context.',
        timestamp: '2026-05-11T00:00:30.000Z'
      },
      {
        id: 'lead_reply',
        sender: 'LEAD',
        content: 'I revenge trade after losses.',
        timestamp: '2026-05-11T00:01:00.000Z'
      }
    ]);

    assert.equal(noReply.step?.stepNumber, 1);
    assert.equal(withReply.step?.stepNumber, 2);
  });

  it('bug-004-holds-wait-then-judge-branch-for-reclassification', () => {
    const step1 = branchStep(1, 'Buy-In Confirmation', 'Lukewarm buy-in', [
      {
        actionType: 'send_message',
        content:
          "bruh 😂 brother I'm genuinely trying to help you out... So what's really on your mind?"
      },
      { actionType: 'wait_for_response', content: null },
      {
        actionType: 'runtime_judgment',
        content:
          'If they warm up and clearly say they are ready, proceed to STEP 2. Otherwise stay here.'
      }
    ]);
    const step2 = askStep(2, 'Urgency', 'Is now the time to overcome this?');
    const script = { id: 'wait_then_judge', steps: [step1, step2] } as any;
    const points = branchSelectedPoints(
      1,
      'Buy-In Confirmation',
      'Lukewarm buy-in'
    );

    const stage = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content:
          "bruh 😂 brother I'm genuinely trying to help you out... So what's really on your mind?",
        timestamp: '2026-05-11T00:00:30.000Z'
      },
      {
        id: 'lead_reply',
        sender: 'LEAD',
        content: "yeah man im ready, i'm tired of being stuck",
        timestamp: '2026-05-11T00:01:00.000Z'
      }
    ]);

    assert.equal(stage.step?.stepNumber, 1);
    assert.equal(
      readBranchHistoryEvents(points as any).some(
        (event) => event.eventType === 'step_completed' && event.stepNumber === 1
      ),
      false
    );
  });

  it('does not auto-complete JUDGE plus ASK plus WAIT before the lead replies', () => {
    const step1 = branchStep(1, 'Clarifying Question', 'Needs answer', [
      { actionType: 'runtime_judgment', content: 'Ask the next question.' },
      { actionType: 'ask_question', content: 'What is holding you back?' },
      { actionType: 'wait_for_response', content: null }
    ]);
    const step2 = askStep(2, 'Next Step', 'What would change things?');
    const script = { id: 'routing_ask_wait', steps: [step1, step2] } as any;
    const points = branchSelectedPoints(
      1,
      'Clarifying Question',
      'Needs answer'
    );

    const noReply = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content: 'What is holding you back?',
        timestamp: '2026-05-11T00:00:30.000Z'
      }
    ]);
    const withReply = computeSystemStage(script, points as any, [
      {
        id: 'ai_1',
        suggestionId: 'sug_1',
        sender: 'AI',
        content: 'What is holding you back?',
        timestamp: '2026-05-11T00:00:30.000Z'
      },
      {
        id: 'lead_reply',
        sender: 'LEAD',
        content: 'Mostly emotional control.',
        timestamp: '2026-05-11T00:01:00.000Z'
      }
    ]);

    assert.equal(noReply.step?.stepNumber, 1);
    assert.equal(withReply.step?.stepNumber, 2);
  });

  it('parses proceed-to routing directives and can advance to the target step', async () => {
    const step1 = branchStep(1, 'Routing Decision', 'Ready', [
      {
        actionType: 'runtime_judgment',
        content: 'If the lead is ready, proceed to STEP 3.'
      }
    ]);
    const step2 = askStep(2, 'Nurture', 'What would help you feel ready?');
    const step3 = askStep(3, 'Booking', 'What time works?');
    const script = {
      id: 'proceed_directive',
      steps: [step1, step2, step3]
    } as any;
    const points = branchSelectedPoints(1, 'Routing Decision', 'Ready');
    const stage = computeSystemStage(script, points as any, []);

    assert.equal(stage.step?.stepNumber, 2);

    const result = await applyConditionalStepSkip({
      accountId: 'acct_routing',
      script,
      points: points as any,
      history: [],
      currentStep: stage.step as any,
      classifier: async (params) => {
        assert.equal(params.directives[0].destinationStepNumber, 3);
        return {
          decision: 'skip',
          destinationStepNumber: 3,
          reason: 'lead is ready'
        };
      }
    });

    assert.equal(result.step?.stepNumber, 3);
    const decision = readBranchHistoryEvents(points as any).find(
      (event) => event.eventType === 'conditional_skip_decision'
    );
    assert.equal(decision?.skipDecision, 'skip');
    assert.equal(decision?.skipDestinationStepNumber, 3);
  });
});

describe('generic conditional step skips', () => {
  function branchJudgmentStep(
    stepNumber: number,
    title: string,
    branchLabel: string,
    judgment: string
  ) {
    return {
      ...baseStep,
      stepNumber,
      title,
      actions: [],
      branches: [
        {
          branchLabel,
          actions: [{ actionType: 'runtime_judgment', content: judgment }]
        }
      ]
    };
  }

  function completedPoints(
    stepNumber: number,
    stepTitle: string,
    selectedBranchLabel: string,
    leadMessageId = `lead_${stepNumber}`
  ) {
    return {
      branchHistory: [
        {
          eventType: 'step_completed',
          stepNumber,
          stepTitle,
          selectedBranchLabel,
          suggestionId: `sug_${stepNumber}`,
          aiMessageId: `ai_${stepNumber}`,
          aiMessageIds: [`ai_${stepNumber}`],
          leadMessageId,
          sentAt: '2026-05-11T00:00:00.000Z',
          completedAt: '2026-05-11T00:01:00.000Z',
          createdAt: '2026-05-11T00:01:01.000Z'
        }
      ]
    };
  }

  it('parses operator-authored skip destination variants', () => {
    const directives = parseConditionalStepSkipDirectives(`
      skip to STEP 16
      go to step 10
      jump to STEP 14
      advance to STEP 20
      → STEP 22
      -> STEP 24
      => step 26
    `);

    assert.deepEqual(
      directives.map((directive) => directive.destinationStepNumber),
      [16, 10, 14, 20, 22, 24, 26]
    );
  });

  it('legal services example: classifier-approved skip advances to parsed destination', async () => {
    const step8 = branchJudgmentStep(
      8,
      'Proceed Decision',
      'Client wants to proceed',
      `If client confirms they want to proceed → skip to STEP 10.
If they're hesitant, continue to STEP 9 for objection handling.`
    );
    const step9 = askStep(
      9,
      'Objection Handling',
      'What concerns do you have?'
    );
    const step10 = askStep(10, 'Intake', 'What timeline works for you?');
    const script = {
      id: 'legal_services',
      steps: [step8, step9, step10]
    } as any;
    const points = completedPoints(
      8,
      'Proceed Decision',
      'Client wants to proceed'
    );

    const result = await applyConditionalStepSkip({
      accountId: 'acct_legal',
      script,
      points: points as any,
      history: [
        {
          id: 'lead_8',
          sender: 'LEAD',
          content: 'Yes, I want to proceed with the paperwork.',
          timestamp: '2026-05-11T00:01:00.000Z'
        }
      ],
      currentStep: step9 as any,
      classifier: async (params) => {
        assert.match(params.directiveText, /client confirms/i);
        assert.equal(params.directives[0].destinationStepNumber, 10);
        assert.equal(params.priorBranchHistory?.stepNumber, 8);
        return {
          decision: 'skip',
          destinationStepNumber: 10,
          reason: 'client confirmed proceed intent'
        };
      }
    });

    assert.equal(result.step?.stepNumber, 10);
    const event = readBranchHistoryEvents(points as any).find(
      (entry) => entry.eventType === 'conditional_skip_decision'
    );
    assert.equal(event?.skipDecision, 'skip');
    assert.equal(event?.skipDestinationStepNumber, 10);
  });

  it('fitness coaching example: same generic logic supports jump wording', async () => {
    const step12 = branchJudgmentStep(
      12,
      'Commitment Check',
      'Excited and committed',
      `If lead is clearly excited and committed, jump to STEP 14 for the offer.
Otherwise stay on STEP 13 for reinforcement.`
    );
    const step13 = askStep(
      13,
      'Reinforcement',
      'What would make this feel easier?'
    );
    const step14 = askStep(14, 'Offer', 'Ready to get started?');
    const script = {
      id: 'fitness_coaching',
      steps: [step12, step13, step14]
    } as any;
    const points = completedPoints(
      12,
      'Commitment Check',
      'Excited and committed'
    );

    const result = await applyConditionalStepSkip({
      accountId: 'acct_fitness',
      script,
      points: points as any,
      history: [
        {
          id: 'lead_12',
          sender: 'LEAD',
          content: "I'm excited. I'm committed and ready to do this.",
          timestamp: '2026-05-11T00:01:00.000Z'
        }
      ],
      currentStep: step13 as any,
      classifier: async (params) => {
        assert.match(params.directiveText, /jump to STEP 14/i);
        return {
          decision: 'skip',
          destinationStepNumber: 14,
          reason: 'lead is excited and committed'
        };
      }
    });

    assert.equal(result.step?.stepNumber, 14);
    assert.equal(
      readBranchHistoryEvents(points as any).find(
        (entry) => entry.eventType === 'conditional_skip_decision'
      )?.skipDecision,
      'skip'
    );
  });

  it('continues normally when classifier says the skip condition is not met', async () => {
    const step3 = branchJudgmentStep(
      3,
      'Qualification',
      'Needs nurturing',
      'If they are decisive, advance to STEP 5. Otherwise continue to STEP 4.'
    );
    const step4 = askStep(4, 'Nurture', 'What would you need to feel sure?');
    const step5 = askStep(5, 'Close', 'Do you want to move forward?');
    const script = { id: 'continue_case', steps: [step3, step4, step5] } as any;
    const points = completedPoints(3, 'Qualification', 'Needs nurturing');

    const result = await applyConditionalStepSkip({
      accountId: 'acct_continue',
      script,
      points: points as any,
      history: [],
      currentStep: step4 as any,
      classifier: async () => ({
        decision: 'continue',
        destinationStepNumber: null,
        reason: 'lead is not decisive yet'
      })
    });

    assert.equal(result.step?.stepNumber, 4);
    const event = readBranchHistoryEvents(points as any).find(
      (entry) => entry.eventType === 'conditional_skip_decision'
    );
    assert.equal(event?.skipDecision, 'continue');
  });

  it('continues normally when classifier throws', async () => {
    const step3 = branchJudgmentStep(
      3,
      'Qualification',
      'Ready branch',
      'If they are ready, go to STEP 5. Otherwise continue to STEP 4.'
    );
    const step4 = askStep(4, 'Nurture', 'What would you need to feel sure?');
    const step5 = askStep(5, 'Close', 'Do you want to move forward?');
    const script = {
      id: 'classifier_throw_case',
      steps: [step3, step4, step5]
    } as any;
    const points = completedPoints(3, 'Qualification', 'Ready branch');

    const result = await applyConditionalStepSkip({
      accountId: 'acct_throw',
      script,
      points: points as any,
      history: [],
      currentStep: step4 as any,
      classifier: async () => {
        throw new Error('classifier timed out');
      }
    });

    assert.equal(result.step?.stepNumber, 4);
    const event = readBranchHistoryEvents(points as any).find(
      (entry) => entry.eventType === 'conditional_skip_decision'
    );
    assert.equal(event?.skipDecision, 'continue');
    assert.equal(event?.skipError, 'classifier timed out');
  });

  it('logs a warning and continues when a skip hint has no parseable destination', async () => {
    const step3 = branchJudgmentStep(
      3,
      'Qualification',
      'Vague operator note',
      'If they sound ready, skip ahead to the offer. Otherwise keep nurturing.'
    );
    const step4 = askStep(4, 'Nurture', 'What would you need to feel sure?');
    const step5 = askStep(5, 'Offer', 'Do you want to move forward?');
    const script = {
      id: 'unparseable_case',
      steps: [step3, step4, step5]
    } as any;
    const points = completedPoints(3, 'Qualification', 'Vague operator note');
    let classifierCalled = false;

    const result = await applyConditionalStepSkip({
      accountId: 'acct_unparseable',
      script,
      points: points as any,
      history: [],
      currentStep: step4 as any,
      classifier: async () => {
        classifierCalled = true;
        return {
          decision: 'skip',
          destinationStepNumber: 5,
          reason: 'should not run'
        };
      }
    });

    assert.equal(result.step?.stepNumber, 4);
    assert.equal(classifierCalled, false);
    const warning = readBranchHistoryEvents(points as any).find(
      (entry) => entry.eventType === 'conditional_skip_warning'
    );
    assert.equal(warning?.skipError, 'conditional_skip_pattern_not_parsed');
  });
});
