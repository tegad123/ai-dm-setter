/**
 * Regression coverage for the script-stage self-recovery layer.
 *
 * Run: npx tsx scripts/test-script-state-recovery.ts
 */

import assert from 'node:assert/strict';
import {
  evaluateRoutingCondition,
  extractCapturedDataPointsForTest,
  hasExplicitCapitalConstraintSignal,
  isStepComplete
} from '@/lib/script-state-recovery';
import { scoreVoiceQualityGroup } from '@/lib/voice-quality-gate';

function point<T = unknown>(points: Record<string, any>, key: string) {
  return points[key] as
    | {
        value: T;
        confidence: 'HIGH' | 'MEDIUM' | 'LOW';
        extractionMethod: string;
      }
    | undefined;
}

function assertHigh<T>(
  points: Record<string, any>,
  key: string,
  expectedValue: T,
  label: string
) {
  const p = point<T>(points, key);
  assert.ok(p, `${label}: point exists`);
  assert.equal(p?.confidence, 'HIGH', `${label}: confidence HIGH`);
  assert.deepEqual(p?.value, expectedValue, `${label}: value`);
}

function run() {
  const martinPoints = extractCapturedDataPointsForTest({
    minimumCapitalRequired: 1000,
    history: [
      {
        id: 'ai_capital_q',
        sender: 'AI',
        content: 'do you have at least 1000 usd set aside for that right now?',
        timestamp: new Date('2026-05-03T08:00:00Z')
      },
      {
        id: 'lead_yes',
        sender: 'LEAD',
        content: 'Yea I have',
        timestamp: new Date('2026-05-03T08:01:00Z')
      }
    ]
  });
  assertHigh(martinPoints, 'verifiedCapitalUsd', 1000, 'Martin binary yes');
  assertHigh(martinPoints, 'capitalThresholdMet', true, 'Martin threshold');
  assert.equal(
    point(martinPoints, 'capitalAnswerType')?.extractionMethod,
    'binary_yes_at_threshold',
    'Martin extraction method'
  );

  const uncertainPoints = extractCapturedDataPointsForTest({
    minimumCapitalRequired: 1000,
    history: [
      {
        id: 'ai_capital_q',
        sender: 'AI',
        content: 'do you have at least 1000 usd set aside for that right now?',
        timestamp: new Date('2026-05-03T08:00:00Z')
      },
      {
        id: 'lead_probably',
        sender: 'LEAD',
        content: 'probably, i think so',
        timestamp: new Date('2026-05-03T08:01:00Z')
      }
    ]
  });
  assert.notEqual(
    point(uncertainPoints, 'verifiedCapitalUsd')?.confidence,
    'HIGH',
    'uncertain capital must not become HIGH-confidence capital'
  );

  assert.equal(
    hasExplicitCapitalConstraintSignal(
      'capital and lack of knowledge is my problem'
    ),
    true,
    'explicit capital + knowledge signal is caught'
  );

  assert.equal(
    evaluateRoutingCondition({
      condition: 'value >= minimumCapitalRequired',
      value: 1000,
      minimumCapitalRequired: 1000
    }),
    true,
    'threshold route matches'
  );
  assert.equal(
    evaluateRoutingCondition({
      condition: 'value < minimumCapitalRequired',
      value: 500,
      minimumCapitalRequired: 1000
    }),
    true,
    'downsell route matches'
  );

  const step = {
    completionRule: {
      type: 'data_captured',
      fields: ['verifiedCapitalUsd']
    }
  } as any;
  assert.equal(
    isStepComplete(step, martinPoints),
    true,
    'HIGH-confidence data completes the step'
  );
  assert.equal(
    isStepComplete(step, uncertainPoints),
    false,
    'LOW/MEDIUM confidence does not complete the step'
  );

  const recoveryQuality = scoreVoiceQualityGroup([
    "bet bro, here's the application: https://form.typeform.com/to/AGUtPdmb",
    "fill it out and lmk once it's sent through"
  ]);
  assert.equal(
    recoveryQuality.hardFails.length,
    0,
    `deterministic recovery message has no hard voice-gate failures: ${recoveryQuality.hardFails.join(', ')}`
  );

  console.log('script-state recovery tests passed');
}

run();
