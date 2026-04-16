import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import {
  runTrainingAnalysis,
  estimateAnalysisCost
} from '@/lib/training-data-analyzer';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// GET /api/settings/training/analysis — latest analysis result
// POST /api/settings/training/analysis — run or estimate analysis
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const latest = await prisma.trainingDataAnalysis.findFirst({
      where: { accountId: auth.accountId },
      orderBy: { runAt: 'desc' }
    });

    return NextResponse.json({ analysis: latest });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { confirm } = body as { confirm: boolean };

    if (!confirm) {
      // Cost estimate only
      const estimate = await estimateAnalysisCost(auth.accountId);
      return NextResponse.json({ estimate });
    }

    // Run full analysis
    console.log(
      '[training/analysis] Starting analysis for account:',
      auth.accountId
    );
    const startTime = Date.now();
    const result = await runTrainingAnalysis(auth.accountId);
    console.log(
      `[training/analysis] Analysis completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s, score: ${result.overallScore}`
    );

    // Save to database
    const analysis = await prisma.trainingDataAnalysis.create({
      data: {
        accountId: auth.accountId,
        overallScore: result.overallScore,
        categoryScores: result.categoryScores as unknown as any,
        totalConversations: result.totalConversations,
        totalMessages: result.totalMessages,
        recommendations: result.recommendations as unknown as any,
        status: 'complete'
      }
    });

    return NextResponse.json({
      analysis: {
        ...analysis,
        summary: result.summary
      }
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('[training/analysis] Error:', err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Analysis failed'
      },
      { status: 500 }
    );
  }
}
