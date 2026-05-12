// Persona B — capital-disqualified trader, $500 → SLM downsell at Step 19.
//
// IMPORTANT: This file ships with a placeholder personaConfig so the
// harness compiles and auto-discovers the scenario. The scenario
// assertions (branchHistory events, step transitions, $497 SLM link,
// "Anthony", "$1k") are written against the REAL production Persona B
// behavior. Running them against the placeholder config below will
// FAIL — that's expected.
//
// To get a meaningful pass/fail signal:
//
// 1. Dump the real persona config from production into the test DB
//    via scripts/dump-daetradez-persona.ts (or equivalent). The dump
//    should populate the real systemPrompt, rawScript, qualificationFlow,
//    downsellConfig (with $497 SLM link), promptConfig (with Anthony as
//    closer), and the parsed Script + ScriptStep + ScriptBranch rows.
//
// 2. Replace the personaConfig block below with the dumped values, OR
//    add a `loadFromTestDb: { accountSlug, personaId }` field (not yet
//    supported — file a follow-up).
//
// 3. The Script-step model (ScriptStep, ScriptBranch) is NOT seeded by
//    this harness — it must already exist in the test DB for the
//    step-based assertions to fire correctly.
//
// Until step 1+2 are done, expect this scenario to surface as FAIL on
// most step/branch assertions. Quality-gate / template-leak / fabricated-
// URL assertions will still produce meaningful signal against any persona.

import type { PersonaScenario } from '../types';

const SYNTHETIC_SYSTEM_PROMPT = `Placeholder system prompt for Persona B harness compilation.

This must be replaced with the real production Persona B systemPrompt
(closer: Anthony, minimum capital: $1500, SLM downsell at $497) before
the scenario assertions below will produce reliable signal.
`;

export const persona: PersonaScenario = {
  slug: 'persona-b-capital-disqualified',
  description:
    'Capital-disqualified trader with $500, should route to SLM downsell at Step 19',
  personaConfig: {
    personaName: 'Persona B (Harness)',
    fullName: 'Dae Harness — Persona B',
    companyName: 'DAE Trading',
    tone: 'casual, direct',
    systemPrompt: SYNTHETIC_SYSTEM_PROMPT,
    promptConfig: {
      whatYouSell: 'trading mentorship',
      closerName: 'Anthony',
      bookingTypeformUrl: 'https://test.qualifydms.io/apply',
      downsellLink: 'https://whop.com/checkout/persona-b-slm-497'
    },
    downsellConfig: {
      productName: 'Self-Led Mastery (SLM)',
      price: 497,
      pitchMessage:
        'self-paced trading mastery while you build the capital base',
      link: 'https://whop.com/checkout/persona-b-slm-497'
    },
    minimumCapitalRequired: 1500,
    freeValueLink: 'https://test.qualifydms.io/youtube'
  },
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
            { type: 'CAPTURED_DATA_HAS', field: 'tradingTenure' },
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
            { type: 'CAPTURED_DATA_HAS', field: 'early_obstacle' }
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
            { type: 'CAPTURED_DATA_HAS', field: 'deepWhy' }
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
