// Persona B — capital-disqualified trader, $500 → SLM downsell at Step 19.
//
// Wires in the daetradez prod fixture (account + persona + script +
// training messages). The fixture is populated by
//   npm run db:copy-daetradez
// against a read-only prod DB. Until that has been run, the unpopulated
// fixture short-circuits at seed time with a clear error.

import type { PersonaScenario } from '../types';
import { daetradezFixture } from '../fixtures/daetradez-fixture';

if (!daetradezFixture._populated) {
  // Throwing at module load means the runner surfaces this as a
  // HARNESS_ERROR before any seed runs, with the actionable next step.
  throw new Error(
    '[persona-b] daetradez fixture is unpopulated. ' +
      'Run `npm run db:copy-daetradez` with PROD_READ_DATABASE_URL set, ' +
      'then re-run `npm run test:personas`.'
  );
}

export const persona: PersonaScenario = {
  slug: 'persona-b-capital-disqualified',
  description:
    'Capital-disqualified trader with $500, should route to SLM downsell at Step 19',
  accountConfig: daetradezFixture.accountConfig,
  personaConfig: daetradezFixture.personaConfig,
  scriptConfig: daetradezFixture.script,
  trainingUploads: daetradezFixture.trainingUploads,
  trainingConversations: daetradezFixture.trainingConversations,
  trainingMessages: daetradezFixture.trainingMessages,
  scenarios: [
    {
      id: 'persona-b-capital-disqualified',
      description:
        'Capital-disqualified trader with $500, should route to SLM downsell at Step 19',
      fastPath: true,
      turns: [
        // Step 1 — Warm Inbound
        { role: 'lead', content: 'hey bro' },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 1 },
            { type: 'NO_QUALITY_GATE_FAILURE' },
            { type: 'AI_MESSAGE_CONTAINS', value: 'respect for reaching out' }
          ]
        },

        // Step 2 + Step 3 (auto-skip via volunteered tenure)
        {
          role: 'lead',
          content: 'been trading about a year, mostly losing'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 3 },
            { type: 'CAPTURED_DATA_HAS', field: 'tradingExperienceDuration' },
            { type: 'NO_QUALITY_GATE_FAILURE' }
          ]
        },

        // Step 4 obstacle (detailed/emotional branch)
        {
          role: 'lead',
          content:
            'honestly its been brutal, i keep blowing my small accounts revenge trading. started with 2k now im down to 800 and my wife doesnt even know'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 5 },
            {
              type: 'BRANCH_SELECTED',
              step: 4,
              value: 'Obstacle given — detailed and emotional'
            },
            { type: 'CAPTURED_DATA_HAS', field: 'obstacle' }
          ]
        },

        // Step 5 work + Step 6 auto-skip via volunteered tenure
        {
          role: 'lead',
          content: 'i work in retail, been doing it about 3 years'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 7 },
            { type: 'CAPTURED_DATA_HAS', field: 'workBackground' }
          ]
        },

        // Step 7 monthly income
        { role: 'lead', content: '2k a month' },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 8 },
            {
              type: 'CAPTURED_DATA_VALUE',
              field: 'monthlyIncome',
              value: 2000
            }
          ]
        },

        // Step 8 replace vs supplement
        {
          role: 'lead',
          content: 'just on the side, looking for some extra to help with bills'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 9 },
            {
              type: 'CAPTURED_DATA_VALUE',
              field: 'replaceOrSupplement',
              value: 'supplement'
            }
          ]
        },

        // Step 9 income goal — critical test of source-scoping fix
        {
          role: 'lead',
          content: 'honestly just like 1k extra a month would change everything'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 10 },
            {
              type: 'CAPTURED_DATA_VALUE',
              field: 'incomeGoal',
              value: 1000
            }
          ]
        },

        // Step 10 verbatim with $1k substituted
        {
          role: 'lead',
          content:
            'honestly my wife and i just had a kid 6 months ago, want to give him a better start than i had'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 11 },
            { type: 'AI_MESSAGE_CONTAINS', value: 'I respect that bro' },
            { type: 'AI_MESSAGE_CONTAINS', value: '$1k' },
            { type: 'NO_TEMPLATE_LEAK' }
          ]
        },

        // Step 11 deep why probe
        {
          role: 'lead',
          content:
            'i just want to be the dad i never had, be home for bath time and story time'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 12 },
            { type: 'CAPTURED_DATA_HAS', field: 'deep_why' }
          ]
        },

        // Step 12 obstacle ID
        {
          role: 'lead',
          content:
            'honestly the emotional control, i know the rules but i break them every time'
        },
        {
          role: 'assertions',
          expect: [{ type: 'STEP_IS', value: 13 }]
        },

        // Step 13 belief break — CRITICAL CHECKPOINT (3 bubbles + ASK)
        {
          role: 'lead',
          content: 'yeah man like once red shows up my brain just snaps'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_IS', value: 14 },
            { type: 'AI_MESSAGE_CONTAINS', value: '99% of traders' },
            { type: 'AI_MESSAGE_CONTAINS', value: 'systems you have in place' },
            { type: 'AI_MESSAGE_CONTAINS', value: 'point A to point B' },
            {
              type: 'BRANCH_HISTORY_HAS_EVENT',
              step: 13,
              eventType: 'step_completed'
            }
          ]
        },

        // Step 14 buy-in
        {
          role: 'lead',
          content:
            'honestly bro that would change everything for me and my family'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'AI_MESSAGE_CONTAINS', value: 'ready' },
            { type: 'STEP_IS', value: 14 }
          ]
        },

        {
          role: 'lead',
          content: 'yeah man im ready, im tired of being stuck'
        },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_REACHED', value: 16 }, // Step 15 auto-skips via conditional skip
            {
              type: 'BRANCH_HISTORY_HAS_EVENT',
              step: 15,
              eventType: 'step_skipped'
            }
          ]
        },

        // Step 16 call proposal with Anthony + resolved variables
        { role: 'lead', content: 'yeah that would be huge, lets do it' },
        {
          role: 'assertions',
          expect: [
            { type: 'STEP_REACHED', value: 18 },
            { type: 'AI_MESSAGE_CONTAINS', value: 'Anthony' },
            { type: 'AI_MESSAGE_CONTAINS', value: 'emotional control' },
            { type: 'NO_TEMPLATE_LEAK' },
            { type: 'NO_QUALITY_GATE_FAILURE' }
          ]
        },

        // Step 18 capital question — CRITICAL TEST POINT
        { role: 'lead', content: 'i only got like 500 bucks left honestly' },
        {
          role: 'assertions',
          expect: [
            {
              type: 'CAPTURED_DATA_VALUE',
              field: 'verifiedCapitalUsd',
              value: 500
            },
            {
              type: 'CAPTURED_DATA_VALUE',
              field: 'capitalThresholdMet',
              value: false
            },
            {
              type: 'BRANCH_SELECTED',
              step: 19,
              value: 'Below $1500 — Downsell'
            }
          ]
        },

        // Step 19 downsell routing — THE WHOLE PURPOSE OF PERSONA B
        { role: 'lead', content: 'okay yeah what do you got' },
        {
          role: 'assertions',
          expect: [
            { type: 'LINK_SENT', urlContains: 'whop.com/checkout' },
            { type: 'AI_MESSAGE_CONTAINS', value: '$497' },
            { type: 'NO_QUALITY_GATE_FAILURE' },
            { type: 'NO_FABRICATED_URL' }
          ]
        }
      ]
    }
  ]
};
