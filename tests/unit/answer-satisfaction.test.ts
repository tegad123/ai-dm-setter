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

  it('accepts a named alternative after not yet across different asks', () => {
    const reply =
      "nah not yet, still in learning mode. i'm based in texas and want a foundation before risking anything. do you have a free discord?";
    assert.equal(replyAnswersAsk(reply), false);
    assert.equal(
      replyAnswersAsk(
        reply,
        'you trading anything yet, even on demo, or still learning the basics first?'
      ),
      true
    );
    assert.equal(
      replyAnswersAsk(reply, 'do you have enough capital to get started?'),
      false
    );
    assert.equal(
      replyAnswersAsk(
        'not yet, you?',
        'you trading anything yet, even on demo?'
      ),
      false
    );
    assert.equal(
      replyAnswersAsk(
        'not yet, still deciding',
        'have you booked a call yet, or still deciding?'
      ),
      true
    );
    assert.equal(
      replyAnswersAsk('not yet, next week', 'can you pay today or next week?'),
      true
    );
    assert.equal(
      replyAnswersAsk(
        'not yet, can you explain it?',
        'can you pay today or next week?'
      ),
      false
    );
  });

  it('does not treat the price quoted in a product question as an affordability answer', () => {
    for (const reply of [
      'What does the $200 include before paying?',
      'Is the course $200?',
      'How much do I need to start, $200?',
      'Before I pay $200, what comes with it?',
      'Hold on, what does the 200 cover?',
      'Does this include 2 calls every month?'
    ]) {
      assert.equal(replyAnswersAsk(reply), false, reply);
    }
  });

  it('keeps concrete answers that also ask questions or contain a deferral', () => {
    for (const reply of [
      "not yet, but i've got 5k ready",
      'I have $200 ready, what does it include?',
      'What comes with it? I have $200 ready.',
      'I want 5k a month, is that realistic?',
      '200, is that enough?',
      'How about $200?',
      'Would $500 be enough?',
      'Around $200, how much does it cost?',
      '2 years, you?',
      'Not yet, but enough to cover it'
    ]) {
      assert.equal(replyAnswersAsk(reply), true, reply);
    }
  });
});
