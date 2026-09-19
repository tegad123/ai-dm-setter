import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { retryMetaDelivery } from '../../src/lib/meta-delivery-retry';

describe('Meta delivery retries', () => {
  for (const code of [10, 190, 200, 368, 100]) {
    it(`does not repeat a rejected send with Meta code ${code}`, async () => {
      let sends = 0;
      const rejection = new Error(
        `Facebook send message failed: 400 {"error":{"code":${code},"is_transient":false}}`
      );
      await assert.rejects(
        retryMetaDelivery(
          async () => {
            sends++;
            throw rejection;
          },
          { sleep: async () => assert.fail('must not wait to retry') }
        ),
        (error) => error === rejection
      );
      assert.equal(sends, 1);
    });
  }

  it('retries explicit temporary failures and returns the accepted message ID', async () => {
    let sends = 0;
    const delays: number[] = [];
    const result = await retryMetaDelivery(
      async () => {
        sends++;
        if (sends < 3) {
          throw new Error('Instagram send DM failed: 500 {"error":{"code":2}}');
        }
        return { messageId: 'meta-confirmed-1' };
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        }
      }
    );
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(sends, 3);
    assert.equal(result.messageId, 'meta-confirmed-1');
  });

  it('stops after three temporary failures', async () => {
    let sends = 0;
    await assert.rejects(
      retryMetaDelivery(
        async () => {
          sends++;
          throw new Error('Facebook send message failed: 503');
        },
        { sleep: async () => {} }
      )
    );
    assert.equal(sends, 3);
  });

  it('does not blindly resend after an uncertain transport failure', async () => {
    let sends = 0;
    await assert.rejects(
      retryMetaDelivery(
        async () => {
          sends++;
          throw new TypeError('fetch failed');
        },
        { sleep: async () => assert.fail('must not retry uncertain delivery') }
      )
    );
    assert.equal(sends, 1);
  });
});
