import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildContextualSilentStopReEngagementForTest,
  buildManyChatOpeningRecoveryForTest,
  isManyChatOpeningHandoffForTest,
  type StalledConversation
} from '../src/lib/silent-stop-recovery';
import { extractCapturedDataPointsForTest } from '../src/lib/script-state-recovery';
import { scoreVoiceQualityGroup } from '../src/lib/voice-quality-gate';

const now = new Date('2026-05-03T15:00:00.000Z');

const capitalQuestion = {
  id: 'ai_capital_q',
  sender: 'AI',
  content: 'do you have at least 1000 usd set aside for that right now?',
  timestamp: now
};

const highConfidence = extractCapturedDataPointsForTest({
  minimumCapitalRequired: 1000,
  history: [
    capitalQuestion,
    {
      id: 'lead_yes',
      sender: 'LEAD',
      content: 'Yea I have',
      timestamp: new Date(now.getTime() + 1000)
    }
  ]
});

assert.equal(highConfidence.verifiedCapitalUsd?.value, 1000);
assert.equal(highConfidence.verifiedCapitalUsd?.confidence, 'HIGH');
assert.equal(highConfidence.capitalThresholdMet?.value, true);
assert.equal(
  highConfidence.capitalAnswerType?.value,
  'binary_yes_at_threshold'
);

for (const uncertain of ['probably', 'I think so', 'maybe I can find some']) {
  const points = extractCapturedDataPointsForTest({
    minimumCapitalRequired: 1000,
    history: [
      capitalQuestion,
      {
        id: `lead_${uncertain}`,
        sender: 'LEAD',
        content: uncertain,
        timestamp: new Date(now.getTime() + 1000)
      }
    ]
  });
  assert.equal(points.verifiedCapitalUsd, undefined);
  assert.equal(points.capitalThresholdMet, undefined);
}

const staleUnqualifiedDurableState = extractCapturedDataPointsForTest({
  existing: {
    verifiedCapitalUsd: {
      value: 0,
      confidence: 'HIGH',
      extractedFromMessageId: null,
      extractionMethod: 'durable_capital_state',
      extractedAt: now.toISOString()
    },
    capitalThresholdMet: {
      value: false,
      confidence: 'HIGH',
      extractedFromMessageId: null,
      extractionMethod: 'durable_capital_state',
      extractedAt: now.toISOString()
    }
  },
  durableStatus: 'VERIFIED_UNQUALIFIED',
  durableAmount: null,
  minimumCapitalRequired: 1000,
  history: [
    {
      id: 'lead_faith',
      sender: 'LEAD',
      content: "I'm trusting the lord's timing",
      timestamp: now
    }
  ]
});
assert.equal(staleUnqualifiedDurableState.verifiedCapitalUsd, undefined);
assert.equal(staleUnqualifiedDurableState.capitalThresholdMet, undefined);

const explicitUnqualifiedDurableState = extractCapturedDataPointsForTest({
  durableStatus: 'VERIFIED_UNQUALIFIED',
  durableAmount: null,
  minimumCapitalRequired: 1000,
  history: [
    {
      id: 'lead_no_capital',
      sender: 'LEAD',
      content: "i don't have any capital right now",
      timestamp: now
    }
  ]
});
assert.equal(explicitUnqualifiedDurableState.verifiedCapitalUsd?.value, 0);
assert.equal(explicitUnqualifiedDurableState.capitalThresholdMet?.value, false);

const faithBridge = buildContextualSilentStopReEngagementForTest(
  "I'm trusting the lord's timing"
);
assert.equal(faithBridge?.action, 'faith_respectful_capital_bridge');
assert.ok(
  faithBridge?.messages.join(' ').includes('capital situation'),
  'faith bridge should move to capital qualification'
);
assert.equal(scoreVoiceQualityGroup(faithBridge?.messages ?? []).passed, true);

const manyChatOpeningConversation = {
  id: 'manychat_opening',
  source: 'MANYCHAT',
  manyChatOpenerMessage:
    'yo bro appreciate the follow, i can send the Session Liquidity Model over',
  capturedDataPoints: {},
  silentStopCount: 3,
  distressDetected: false,
  lead: {
    id: 'lead_manychat',
    accountId: 'account_daniel',
    name: 'Shukran Azizi',
    handle: 'shukran_azizi202'
  },
  messages: [
    {
      id: 'lead_accept',
      sender: 'LEAD',
      content: 'Yes send it over!',
      timestamp: new Date(now.getTime() + 2000)
    },
    {
      id: 'ai_bad_prior',
      sender: 'AI',
      content: 'perfect this gonna make you dangerous',
      timestamp: new Date(now.getTime() + 1000)
    }
  ]
} as unknown as StalledConversation;

assert.equal(
  isManyChatOpeningHandoffForTest(manyChatOpeningConversation),
  true,
  'ManyChat opener accepts with empty discovery data should be treated as opening handoffs'
);
const manyChatRecovery = buildManyChatOpeningRecoveryForTest(
  manyChatOpeningConversation
);
const manyChatText = manyChatRecovery.messages.join(' ');
assert.equal(manyChatRecovery.stage, 'DISCOVERY');
assert.match(manyChatText, /Session Liquidity Model/i);
assert.match(manyChatText, /trading background|been at it|pretty new/i);
assert.doesNotMatch(manyChatText, /capital|budget|set aside|\$\d/i);
assert.equal(
  scoreVoiceQualityGroup(manyChatRecovery.messages, {
    conversationSource: 'MANYCHAT',
    aiMessageCount: 2,
    capturedDataPoints: {}
  }).passed,
  true,
  'ManyChat recovery bridge should pass the voice gate'
);

const prompt = readFileSync(
  join(process.cwd(), 'src/lib/ai-prompts.ts'),
  'utf8'
);
assert.ok(
  prompt.includes('R35: NO TONALITY-BASED UNQUALIFIED TAGGING'),
  'master prompt must include R35 tonality guard'
);

const recoverySource = readFileSync(
  join(process.cwd(), 'src/lib/script-state-recovery.ts'),
  'utf8'
);
assert.ok(
  recoverySource.includes(
    'ScriptAction rows are the operator-controlled source of truth'
  ),
  'artifact recovery must use script-level URLs as source of truth'
);

const manyChatHandoffSource = readFileSync(
  join(process.cwd(), 'src/lib/manychat-handoff.ts'),
  'utf8'
);
assert.ok(
  manyChatHandoffSource.includes('looksLikeInstagramRecipientId') &&
    manyChatHandoffSource.includes('manyChatSubscriberId') &&
    manyChatHandoffSource.includes('^\\d{12,}$') &&
    manyChatHandoffSource.includes('scheduleAi=false') &&
    manyChatHandoffSource.includes('Skipping AI schedule'),
  'ManyChat handoff must not schedule AI early unless explicitly configured and must reject Contact Id'
);

const webhookProcessorSource = readFileSync(
  join(process.cwd(), 'src/lib/webhook-processor.ts'),
  'utf8'
);
assert.ok(
  webhookProcessorSource.includes('canShipToPlatformRecipient') &&
    webhookProcessorSource.includes('^\\d{12,}$') &&
    webhookProcessorSource.includes('looksLikeManyChatAutomationEcho') &&
    webhookProcessorSource.includes('manychat-automation') &&
    webhookProcessorSource.includes('unsendableManyChatRecipient'),
  'webhook processor must skip unsendable ManyChat recipients and not treat ManyChat automation as human takeover'
);

const aiEngineSource = readFileSync(
  join(process.cwd(), 'src/lib/ai-engine.ts'),
  'utf8'
);
assert.ok(
  aiEngineSource.includes(
    "m.sender === 'AI' && m.systemPromptVersion !== 'manychat-automation'"
  ),
  'ManyChat automation messages must not count as QualifyDMs AI pacing turns'
);
assert.ok(
  !aiEngineSource.includes('COURSE_URL_FALLBACK'),
  'AI engine must not keep a hardcoded course/payment fallback URL'
);

console.log('silent-stop recovery tests passed');
