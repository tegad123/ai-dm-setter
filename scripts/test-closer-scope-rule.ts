/* eslint-disable no-console */
// Tests for the R24c closer-scope rule (2026-05-02). Voice-gate
// hard fail must:
//   1. Fire when leadStage===UNQUALIFIED + reply name-checks the
//      configured closer
//   2. Fire when capitalOutcome===failed + reply contains generic
//      "on the call" pricing-defer language
//   3. NOT fire when the lead is qualified (normal Verified-Facts
//      pricing-on-call wording is fine for qualified leads)
//   4. Account-agnostic — closer name comes from options, no
//      hardcoded "Anthony"
//
// Plus static structural checks that the master prompt template
// has the {{closerScopeRule}} placeholder + the substitution path.
import { scoreVoiceQuality } from '../src/lib/voice-quality-gate';
import { readFileSync } from 'fs';
import { resolve } from 'path';

let pass = 0;
let fail = 0;
function record(label: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

// 1. Wout-style example: unqualified + closer name appears
const woutReply =
  'pricing is covered on the call with Anthony, it depends on which program fits you best.';
const r1 = scoreVoiceQuality(woutReply, {
  leadStage: 'UNQUALIFIED',
  closerNames: ['Anthony']
});
record(
  'unqualified + reply mentions Anthony → closer_or_call_in_downsell hard fail',
  r1.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// 2. capitalOutcome=failed + generic call-pitch (no closer name)
const r2 = scoreVoiceQuality(
  "let's hop on a quick call and break down what fits you bro",
  {
    capitalOutcome: 'failed',
    closerNames: []
  }
);
record(
  'failed capital + call-pitch language → hard fail (no closer name needed)',
  r2.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// 3. Different account, different closer name — same gate, no
//    hardcoded "Anthony"
const r3 = scoreVoiceQuality('Marcus will break it down on the call bro', {
  leadStage: 'UNQUALIFIED',
  closerNames: ['Marcus']
});
record(
  'account-agnostic: Marcus name-checked → hard fail (no Anthony hardcoding)',
  r3.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// 4. Qualified lead — same wording is fine
const r4 = scoreVoiceQuality(
  'pricing is covered on the call with Anthony bro',
  {
    leadStage: 'BOOKED',
    capitalOutcome: 'passed',
    closerNames: ['Anthony']
  }
);
record(
  'qualified lead + same wording → does NOT hard fail',
  !r4.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// 5. Unqualified + clean downsell pitch (no closer / no call) — no
//    false positive
const r5 = scoreVoiceQuality(
  "it's a one-time $497 bro, you get the full course on demand",
  {
    leadStage: 'UNQUALIFIED',
    closerNames: ['Anthony']
  }
);
record(
  'unqualified + clean downsell pitch → no false positive',
  !r5.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// 6. Pricing-defer-to-call without closer name still flags
const r6 = scoreVoiceQuality(
  'pricing gets discussed on the call bro, depends on the program',
  {
    leadStage: 'UNQUALIFIED',
    closerNames: []
  }
);
record(
  'pricing deferred to call → hard fail even with no configured closer',
  r6.hardFails.some((f) => f.includes('closer_or_call_in_downsell:'))
);

// Static structural checks
const root = resolve(__dirname, '..');
const ai = readFileSync(resolve(root, 'src/lib/ai-prompts.ts'), 'utf-8');
const aiEngine = readFileSync(resolve(root, 'src/lib/ai-engine.ts'), 'utf-8');

record(
  'master prompt: R24c rule with {{closerScopeRule}} placeholder',
  /R24c:\s+CLOSER AND CALL REFERENCES ARE FOR QUALIFIED LEADS ONLY\.\s+\{\{closerScopeRule\}\}/.test(
    ai
  )
);
record(
  'closerScopeRule substitution path exists (uses ${closerName} dynamically)',
  /closerScopeRuleText\s*=[\s\S]{0,300}\$\{closerName\}/.test(ai) &&
    /prompt\.replace\(\/\\\{\\\{closerScopeRule\\\}\\\}\/g/.test(ai)
);
record(
  'verified facts unqualified branch uses dynamic ${closerLabel}, not hardcoded "Anthony"',
  /closerLabel\s*=\s*closerName\s*\|\|\s*'the\s+closer'/.test(ai) &&
    !/Anthony will break it down/.test(ai)
);
record(
  'voice-gate options interface declares closerNames',
  /closerNames\?:\s*string\[\]/.test(
    readFileSync(resolve(root, 'src/lib/voice-quality-gate.ts'), 'utf-8')
  )
);
record(
  'ai-engine wires closerNames into scoreVoiceQualityGroup options',
  /priorMessageCorpus[\s\S]{0,600}closerNames\s*\n\s*}\)/m.test(aiEngine)
);
record(
  'ai-engine retry directive renamed to closer-only (no Anthony in code)',
  /closerOrCallInDownsellFailed/.test(aiEngine) &&
    /NO CLOSER \/ NO CALL IN DOWNSELL/.test(aiEngine) &&
    !/anthonyOrCallInDownsellFailed/.test(aiEngine)
);

console.log(
  `\n${pass}/${pass + fail} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
