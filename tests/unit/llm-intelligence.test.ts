// Unit tests for LLM-assisted strict-mode additions.
// Run:
//   npx tsx --test tests/unit/llm-intelligence.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  isJudgeBranchLockConfidence,
  shouldUseSmartModeForJudgeConfidence
} from '../../src/lib/ai-engine';
import { parseSemanticCapitalAmountOutput } from '../../src/lib/capital-amount-classifier';
import {
  applyResolvedScriptVariables,
  resolveScriptVariablesForTexts
} from '../../src/lib/script-variable-resolver';
import { scoreVoiceQualityGroup } from '../../src/lib/voice-quality-gate';

describe('pre-prompt script variable resolution', () => {
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
