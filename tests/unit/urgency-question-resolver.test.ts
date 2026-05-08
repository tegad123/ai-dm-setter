// Unit tests for urgency-question-resolver. Verifies the persona's
// configured urgency question is honored and the legacy daetradez phrasing
// ("how soon are you trying to make this happen?") is NEVER returned by
// any tier of the resolver. Run with:
//   npx tsx --test tests/unit/urgency-question-resolver.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  GENERIC_URGENCY_FALLBACK,
  isUrgencyStep,
  pickUrgencyQuestionFromPersonaConfig,
  pickUrgencyQuestionFromScript,
  type UrgencyResolverScriptData,
  type UrgencyResolverStepData
} from '../../src/lib/urgency-question-resolver';

const RETIRED_DAETRADEZ_PHRASE = 'how soon are you trying to make this happen';

function makeStep(
  overrides: Partial<UrgencyResolverStepData>
): UrgencyResolverStepData {
  return {
    stepNumber: 1,
    stateKey: null,
    title: 'Untitled step',
    canonicalQuestion: null,
    actions: [],
    branches: [],
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// isUrgencyStep
// ---------------------------------------------------------------------------

describe('isUrgencyStep', () => {
  it('matches stateKey="URGENCY"', () => {
    assert.equal(isUrgencyStep({ stateKey: 'URGENCY', title: 'Step 4' }), true);
  });

  it('matches title containing "urgency" (case-insensitive)', () => {
    assert.equal(
      isUrgencyStep({ stateKey: null, title: 'Stage 4: Urgency' }),
      true
    );
  });

  it('matches title containing "timeline"', () => {
    assert.equal(
      isUrgencyStep({ stateKey: null, title: 'Timeline check' }),
      true
    );
  });

  it('does NOT match unrelated titles', () => {
    assert.equal(
      isUrgencyStep({ stateKey: null, title: 'Capital screening' }),
      false
    );
    assert.equal(
      isUrgencyStep({ stateKey: 'OPENING', title: 'Opener' }),
      false
    );
  });
});

// ---------------------------------------------------------------------------
// pickUrgencyQuestionFromScript — TIER 1
// ---------------------------------------------------------------------------

describe('pickUrgencyQuestionFromScript', () => {
  it('returns operator custom question from a direct ASK action — NOT the daetradez fallback', () => {
    const customQuestion =
      'when are you looking to actually pull the trigger on getting this sorted?';
    const script: UrgencyResolverScriptData = {
      steps: [
        makeStep({
          stateKey: 'URGENCY',
          title: 'Stage 4: Urgency',
          actions: [
            {
              actionType: 'ask_question',
              content: customQuestion,
              sortOrder: 0
            }
          ]
        })
      ]
    };
    const result = pickUrgencyQuestionFromScript(script);
    assert.equal(result, customQuestion);
    assert.notEqual(
      result?.toLowerCase().includes(RETIRED_DAETRADEZ_PHRASE),
      true
    );
  });

  it('returns the question from a branched ASK action when no direct ASK exists', () => {
    const customQuestion =
      "what's pushing you to look at this now vs six months ago?";
    const script: UrgencyResolverScriptData = {
      steps: [
        makeStep({
          stateKey: 'URGENCY',
          title: 'Urgency probe',
          actions: [],
          branches: [
            {
              sortOrder: 0,
              actions: [
                {
                  actionType: 'send_message',
                  content: 'okay sick',
                  sortOrder: 0
                },
                {
                  actionType: 'ask_question',
                  content: customQuestion,
                  sortOrder: 1
                }
              ]
            }
          ]
        })
      ]
    };
    assert.equal(pickUrgencyQuestionFromScript(script), customQuestion);
  });

  it('falls back to canonicalQuestion when no ASK action exists', () => {
    const canonical =
      'what kind of timeline you giving yourself to make this real?';
    const script: UrgencyResolverScriptData = {
      steps: [
        makeStep({
          stateKey: 'URGENCY',
          title: 'Stage 4',
          canonicalQuestion: canonical,
          actions: [
            { actionType: 'send_message', content: 'cool', sortOrder: 0 }
          ]
        })
      ]
    };
    assert.equal(pickUrgencyQuestionFromScript(script), canonical);
  });

  it('returns null when there is no urgency step', () => {
    const script: UrgencyResolverScriptData = {
      steps: [
        makeStep({ stateKey: 'OPENING', title: 'Opener' }),
        makeStep({ stateKey: 'CAPITAL', title: 'Capital screening' })
      ]
    };
    assert.equal(pickUrgencyQuestionFromScript(script), null);
  });

  it('returns null when the urgency step has no usable question text', () => {
    const script: UrgencyResolverScriptData = {
      steps: [
        makeStep({
          stateKey: 'URGENCY',
          title: 'Urgency',
          canonicalQuestion: '   ',
          actions: [{ actionType: 'send_message', content: 'hi', sortOrder: 0 }]
        })
      ]
    };
    assert.equal(pickUrgencyQuestionFromScript(script), null);
  });

  it('returns null when the script is null', () => {
    assert.equal(pickUrgencyQuestionFromScript(null), null);
  });
});

// ---------------------------------------------------------------------------
// pickUrgencyQuestionFromPersonaConfig — TIER 2
// ---------------------------------------------------------------------------

describe('pickUrgencyQuestionFromPersonaConfig', () => {
  it('returns the operator-configured urgencyQuestion from promptConfig', () => {
    const cfg = { urgencyQuestion: 'real talk how soon you trying to move?' };
    assert.equal(
      pickUrgencyQuestionFromPersonaConfig(cfg),
      'real talk how soon you trying to move?'
    );
  });

  it('returns null when urgencyQuestion is missing', () => {
    assert.equal(pickUrgencyQuestionFromPersonaConfig({}), null);
    assert.equal(pickUrgencyQuestionFromPersonaConfig(null), null);
    assert.equal(pickUrgencyQuestionFromPersonaConfig(undefined), null);
  });

  it('returns null when urgencyQuestion is empty/whitespace', () => {
    assert.equal(
      pickUrgencyQuestionFromPersonaConfig({ urgencyQuestion: '' }),
      null
    );
    assert.equal(
      pickUrgencyQuestionFromPersonaConfig({ urgencyQuestion: '   ' }),
      null
    );
  });

  it('returns null when urgencyQuestion is a non-string value', () => {
    assert.equal(
      pickUrgencyQuestionFromPersonaConfig({ urgencyQuestion: 42 }),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// Generic fallback constant
// ---------------------------------------------------------------------------

describe('GENERIC_URGENCY_FALLBACK', () => {
  it('is the spec-mandated generic phrasing', () => {
    assert.equal(
      GENERIC_URGENCY_FALLBACK,
      "what's your timeline for making this happen?"
    );
  });

  it('does NOT contain the retired daetradez phrase', () => {
    assert.equal(
      GENERIC_URGENCY_FALLBACK.toLowerCase().includes(RETIRED_DAETRADEZ_PHRASE),
      false
    );
  });
});
