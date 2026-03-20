import { NextRequest, NextResponse } from 'next/server';
import { runAnalysisForAllAccounts } from '@/lib/scheduled-analysis';

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { accountsProcessed, results } = await runAnalysisForAllAccounts();

    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(
      `[CRON] Daily analysis complete: ${successful}/${accountsProcessed} succeeded, ${failed} failed`
    );

    return NextResponse.json({
      message: `Daily analysis completed for ${accountsProcessed} accounts`,
      accountsProcessed,
      successful,
      failed,
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('GET /api/cron/daily-analysis error:', error);
    return NextResponse.json(
      { error: 'Failed to run daily analysis' },
      { status: 500 }
    );
  }
}
