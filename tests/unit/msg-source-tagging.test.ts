// Unit test: MessageSource enum values are correctly exported from
// the generated Prisma client. If someone renames a variant the import
// will fail and this test file won't compile/run.
//
// Run: npx tsx --test tests/unit/msg-source-tagging.test.ts

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { MessageSource } from '@prisma/client';

describe('MessageSource enum', () => {
  it('QUALIFYDMS_AI is defined', () => {
    assert.equal(MessageSource.QUALIFYDMS_AI, 'QUALIFYDMS_AI');
  });

  it('MANYCHAT_FLOW is defined', () => {
    assert.equal(MessageSource.MANYCHAT_FLOW, 'MANYCHAT_FLOW');
  });

  it('HUMAN_OVERRIDE is defined', () => {
    assert.equal(MessageSource.HUMAN_OVERRIDE, 'HUMAN_OVERRIDE');
  });

  it('UNKNOWN is defined (default for legacy rows)', () => {
    assert.equal(MessageSource.UNKNOWN, 'UNKNOWN');
  });
});
