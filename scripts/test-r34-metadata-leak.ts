import assert from 'node:assert/strict';
import {
  detectMetadataLeak,
  scoreVoiceQualityGroup,
  surgicalStripMetadataLeak
} from '../src/lib/voice-quality-gate';

function assertLeak(text: string, label: string) {
  const result = detectMetadataLeak(text);
  assert.equal(
    result.leak,
    true,
    `${label} should be detected as metadata leak`
  );
  assert.ok(result.matchedText, `${label} should include matched text`);
}

function assertNoLeak(text: string, label: string) {
  const result = detectMetadataLeak(text);
  assert.equal(result.leak, false, `${label} should not be a metadata leak`);
}

function main() {
  const leaked =
    'run through it at your own pace stage_confidence:1.0 and if you want the full 1 on 1 later, we can go from there';
  const leakResult = detectMetadataLeak(leaked);
  assert.equal(leakResult.leak, true, 'stage_confidence should be detected');
  assert.equal(leakResult.matchedText, 'stage_confidence:1.0');

  const stripped = surgicalStripMetadataLeak(
    leaked,
    leakResult.matchedText ?? ''
  );
  assert.equal(stripped.success, true, 'surgical strip should succeed');
  assert.equal(
    stripped.content,
    'run through it at your own pace and if you want the full 1 on 1 later, we can go from there'
  );
  assertNoLeak(stripped.content, 'stripped content');

  const quality = scoreVoiceQualityGroup([leaked]);
  assert.equal(quality.passed, false, 'R34 leak should fail quality gate');
  assert.ok(
    quality.hardFails.some((failure) => failure.includes('r34_metadata_leak:')),
    'quality gate should include r34_metadata_leak hard fail'
  );

  const leakCases: Array<[string, string]> = [
    ['stage:BOOKING', 'stage field'],
    ['intent:HOT_LEAD', 'intent field'],
    ['[BOOKING LINK]', 'bracketed placeholder'],
    ['{{name}}', 'template placeholder'],
    ['{"stage":"BOOKING","stage_confidence":1}', 'json fragment'],
    ['(debug: chose soft pitch)', 'debug annotation'],
    ['next_action:send_typeform', 'next action field']
  ];
  for (const [text, label] of leakCases) {
    assertLeak(text, label);
  }

  const allowedCases: Array<[string, string]> = [
    ["let's talk at 3:00 pm cst", 'time with colon'],
    ['https://whop.com/checkout/abc123', 'plain URL'],
    ["Anthony: he's our lead trader", 'proper noun colon'],
    ['the ratio is 2:1', 'ratio']
  ];
  for (const [text, label] of allowedCases) {
    assertNoLeak(text, label);
  }

  console.log('R34 metadata leak tests passed');
}

main();
