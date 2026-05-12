// AUTO-GENERATED FIXTURE — do not hand-edit.
//
// Populated by:
//   npm run db:copy-daetradez
//
// (Sources prod data from PROD_READ_DATABASE_URL, scrubs PII, replaces
// IDs with placeholder strings, writes back to this file.)
//
// This file is the empty/unpopulated stub. It compiles so the rest of
// the harness type-checks, but the runner will refuse to seed Persona B
// against an unpopulated fixture — it throws a clear error directing
// the operator to run the copy script.

import type { ProdDumpFixture } from '../types';

export const daetradezFixture: ProdDumpFixture = {
  _populated: false,
  capturedAt: null,
  sourceAccountIdHash: 'unpopulated',
  accountConfig: {
    placeholderId: '$ACCOUNT_ID$',
    name: 'UNPOPULATED — run npm run db:copy-daetradez'
  },
  personaConfig: {
    personaName: 'UNPOPULATED',
    fullName: 'UNPOPULATED',
    systemPrompt:
      'This persona fixture is empty. Run `npm run db:copy-daetradez` against the prod DB to populate it.'
  },
  script: null,
  trainingUploads: [],
  trainingConversations: [],
  trainingMessages: []
};
