import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { replyAnswersAsk } from '../../src/lib/answer-satisfaction';

describe('replyAnswersAsk', () => {
  it('accepts a location answer that asks the setter the same question back', () => {
    assert.equal(replyAnswersAsk("I'm based in Nairobi, Kenya🇰🇪,You?"), true);
    assert.equal(replyAnswersAsk('Nairobi, Kenya, you?'), true);
    assert.equal(
      replyAnswersAsk('I’m currently living in Houston, wbu?'),
      true
    );
  });

  it('keeps pure question-backs and pricing questions classified as non-answers', () => {
    assert.equal(replyAnswersAsk('You?'), false);
    assert.equal(replyAnswersAsk('What about you?'), false);
    assert.equal(replyAnswersAsk('How much does it cost?'), false);
  });

  it('keeps explicit deferrals classified as non-answers', () => {
    assert.equal(replyAnswersAsk('Not yet, you?'), false);
    assert.equal(replyAnswersAsk('Hold on, what about you?'), false);
  });
});
