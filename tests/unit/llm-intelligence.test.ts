// Unit tests for LLM-assisted strict-mode additions.
// Run:
//   npx tsx --test tests/unit/llm-intelligence.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  detectJudgeBranchViolation,
  isJudgeBranchLockConfidence,
  shouldUseSmartModeForJudgeConfidence
} from '../../src/lib/ai-engine';
import { parseSemanticCapitalAmountOutput } from '../../src/lib/capital-amount-classifier';
import {
  applyResolvedScriptVariables,
  extractTemplateVariableNames,
  isValidTemplateVariableName,
  parseScriptVariableExtractorValue,
  removeInvalidScriptVariableResolutionKeys,
  resolveScriptVariablesForTexts
} from '../../src/lib/script-variable-resolver';
import {
  extractBookingInfoHeuristically,
  parseBookingInfoExtractionOutput
} from '../../src/lib/booking-info-extractor';
import { scoreVoiceQualityGroup } from '../../src/lib/voice-quality-gate';

describe('pre-prompt script variable resolution', () => {
  it('bug-X-variable-name-validation: ignores directive placeholders with examples', () => {
    assert.equal(isValidTemplateVariableName('deep_why'), true);
    assert.equal(isValidTemplateVariableName('day and time'), true);
    assert.equal(isValidTemplateVariableName('first name'), true);
    assert.equal(isValidTemplateVariableName('phone number'), true);
    assert.equal(isValidTemplateVariableName('incomeGoal'), true);
    assert.equal(isValidTemplateVariableName('their stated goal'), true);
    assert.equal(isValidTemplateVariableName('trading goal'), true);
    assert.equal(isValidTemplateVariableName('income target'), true);
    assert.equal(isValidTemplateVariableName('their field'), true);
    assert.equal(isValidTemplateVariableName('their job'), true);
    assert.equal(
      isValidTemplateVariableName('acknowledge their experience'),
      false
    );
    assert.equal(isValidTemplateVariableName('comment on their job'), false);
    assert.equal(isValidTemplateVariableName('matching their tone'), false);
    assert.equal(
      isValidTemplateVariableName(
        'specific missing info e.g. "email" / "timezone" / "phone number"'
      ),
      false
    );
    assert.deepEqual(
      extractTemplateVariableNames(
        '{{specific missing info e.g. "email" / "timezone" / "phone number"}} {{acknowledge their experience}} {{deep_why}} {{day and time}} {{their stated goal}} {{their field}}'
      ),
      ['deep_why', 'day and time', 'their stated goal', 'their field']
    );
  });

  it('bug-58-semantic-variable-alias: resolves their stated goal from incomeGoal', async () => {
    let calls = 0;
    const resolutions = await resolveScriptVariablesForTexts(
      [
        'But why is {{their stated goal}} so important to you though?',
        'What would {{income target}} mean for the family?'
      ],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            incomeGoal: {
              value: 1000,
              confidence: 'HIGH',
              sourceFieldName: 'incomeGoal'
            }
          }
        },
        extractor: async () => {
          calls++;
          return 'should not happen';
        }
      }
    );

    assert.equal(calls, 0);
    assert.equal(
      applyResolvedScriptVariables(
        'But why is {{their stated goal}} so important to you though?',
        resolutions
      ),
      'But why is $1k so important to you though?'
    );
    assert.equal(
      applyResolvedScriptVariables(
        'What would {{income target}} mean for the family?',
        resolutions
      ),
      'What would $1k mean for the family?'
    );
    assert.equal(
      applyResolvedScriptVariables(
        'I can see why {{income_goal}} matters.',
        resolutions
      ),
      'I can see why $1k matters.'
    );
  });

  it('bug-007-prefers-canonical-incomeGoal-and-formats-numeric-strings', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['But why is {{their stated goal}} so important to you though?'],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            desiredOutcome: {
              value: '$6 would help someday',
              confidence: 'LOW',
              sourceFieldName: 'desiredOutcome'
            },
            incomeGoal: {
              value: '1000',
              confidence: 'HIGH',
              sourceFieldName: 'incomeGoal'
            }
          }
        },
        extractor: async () => {
          throw new Error('extractor should not run');
        }
      }
    );

    assert.equal(
      applyResolvedScriptVariables(
        'But why is {{their stated goal}} so important to you though?',
        resolutions
      ),
      'But why is $1k so important to you though?'
    );
  });

  it('bug-008-resolves-their-field-from-workBackground', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      [
        "I know {{their field}} is different than trading.",
        'How long have you been in {{their job}}?'
      ],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            workBackground: {
              value: 'retail management',
              confidence: 'HIGH',
              sourceFieldName: 'workBackground'
            }
          }
        },
        extractor: async () => {
          throw new Error('extractor should not run');
        }
      }
    );

    assert.equal(
      applyResolvedScriptVariables(
        'I know {{their field}} is different than trading.',
        resolutions
      ),
      'I know retail management is different than trading.'
    );
    assert.equal(
      applyResolvedScriptVariables(
        'How long have you been in {{their job}}?',
        resolutions
      ),
      'How long have you been in retail management?'
    );
  });

  it('bug-001-resolves-canonical-variable-aliases-in-judge-fallback', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['But why is {{their stated goal}} so important to you though?'],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            incomeGoal: {
              value: 1000,
              confidence: 'HIGH',
              sourceFieldName: 'incomeGoal'
            }
          }
        },
        extractor: async () => {
          throw new Error('extractor should not run');
        }
      }
    );

    const violation = await detectJudgeBranchViolation({
      latestLeadMessage: 'yes that makes sense',
      generatedMessages: ['not the required script message'],
      variableResolutionMap: resolutions,
      classifier: async () => 'Default',
      step: {
        stepNumber: 16,
        title: 'Call Proposal',
        actions: [],
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: null,
            actions: [
              {
                actionType: 'runtime_judgment',
                content: 'Use the selected branch.'
              },
              {
                actionType: 'send_message',
                content:
                  'Based on {{income_goal}}, it might make sense to set up a roadmap call.'
              }
            ]
          }
        ]
      }
    });

    assert.equal(violation.blocked, true);
    assert.equal(
      violation.fallbackMessages[0],
      'Based on $1k, it might make sense to set up a roadmap call.'
    );
    assert.equal(violation.fallbackMessages[0]?.includes('{{'), false);
  });

  it('bug-X-haiku-strict-parsing: treats NONE plus reasoning as null', () => {
    assert.equal(parseScriptVariableExtractorValue('NONE'), null);
    assert.equal(
      parseScriptVariableExtractorValue(
        'NONE\n\nAll required information has been provided:\n- Full name: Tega Umukoro'
      ),
      null
    );
    assert.equal(
      parseScriptVariableExtractorValue('Tega Umukoro\nextra explanation'),
      'Tega Umukoro'
    );
  });

  it('bug-57-variable-output-validation: rejects full lead quotes for obstacle', () => {
    assert.equal(
      parseScriptVariableExtractorValue(
        "honestly bro it's been brutal, i keep blowing my small accounts revenge trading. started with 2k, now i'm down to like 800 bucks and my wife doesn't even know",
        'obstacle'
      ),
      null
    );
    assert.equal(
      parseScriptVariableExtractorValue(
        'They struggle with emotions when trading',
        'obstacle'
      ),
      null
    );
    assert.equal(
      parseScriptVariableExtractorValue('revenge trading', 'obstacle'),
      'revenge trading'
    );
  });

  it('bug-57-variable-output-validation: normalizes typed variables', () => {
    assert.equal(
      parseScriptVariableExtractorValue('Tega Umokoro', 'NAME'),
      'Tega'
    );
    assert.equal(
      parseScriptVariableExtractorValue(
        'they want to make 5000',
        'income_goal'
      ),
      '$5k'
    );
    assert.equal(
      parseScriptVariableExtractorValue('$3k a month from my job', 'capital'),
      '$3k'
    );
    assert.equal(
      parseScriptVariableExtractorValue(
        'replace job income with trading',
        'desired_outcome'
      ),
      'replace job income with trading'
    );
  });

  it('bug-57-persisted-variable-cleanup: removes invalid stored variable-resolution values', () => {
    const points = {
      income_goal: {
        value:
          'honestly bro it would mean we keep barely making ends meet, no savings for emergencies',
        variableName: 'income_goal',
        extractionMethod: 'branch_history_variable_resolution'
      },
      desired_outcome: {
        value: 'replace job income with trading',
        variableName: 'desired_outcome',
        extractionMethod: 'llm_variable_resolution'
      },
      obstacle: {
        value: 'long operator-captured field should not be deleted here',
        extractionMethod: 'volunteered_obstacle_for_upcoming_ask'
      }
    };

    assert.equal(removeInvalidScriptVariableResolutionKeys(points), true);
    assert.equal('income_goal' in points, false);
    assert.equal('desired_outcome' in points, true);
    assert.equal('obstacle' in points, true);
  });

  it('does not call the LLM extractor for directive placeholders', async () => {
    let calls = 0;
    const resolutions = await resolveScriptVariablesForTexts(
      [
        'missing your {{specific missing info e.g. "email" / "timezone" / "phone number"}}',
        '{{acknowledge their experience}}',
        '{{comment on their job}}'
      ],
      {
        accountId: 'acct_test',
        context: {
          conversationHistory: [
            {
              sender: 'LEAD',
              content: 'Tega Umukoro, tegad8@gmail.com, CT, wed at 2pm'
            }
          ]
        },
        extractor: async () => {
          calls++;
          return 'should not happen';
        }
      }
    );

    assert.equal(calls, 0);
    assert.equal(resolutions.resolvedVariables.length, 0);
  });

  it('does not enforce directive placeholders as resolved verbatim messages', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['{{acknowledge their experience}}'],
      {
        accountId: 'acct_test',
        context: {
          conversationHistory: [
            {
              sender: 'LEAD',
              content: 'been at it for about a year, mostly losing money'
            }
          ]
        },
        extractor: async () => {
          throw new Error('directive placeholder should not be extracted');
        }
      }
    );
    const unresolved = applyResolvedScriptVariables(
      '{{acknowledge their experience}}',
      resolutions
    );

    assert.equal(unresolved, '{{acknowledge their experience}}');
    const quality = scoreVoiceQualityGroup(
      [
        'Nice, so how have the markets been treating you so far? Any main problems coming up?'
      ],
      {
        activeBranchRequiredMessages: [
          {
            content: unresolved ?? '',
            isPlaceholder: true,
            embeddedQuotes: []
          }
        ],
        activeBranchScriptedQuestions: [
          'Nice, so how have the markets been treating you so far? Any main problems coming up?'
        ],
        activeBranchHasAskAction: true,
        currentStepHasAskBranch: true,
        currentScriptStepNumber: 3
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('multiple_questions_in_reply:')
      ),
      false
    );
  });

  it('resolves direct captured data and lead context before prompt construction', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['based off {{obstacle}}, got you {{NAME}}'],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            obstacle: {
              value: 'revenge trading after red trades'
            }
          },
          leadContext: {
            leadName: 'Tega'
          }
        }
      }
    );

    const rendered = applyResolvedScriptVariables(
      'based off {{obstacle}}, got you {{NAME}}',
      resolutions
    );

    assert.equal(
      rendered,
      'based off revenge trading after red trades, got you Tega'
    );
  });

  it('bug-57-rejects-long-captured-obstacle-and-uses-concise-llm-value', async () => {
    let calls = 0;
    const resolutions = await resolveScriptVariablesForTexts(
      ['based off {{obstacle}}'],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            obstacle: {
              value:
                "honestly bro it's been brutal, i keep blowing my small accounts revenge trading. started with 2k, now i'm down to like 800 bucks and my wife doesn't even know"
            }
          },
          conversationHistory: [
            {
              sender: 'LEAD',
              content:
                "honestly bro it's been brutal, i keep blowing my small accounts revenge trading"
            }
          ]
        },
        extractor: async ({ variableName }) => {
          calls++;
          return variableName === 'obstacle' ? 'revenge trading' : null;
        }
      }
    );

    assert.equal(calls, 1);
    assert.equal(
      applyResolvedScriptVariables('based off {{obstacle}}', resolutions),
      'based off revenge trading'
    );
  });

  it('bug-57-rejects-oversized-llm-resolution-and-falls-back', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['based off {{obstacle}}'],
      {
        accountId: 'acct_test',
        context: {
          conversationHistory: [
            {
              sender: 'LEAD',
              content:
                "honestly bro it's been brutal, i keep blowing accounts when i see red"
            }
          ]
        },
        extractor: async () =>
          "honestly bro it's been brutal, i keep blowing accounts when i see red"
      }
    );

    assert.equal(
      applyResolvedScriptVariables('based off {{obstacle}}', resolutions),
      'based off what you mentioned earlier'
    );
  });

  it('uses the LLM extractor for unresolved variables and marks them persistable', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['that ties back to {{desired_outcome}}'],
      {
        accountId: 'acct_test',
        context: {
          conversationHistory: [
            {
              id: 'msg_1',
              sender: 'LEAD',
              content: 'I want to replace my income so my wife can relax'
            }
          ]
        },
        extractor: async ({ variableName }) =>
          variableName === 'desired_outcome'
            ? 'replace my income so my wife can relax'
            : null
      }
    );

    const desiredOutcome = resolutions.resolvedVariables.find(
      (item) => item.variableName === 'desired_outcome'
    );
    assert.equal(desiredOutcome?.source, 'llm');
    assert.equal(desiredOutcome?.shouldPersist, true);
    assert.equal(
      applyResolvedScriptVariables(
        'that ties back to {{desired_outcome}}',
        resolutions
      ),
      'that ties back to replace my income so my wife can relax'
    );
  });

  it('falls back gracefully instead of leaving template braces in prompt text', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['based off {{obstacle}}'],
      {
        accountId: 'acct_test',
        context: {},
        extractor: async () => null
      }
    );

    assert.equal(
      applyResolvedScriptVariables('based off {{obstacle}}', resolutions),
      'based off what you mentioned earlier'
    );
  });

  it('uses resolved variables for judge fallback and verbatim gates', async () => {
    const resolutions = await resolveScriptVariablesForTexts(
      ['the main struggle is {{obstacle}}'],
      {
        accountId: 'acct_test',
        context: {
          capturedDataPoints: {
            early_obstacle:
              'emotional control, cannot follow rules in the trade'
          }
        },
        extractor: async () => null
      }
    );

    const resolvedRequired = applyResolvedScriptVariables(
      "I mean bro, based off what it seems, the main struggle you're facing is {{obstacle}}, but like I said your commitment is truly there I can tell.",
      resolutions
    );
    assert.equal(
      resolvedRequired?.includes('{{'),
      false,
      'resolved required text should not contain template braces'
    );

    const passQuality = scoreVoiceQualityGroup([resolvedRequired || ''], {
      activeBranchRequiredMessages: [
        {
          content: resolvedRequired || '',
          isPlaceholder: false
        }
      ]
    });
    assert.equal(
      passQuality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );

    const violation = await detectJudgeBranchViolation({
      latestLeadMessage: '3k set aside',
      generatedMessages: ['not the required script message'],
      variableResolutionMap: resolutions,
      classifier: async () => 'Default',
      step: {
        stepNumber: 16,
        title: 'Call Proposal',
        actions: [],
        branches: [
          {
            branchLabel: 'Default',
            conditionDescription: null,
            actions: [
              {
                actionType: 'runtime_judgment',
                content: 'Use the selected branch.'
              },
              {
                actionType: 'send_message',
                content:
                  "I mean bro, based off what it seems, the main struggle you're facing is {{obstacle}}, but like I said your commitment is truly there I can tell."
              }
            ]
          }
        ]
      }
    });

    assert.equal(violation.blocked, true);
    assert.equal(violation.fallbackMessages[0], resolvedRequired);
    assert.equal(violation.fallbackMessages[0]?.includes('{{'), false);
  });
});

describe('multi-field booking info extraction', () => {
  it('bug-X-multi-field-booking-extraction: parses all five fields from JSON output', () => {
    const fields = parseBookingInfoExtractionOutput(
      JSON.stringify({
        fullName: 'Tega Umukoro',
        email: 'tegad8@gmail.com',
        phone: '346-295-4688',
        timezone: 'CT',
        dayAndTime: 'wed at 2pm'
      })
    );

    assert.deepEqual(fields, {
      fullName: 'Tega Umukoro',
      email: 'tegad8@gmail.com',
      phone: '346-295-4688',
      timezone: 'CT',
      dayAndTime: 'wed at 2pm'
    });
  });

  it('extracts obvious booking fields heuristically as a fallback', () => {
    const fields = extractBookingInfoHeuristically(
      'Tega Umukoro, tegad8@gmail.com, 346-295-4688, CT, wed at 2pm'
    );

    assert.equal(fields.fullName, 'Tega Umukoro');
    assert.equal(fields.email, 'tegad8@gmail.com');
    assert.equal(fields.phone, '346-295-4688');
    assert.equal(fields.timezone, 'CT');
    assert.equal(fields.dayAndTime, 'wed at 2pm');
  });

  it('uses null for fields missing from extractor JSON', () => {
    const fields = parseBookingInfoExtractionOutput(
      '{"fullName": null, "email": "tegad8@gmail.com", "phone": null, "timezone": null, "dayAndTime": null}'
    );

    assert.equal(fields.fullName, null);
    assert.equal(fields.email, 'tegad8@gmail.com');
    assert.equal(fields.phone, null);
  });
});

describe('semantic capital amount parser', () => {
  it('accepts plain Haiku integer output', () => {
    assert.equal(parseSemanticCapitalAmountOutput('3000'), 3000);
    assert.equal(parseSemanticCapitalAmountOutput('5,000'), 5000);
  });

  it('treats NONE or explanatory output as unclear', () => {
    assert.equal(parseSemanticCapitalAmountOutput('NONE'), null);
    assert.equal(parseSemanticCapitalAmountOutput('around 3k'), null);
  });
});

describe('smart mode threshold and gate tiers', () => {
  it('triggers smart mode for low and none, not medium/high/llm_classified', () => {
    assert.equal(shouldUseSmartModeForJudgeConfidence('low'), true);
    assert.equal(shouldUseSmartModeForJudgeConfidence('none'), true);
    assert.equal(shouldUseSmartModeForJudgeConfidence('medium'), false);
    assert.equal(shouldUseSmartModeForJudgeConfidence('high'), false);
    assert.equal(shouldUseSmartModeForJudgeConfidence('llm_classified'), false);

    assert.equal(isJudgeBranchLockConfidence('low'), false);
    assert.equal(isJudgeBranchLockConfidence('none'), false);
    assert.equal(isJudgeBranchLockConfidence('medium'), true);
    assert.equal(isJudgeBranchLockConfidence('high'), true);
    assert.equal(isJudgeBranchLockConfidence('llm_classified'), true);
  });

  it('skips script-fidelity verbatim enforcement in smart mode', () => {
    const quality = scoreVoiceQualityGroup(
      [
        'damn bro, that sounds heavy. what feels like the biggest thing to fix first?'
      ],
      {
        smartMode: true,
        activeBranchRequiredMessages: [
          {
            content: 'Gotcha, I appreciate you being real about that.',
            isPlaceholder: false
          }
        ]
      }
    );

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('msg_verbatim_violation:')
      ),
      false
    );
    assert.equal(quality.passed, true);
  });

  it('keeps Tier 1 fabricated URL protection hard in smart mode', () => {
    const quality = scoreVoiceQualityGroup(
      ['grab this: https://old.example.com/form'],
      {
        smartMode: true,
        allowedUrls: ['https://current.example.com/form']
      }
    );

    assert.ok(
      quality.hardFails.some((failure) =>
        failure.includes('fabricated_url_in_reply:')
      )
    );
    assert.equal(quality.passed, false);
  });

  it('treats sub-500-word length as a soft warning, not a blocker', () => {
    const longButReadable = `hey bro ${'trading '.repeat(80)}what feels like the main thing holding you back?`;
    const quality = scoreVoiceQualityGroup([longButReadable]);

    assert.equal(
      quality.hardFails.some((failure) =>
        failure.includes('message_too_long:')
      ),
      false
    );
    assert.equal(quality.softSignals.message_too_long, -0.1);
    assert.equal(quality.passed, true);
  });
});
