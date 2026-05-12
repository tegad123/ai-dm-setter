// Template for a new persona test file. Copy this to
// <persona-slug>.persona.ts, edit the slug + scenarios, and the runner
// auto-discovers it.
//
// The leading underscore prevents auto-discovery so this file is never
// executed as part of the harness run.

import type { PersonaScenario } from '../types';

export const persona: PersonaScenario = {
  slug: 'example-persona',
  personaConfig: {
    personaName: 'Example Persona',
    fullName: 'Example Lead Persona',
    systemPrompt: 'You are an example AI. Reply briefly.',
    minimumCapitalRequired: 500
  },
  scenarios: [
    {
      id: 'hello-world',
      turns: [
        { role: 'lead', content: 'hi' },
        {
          role: 'assertions',
          expect: [{ type: 'AI_REPLY_NOT_EMPTY' }]
        }
      ]
    }
  ]
};
