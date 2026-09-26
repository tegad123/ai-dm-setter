import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  formatJudgeLeadContext,
  selectJudgeBranchForLead
} from '../../src/lib/ai-engine';

const step = {
  stepNumber: 4,
  title: 'Send the Link',
  actions: [],
  branches: [
    {
      branchLabel: 'YES',
      conditionDescription:
        'Take this branch when they say yes or show clear interest.',
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            'Examples: "yes", "yeah send it", "bet", "please", "what\'s the link". Send the link exactly once.'
        },
        { actionType: 'send_link', content: 'Discord' }
      ]
    },
    {
      branchLabel: 'Hesitant',
      conditionDescription:
        "Take this branch when they're non-committal, ask what it is first, or say no for the first time.",
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            'Examples: "what is it", "maybe", "is it free", "idk bro", "nah". A first no always lands here and never ends the script.'
        },
        { actionType: 'ask_question', content: 'want me to send it anyway?' }
      ]
    }
  ]
};

const joinCheckStep = {
  stepNumber: 5,
  title: 'Join Check',
  actions: [],
  branches: [
    {
      branchLabel: 'Joined',
      conditionDescription:
        'Take this branch when the link was sent and they confirm they joined.',
      actions: [{ actionType: 'send_message', content: 'welcome' }]
    },
    {
      branchLabel: 'Not in yet',
      conditionDescription:
        'Take this branch when the link was sent but they have not confirmed joining.',
      actions: [
        {
          actionType: 'runtime_judgment',
          content:
            'They say not yet or later, seem confused, or reply with something else. Examples: "not yet", "later", "wym", "ok". Do not resend the link unless they say they cannot find it.'
        },
        { actionType: 'ask_question', content: "lmk once you're in?" }
      ]
    },
    {
      branchLabel: 'Hesitant, now yes',
      conditionDescription:
        'Take this branch when they are tagged hesitant and now say yes.',
      actions: [{ actionType: 'send_link', content: 'Discord' }]
    },
    {
      branchLabel: 'Soft exit',
      conditionDescription:
        'Take this branch when they are tagged hesitant and decline a second time.',
      actions: [
        { actionType: 'runtime_judgment', content: 'End of script. No link.' }
      ]
    }
  ]
};

describe('judge branch routing with recent lead context', () => {
  it('routes the newest explicit link request over an earlier not-yet answer', async () => {
    const result = await selectJudgeBranchForLead(
      step,
      `Earlier: nah not yet, still in the learning phase. i'm based in texas and looking for a free community.\nLatest: yeah that sounds perfect, definitely send the link. appreciate you breaking it down`,
      { classifier: async () => 'YES' }
    );
    assert.equal(result.branchLabel, 'YES');
  });

  it('routes the newest hesitation over an earlier link request', async () => {
    const result = await selectJudgeBranchForLead(
      step,
      'Earlier: yeah definitely send the link.\nLatest: actually maybe later, what is it first?',
      { classifier: async () => 'Hesitant' }
    );
    assert.equal(result.branchLabel, 'Hesitant');
  });

  it('does not lock Not in yet from old deferrals at the join check', async () => {
    let classifierCalled = false;
    const context = formatJudgeLeadContext({
      recentLeadMessages: [
        'nah not yet, still learning.',
        'yeah send the link.',
        'yeah for sure, send it over. sounds like exactly what i need before i jump in with real money'
      ],
      previousCompletedBranch: { stepNumber: 4, label: 'Hesitant' }
    });
    assert.match(
      context ?? '',
      /Previous completed script branch at Step 4: Hesitant/
    );
    const result = await selectJudgeBranchForLead(joinCheckStep, context, {
      classifier: async () => {
        classifierCalled = true;
        return 'Hesitant, now yes';
      }
    });
    assert.equal(classifierCalled, true);
    assert.equal(result.branchLabel, 'Hesitant, now yes');
  });

  it('lets semantic meaning override a high token score from negated background facts', async () => {
    let calls = 0;
    const result = await selectJudgeBranchForLead(
      step,
      "yeah that sounds perfect honestly, i'm definitely not trying to risk money while i'm still figuring things out. a free discord with an actual process would be exactly what i'm looking for right now. yeah send the link over",
      {
        classifier: async () => {
          calls++;
          return 'YES';
        }
      }
    );
    assert.equal(calls, 1);
    assert.equal(result.branchLabel, 'YES');
    assert.equal(result.confidence, 'llm_classified');
  });

  for (const outcome of ['NONE', 'invented-branch', null]) {
    it(`abstains instead of reviving a token guess when the classifier returns ${outcome}`, async () => {
      const result = await selectJudgeBranchForLead(step, 'no never not yet', {
        classifier: async () => outcome
      });
      assert.equal(result.branchLabel, null);
      assert.equal(result.confidence, 'none');
    });
  }

  it('abstains on classifier failure even when tokens strongly match', async () => {
    const result = await selectJudgeBranchForLead(step, 'no never not yet', {
      classifier: async () => {
        throw new Error('provider timeout');
      }
    });
    assert.equal(result.branchLabel, null);
    assert.equal(result.confidence, 'none');
  });
});
