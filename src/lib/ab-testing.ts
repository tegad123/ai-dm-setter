// ─── A/B Testing Engine — Phase 3 Self-Optimizing Layer ─────────────────────
// Deterministic variant assignment, message resolution, outcome tracking,
// and statistical significance testing for conversation stage experiments.

import { createHash } from 'crypto';
import type { ABTest } from '@prisma/client';
import prisma from '@/lib/prisma';

// ─── Types ──────────────────────────────────────────────

export interface ABTestResult {
  responses: number;
  total: number;
  responseRate: number;
  bookings: number;
  bookingRate: number;
}

export interface SignificanceResult {
  significant: boolean;
  pValue: number;
  winner: string | null;
}

export interface ResolvedVariant {
  message: string;
  testId: string | null;
  variant: string | null;
}

// ─── 1. Deterministic Variant Assignment ─────────────────

/**
 * Assign a variant deterministically using SHA-256 hash.
 * Same lead + test combination always produces the same variant.
 */
export function assignVariant(leadId: string, testId: string): 'A' | 'B' {
  const hash = createHash('sha256').update(`${leadId}:${testId}`).digest('hex');

  // Convert hex hash to BigInt and mod 2
  const hashBigInt = BigInt(`0x${hash}`);
  return hashBigInt % BigInt(2) === BigInt(0) ? 'A' : 'B';
}

// ─── 2. Active Test Lookup ───────────────────────────────

/**
 * Find a RUNNING A/B test for the given account and conversation stage.
 * Uses case-insensitive contains match on the stage field.
 */
export async function getActiveTestForStage(
  accountId: string,
  stage: string
): Promise<ABTest | null> {
  if (!stage) return null;

  const test = await prisma.aBTest.findFirst({
    where: {
      accountId,
      status: 'RUNNING',
      stage: {
        contains: stage,
        mode: 'insensitive'
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  return test;
}

// ─── 3. Message Variant Resolution ───────────────────────

/**
 * Check for an active A/B test at the current conversation stage.
 * If found, deterministically assign a variant, upsert the assignment,
 * and return the variant's message. Otherwise return the default message.
 */
export async function resolveMessageVariant(
  accountId: string,
  leadId: string,
  stage: string,
  defaultMessage: string
): Promise<ResolvedVariant> {
  if (!leadId || !stage) {
    return { message: defaultMessage, testId: null, variant: null };
  }

  const test = await getActiveTestForStage(accountId, stage);
  if (!test) {
    return { message: defaultMessage, testId: null, variant: null };
  }

  const variant = assignVariant(leadId, test.id);

  // Upsert the assignment so we track which variant this lead received
  await prisma.aBTestAssignment.upsert({
    where: {
      testId_leadId: {
        testId: test.id,
        leadId
      }
    },
    update: {}, // Already assigned — no change needed
    create: {
      testId: test.id,
      leadId,
      variant
    }
  });

  const message = variant === 'A' ? test.variantA : test.variantB;

  return {
    message,
    testId: test.id,
    variant
  };
}

// ─── 4. Outcome Recording ────────────────────────────────

/**
 * Record an outcome for an A/B test variant. Increments the count for the
 * variant and updates the running results JSON with response/booking rates.
 * Auto-completes the test when both variants reach sampleSizeTarget.
 */
export async function recordABTestOutcome(
  testId: string,
  variant: string,
  gotResponse: boolean,
  booked: boolean
): Promise<void> {
  const test = await prisma.aBTest.findUnique({
    where: { id: testId }
  });

  if (!test || test.status !== 'RUNNING') return;

  const isA = variant === 'A';

  // Parse existing results or start fresh
  const currentResults = (
    isA ? test.resultsA : test.resultsB
  ) as ABTestResult | null;
  const results: ABTestResult = currentResults ?? {
    responses: 0,
    total: 0,
    responseRate: 0,
    bookings: 0,
    bookingRate: 0
  };

  // Increment running totals
  results.total += 1;
  if (gotResponse) results.responses += 1;
  if (booked) results.bookings += 1;
  results.responseRate =
    results.total > 0 ? results.responses / results.total : 0;
  results.bookingRate =
    results.total > 0 ? results.bookings / results.total : 0;

  // Build the update payload
  const newCount = (isA ? test.countA : test.countB) + 1;
  const updateData: Record<string, unknown> = isA
    ? { countA: newCount, resultsA: results }
    : { countB: newCount, resultsB: results };

  // Check if we should auto-complete
  const otherCount = isA ? test.countB : test.countA;
  if (
    newCount >= test.sampleSizeTarget &&
    otherCount >= test.sampleSizeTarget
  ) {
    // Both variants have reached the target — determine winner
    const resultsA = isA ? results : (test.resultsA as ABTestResult | null);
    const resultsB = isA ? (test.resultsB as ABTestResult | null) : results;
    const finalCountA = isA ? newCount : test.countA;
    const finalCountB = isA ? test.countB : newCount;

    const significance = checkStatisticalSignificance(
      resultsA,
      resultsB,
      finalCountA,
      finalCountB
    );

    updateData.status = 'COMPLETED';
    updateData.completedAt = new Date();
    updateData.winner = significance.winner ?? 'INCONCLUSIVE';
  }

  await prisma.aBTest.update({
    where: { id: testId },
    data: updateData
  });
}

// ─── 5. Statistical Significance (Chi-Squared) ──────────

/**
 * Chi-squared test comparing response rates between variants A and B.
 * Returns significance at p < 0.05.
 */
export function checkStatisticalSignificance(
  resultsA: ABTestResult | Record<string, unknown> | null,
  resultsB: ABTestResult | Record<string, unknown> | null,
  countA: number,
  countB: number
): SignificanceResult {
  if (!resultsA || !resultsB || countA === 0 || countB === 0) {
    return { significant: false, pValue: 1, winner: null };
  }

  const responsesA = (resultsA as ABTestResult).responses ?? 0;
  const responsesB = (resultsB as ABTestResult).responses ?? 0;
  const noResponseA = countA - responsesA;
  const noResponseB = countB - responsesB;

  const total = countA + countB;
  const totalResponses = responsesA + responsesB;
  const totalNoResponses = noResponseA + noResponseB;

  // Avoid division by zero
  if (totalResponses === 0 || totalNoResponses === 0) {
    return { significant: false, pValue: 1, winner: null };
  }

  // Expected values for chi-squared
  const expectedResponseA = (countA * totalResponses) / total;
  const expectedNoResponseA = (countA * totalNoResponses) / total;
  const expectedResponseB = (countB * totalResponses) / total;
  const expectedNoResponseB = (countB * totalNoResponses) / total;

  // Chi-squared statistic with Yates' continuity correction
  const chiSquared =
    Math.pow(Math.abs(responsesA - expectedResponseA) - 0.5, 2) /
      expectedResponseA +
    Math.pow(Math.abs(noResponseA - expectedNoResponseA) - 0.5, 2) /
      expectedNoResponseA +
    Math.pow(Math.abs(responsesB - expectedResponseB) - 0.5, 2) /
      expectedResponseB +
    Math.pow(Math.abs(noResponseB - expectedNoResponseB) - 0.5, 2) /
      expectedNoResponseB;

  // p-value approximation for 1 degree of freedom using survival function
  // chi-squared CDF for 1 df: P(X <= x) = erf(sqrt(x/2))
  // p-value = 1 - CDF = erfc(sqrt(x/2))
  const pValue = erfc(Math.sqrt(chiSquared / 2));

  const significant = pValue < 0.05;

  let winner: string | null = null;
  if (significant) {
    const rateA = countA > 0 ? responsesA / countA : 0;
    const rateB = countB > 0 ? responsesB / countB : 0;
    winner = rateA > rateB ? 'A' : rateB > rateA ? 'B' : null;
  }

  return { significant, pValue, winner };
}

// ─── Complementary Error Function Approximation ──────────

/**
 * Approximation of the complementary error function erfc(x).
 * Uses Horner form of Abramowitz & Stegun approximation 7.1.26.
 */
function erfc(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 1 - sign * y;
}
