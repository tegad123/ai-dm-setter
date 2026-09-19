import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { decideScheduledMessageFailure } from '../../src/lib/scheduled-message-failure';

describe('scheduled message failure disposition', () => {
  for (const code of [10, 190, 200, 368, 100]) {
    it(`makes a non-transient Meta ${code} rejection terminal and visible on its first attempt`, () => {
      const result = decideScheduledMessageFailure(
        new Error(
          `Instagram send DM failed: 400 {"error":{"code":${code},"is_transient":false}}`
        ),
        0
      );
      assert.equal(result.status, 'FAILED');
      assert.equal(result.attempts, 3);
      assert.equal(result.notifyOperator, true);
    });
  }

  it('retains the thread ownership explanation for operator review', () => {
    const result = decideScheduledMessageFailure(
      new Error(
        'Instagram send DM failed: 400 {"error":{"code":100,"error_subcode":2534037,"is_transient":false}}'
      ),
      0
    );
    assert.equal(result.notifyOperator, true);
    assert.match(result.errorMeaning, /thread ownership/);
  });

  it('keeps temporary failures pending until the attempt limit', () => {
    const error = new Error(
      'Facebook send message failed: 500 {"error":{"code":2}}'
    );
    for (const previousAttempts of [0, 1]) {
      const result = decideScheduledMessageFailure(error, previousAttempts);
      assert.equal(result.status, 'PENDING');
      assert.equal(result.attempts, previousAttempts + 1);
      assert.equal(result.notifyOperator, false);
    }
    const exhausted = decideScheduledMessageFailure(error, 2);
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.notifyOperator, true);
    assert.match(exhausted.errorMeaning, /attempts exhausted/);
    assert.doesNotMatch(exhausted.errorMeaning, /retry automatically/);
  });

  it('alerts on exhausted internal failures, while preserving bounded retries', () => {
    const error = new Error('database connection lost');
    assert.equal(decideScheduledMessageFailure(error, 0).status, 'PENDING');
    const exhausted = decideScheduledMessageFailure(error, 2);
    assert.equal(exhausted.status, 'FAILED');
    assert.equal(exhausted.notifyOperator, true);
    assert.match(exhausted.errorMeaning, /Operator review is required/);
  });
});
