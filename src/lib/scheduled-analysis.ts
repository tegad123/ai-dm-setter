// ─── Scheduled Analysis Engine — Phase 5 Self-Optimizing Layer ───────────────
// Runs daily to calculate KPIs, collect effectiveness/optimization data,
// check cold start status, and auto-determine A/B test winners.

import prisma from '@/lib/prisma';
import {
  calculateMessageEffectiveness,
  type MessageScore
} from '@/lib/effectiveness-scorer';
import {
  generateOptimizations,
  type OptimizationResult
} from '@/lib/optimization-engine';
import { checkColdStart, type ColdStartCheck } from '@/lib/cold-start';
import {
  checkStatisticalSignificance,
  type ABTestResult
} from '@/lib/ab-testing';

// ─── Types ──────────────────────────────────────────────

export interface SummaryKPIs {
  totalResolved: number;
  bookingRate: number;
  showRate: number;
  closeRate: number;
  avgRevenuePerClose: number;
  avgMessagesToBook: number;
}

export interface CompletedTestSummary {
  testId: string;
  testName: string;
  stage: string;
  winner: string;
  pValue: number;
  countA: number;
  countB: number;
}

export interface AnalysisReport {
  accountId: string;
  timestamp: Date;
  effectivenessScores: MessageScore[];
  optimizations: OptimizationResult[];
  coldStart: ColdStartCheck;
  kpis: SummaryKPIs;
  completedTests: CompletedTestSummary[];
}

// ─── 1. Run Daily Analysis for a Single Account ──────────

export async function runDailyAnalysis(
  accountId: string
): Promise<AnalysisReport> {
  const timestamp = new Date();

  // Run effectiveness, optimizations, and cold start in parallel
  const [effectivenessScores, optimizations, coldStart] = await Promise.all([
    calculateMessageEffectiveness(accountId),
    generateOptimizations(accountId),
    checkColdStart(accountId, 20)
  ]);

  // Calculate summary KPIs
  const kpis = await calculateKPIs(accountId);

  // Check for completed A/B tests and auto-determine winners
  const completedTests = await checkAndCompleteABTests(accountId);

  return {
    accountId,
    timestamp,
    effectivenessScores,
    optimizations,
    coldStart,
    kpis,
    completedTests
  };
}

// ─── 2. Run Analysis for All Accounts ────────────────────

export async function runAnalysisForAllAccounts(): Promise<{
  accountsProcessed: number;
  results: Array<{ accountId: string; success: boolean; error?: string }>;
}> {
  const accounts = await prisma.account.findMany({
    select: { id: true, name: true }
  });

  const results: Array<{
    accountId: string;
    success: boolean;
    error?: string;
  }> = [];

  for (const account of accounts) {
    try {
      const report = await runDailyAnalysis(account.id);
      console.log(
        `[DailyAnalysis] Account "${account.name}" (${account.id}): ` +
          `resolved=${report.kpis.totalResolved}, ` +
          `bookingRate=${(report.kpis.bookingRate * 100).toFixed(1)}%, ` +
          `showRate=${(report.kpis.showRate * 100).toFixed(1)}%, ` +
          `closeRate=${(report.kpis.closeRate * 100).toFixed(1)}%, ` +
          `optimizations=${report.optimizations.length}, ` +
          `completedTests=${report.completedTests.length}`
      );
      results.push({ accountId: account.id, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        `[DailyAnalysis] Account "${account.name}" (${account.id}) failed:`,
        message
      );
      results.push({ accountId: account.id, success: false, error: message });
    }
  }

  return { accountsProcessed: accounts.length, results };
}

// ─── Helper: Calculate Summary KPIs ──────────────────────

async function calculateKPIs(accountId: string): Promise<SummaryKPIs> {
  // Total resolved conversations (outcome != ONGOING)
  const totalResolved = await prisma.conversation.count({
    where: {
      lead: { accountId },
      outcome: { not: 'ONGOING' }
    }
  });

  // Booked count
  const bookedCount = await prisma.conversation.count({
    where: {
      lead: { accountId },
      outcome: 'BOOKED'
    }
  });

  const bookingRate = totalResolved > 0 ? bookedCount / totalResolved : 0;

  // Show rate from CrmOutcome
  const crmOutcomes = await prisma.crmOutcome.findMany({
    where: { accountId },
    select: { showed: true, closed: true, dealValue: true }
  });

  const totalCrmOutcomes = crmOutcomes.length;
  const showedCount = crmOutcomes.filter((o) => o.showed).length;
  const closedCount = crmOutcomes.filter((o) => o.closed).length;

  const showRate = totalCrmOutcomes > 0 ? showedCount / totalCrmOutcomes : 0;
  const closeRate = totalCrmOutcomes > 0 ? closedCount / totalCrmOutcomes : 0;

  // Average revenue per closed deal
  const closedDeals = crmOutcomes.filter(
    (o) => o.closed && o.dealValue != null
  );
  const totalRevenue = closedDeals.reduce(
    (sum, o) => sum + (o.dealValue ?? 0),
    0
  );
  const avgRevenuePerClose =
    closedDeals.length > 0 ? totalRevenue / closedDeals.length : 0;

  // Average messages to book (for BOOKED conversations)
  const bookedConversations = await prisma.conversation.findMany({
    where: {
      lead: { accountId },
      outcome: 'BOOKED'
    },
    select: {
      _count: { select: { messages: true } }
    }
  });

  const totalMessages = bookedConversations.reduce(
    (sum, c) => sum + c._count.messages,
    0
  );
  const avgMessagesToBook =
    bookedConversations.length > 0
      ? totalMessages / bookedConversations.length
      : 0;

  return {
    totalResolved,
    bookingRate: parseFloat(bookingRate.toFixed(4)),
    showRate: parseFloat(showRate.toFixed(4)),
    closeRate: parseFloat(closeRate.toFixed(4)),
    avgRevenuePerClose: parseFloat(avgRevenuePerClose.toFixed(2)),
    avgMessagesToBook: parseFloat(avgMessagesToBook.toFixed(1))
  };
}

// ─── Helper: Check and Complete A/B Tests ────────────────

async function checkAndCompleteABTests(
  accountId: string
): Promise<CompletedTestSummary[]> {
  // Find RUNNING tests that have reached their sample size targets on both variants
  const runningTests = await prisma.aBTest.findMany({
    where: {
      accountId,
      status: 'RUNNING'
    }
  });

  const completedTests: CompletedTestSummary[] = [];

  for (const test of runningTests) {
    // Check if both variants have met the sample size target
    if (
      test.countA < test.sampleSizeTarget ||
      test.countB < test.sampleSizeTarget
    ) {
      continue;
    }

    // Both variants have enough data — determine winner
    const significance = checkStatisticalSignificance(
      test.resultsA as ABTestResult | null,
      test.resultsB as ABTestResult | null,
      test.countA,
      test.countB
    );

    const winnerLabel = significance.winner ?? 'INCONCLUSIVE';

    // Update the test to COMPLETED
    await prisma.aBTest.update({
      where: { id: test.id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        winner: winnerLabel
      }
    });

    completedTests.push({
      testId: test.id,
      testName: test.testName,
      stage: test.stage,
      winner: winnerLabel,
      pValue: significance.pValue,
      countA: test.countA,
      countB: test.countB
    });

    console.log(
      `[DailyAnalysis] A/B test "${test.testName}" completed: ` +
        `winner=${winnerLabel}, pValue=${significance.pValue.toFixed(4)}, ` +
        `countA=${test.countA}, countB=${test.countB}`
    );
  }

  return completedTests;
}
