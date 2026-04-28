/* eslint-disable no-console */
// Regression coverage for Eucanmax Lane 2026-04-28:
//   1. R2000 ZAR is converted to USD and rejected
//   2. larger ZAR amounts can still pass
//   3. common non-USD currencies are detected
//   4. failed-capital call pitches are blocked before send
//   5. GBP and USD behavior still works

import {
  buildR24BlockedFallbackMessage,
  convertCapitalAmountToUsd,
  detectConversationCurrency,
  detectCurrencyFromText,
  parseLeadCapitalAnswer
} from '../src/lib/ai-engine';
import { matchFailedCapitalBookingPitch } from '../src/lib/webhook-processor';

let pass = 0;
let fail = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

function expectApprox(
  label: string,
  actual: number,
  expected: number,
  tolerance = 1
) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${label}\n      expected: ${expected} ±${tolerance}\n      actual:   ${actual}`
    );
  }
}

async function main() {
  const threshold = 1000;

  console.log('\n[TEST 1] R2000 ZAR detected and rejected');
  const zar2k = parseLeadCapitalAnswer('R2000');
  expect('R2000 parses as amount', zar2k.amount, 2000);
  expect('R2000 parses as ZAR', zar2k.currency, 'ZAR');
  const zar2kUsd = convertCapitalAmountToUsd(zar2k.amount ?? 0, zar2k.currency);
  expectApprox('R2000 converts to about $108 USD', zar2kUsd, 108);
  expect('R2000 is below $1,000 threshold', zar2kUsd < threshold, true);

  console.log('\n[TEST 2] R20000 ZAR passes');
  const zar20k = parseLeadCapitalAnswer('R20000');
  expect('R20000 parses as ZAR', zar20k.currency, 'ZAR');
  const zar20kUsd = convertCapitalAmountToUsd(
    zar20k.amount ?? 0,
    zar20k.currency
  );
  expectApprox('R20000 converts to about $1,081 USD', zar20kUsd, 1081);
  expect('R20000 clears $1,000 threshold', zar20kUsd >= threshold, true);

  console.log('\n[TEST 3] NGN and other currencies detected');
  const ngn = parseLeadCapitalAnswer('₦200,000');
  expect('₦200,000 parses as NGN', ngn.currency, 'NGN');
  expectApprox(
    '₦200,000 converts to about $125 USD',
    convertCapitalAmountToUsd(ngn.amount ?? 0, ngn.currency),
    125
  );
  expect('rand word detects ZAR', detectCurrencyFromText('2000 rand'), 'ZAR');
  expect('GHS detects cedi', detectCurrencyFromText('3000 cedi'), 'GHS');
  expect('KES detects ksh', detectCurrencyFromText('ksh 20000'), 'KES');
  expect('PHP detects peso symbol', detectCurrencyFromText('₱20000'), 'PHP');
  expect('UGX detects ugx', detectCurrencyFromText('ugx 500000'), 'UGX');
  expect('EUR detects euro symbol', detectCurrencyFromText('€1000'), 'EUR');
  expect(
    'CAD detects compact suffix',
    detectCurrencyFromText('3700CAD'),
    'CAD'
  );
  expect(
    'detectConversationCurrency uses candidate text before DB scan',
    await detectConversationCurrency('not-a-real-conversation', ['R2000']),
    'ZAR'
  );

  console.log('\n[TEST 4] R24 blocks failed-capital call pitch before send');
  const unsafePitch =
    "let's hop on a quick call with the closer and get you set up";
  expect(
    'ship-time detector catches failed-capital call pitch',
    Boolean(matchFailedCapitalBookingPitch(unsafePitch)),
    true
  );
  const fallback = buildR24BlockedFallbackMessage(
    'answer_below_threshold',
    threshold,
    {
      parsedAmount: zar2k.amount,
      parsedCurrency: zar2k.currency,
      parsedAmountUsd: zar2kUsd
    }
  );
  expect('fallback routes to downsell branch', fallback.subStage, 'LOW_TICKET');
  expect(
    'fallback contains no call proposal',
    matchFailedCapitalBookingPitch(fallback.message),
    null
  );

  console.log('\n[TEST 5] GBP still works');
  const gbp = parseLeadCapitalAnswer('£1,000');
  expect('£1,000 parses as GBP', gbp.currency, 'GBP');
  expectApprox(
    '£1,000 converts to about $1,250 USD',
    convertCapitalAmountToUsd(gbp.amount ?? 0, gbp.currency),
    1250
  );
  expect(
    '£1,000 clears $1,000 threshold',
    convertCapitalAmountToUsd(gbp.amount ?? 0, gbp.currency) >= threshold,
    true
  );

  console.log('\n[TEST 6] USD unaffected');
  const usd = parseLeadCapitalAnswer('$1,500');
  expect('USD amount parses normally', usd.amount, 1500);
  expect('USD amount carries USD currency', usd.currency, 'USD');
  expect(
    '$1,500 stays $1,500 after conversion',
    convertCapitalAmountToUsd(usd.amount ?? 0, usd.currency),
    1500
  );

  console.log('\n----');
  console.log(`PASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
