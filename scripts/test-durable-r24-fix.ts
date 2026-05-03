/* eslint-disable no-console */
import { buildR24BlockedFallbackMessage } from '../src/lib/ai-engine';
import { scoreVoiceQualityGroup } from '../src/lib/voice-quality-gate';

let pass = 0;
let fail = 0;

function record(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

const cannedBelowThreshold = buildR24BlockedFallbackMessage(
  'answer_below_threshold',
  2000,
  {
    parsedAmount: 12,
    parsedCurrency: 'USD',
    parsedAmountUsd: 12
  }
);

const gatedBelowThreshold = scoreVoiceQualityGroup(
  [cannedBelowThreshold.message],
  {
    capitalOutcome: 'failed',
    leadStage: 'UNQUALIFIED',
    capitalVerificationRequired: true,
    capitalVerificationSatisfied: false,
    priorMessageCorpus: 'lead said they had 12 hours until the call'
  }
);

record(
  'canned R24 below-threshold fallback is not allowed to bypass voice gate',
  !gatedBelowThreshold.passed &&
    gatedBelowThreshold.hardFails.some((failure) =>
      failure.includes('closer_or_call_in_downsell:')
    ),
  `hardFails=${gatedBelowThreshold.hardFails.join(', ')}`
);

const cannedVagueCapital = buildR24BlockedFallbackMessage(
  'answer_vague_capital',
  2000,
  {
    parsedAmount: null,
    parsedCurrency: null,
    parsedAmountUsd: null
  }
);

const gatedVagueCapital = scoreVoiceQualityGroup([cannedVagueCapital.message], {
  capitalVerificationRequired: true,
  capitalVerificationSatisfied: false
});

record(
  'canned R24 vague-capital fallback catches em dash before delivery',
  !gatedVagueCapital.passed &&
    gatedVagueCapital.hardFails.some((failure) => failure.includes('em_dash')),
  `hardFails=${gatedVagueCapital.hardFails.join(', ')}`
);

console.log(
  `\n${pass}/${pass + fail} passed${fail > 0 ? `, ${fail} failed` : ''}`
);
if (fail > 0) process.exit(1);
