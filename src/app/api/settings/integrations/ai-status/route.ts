import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/settings/integrations/ai-status
 * Returns whether the account has a working AI API key configured
 * (either via DB credentials or environment variables).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Check DB-stored credentials (apiKey is inside the `credentials` JSON blob)
    const dbCreds = await prisma.integrationCredential.findMany({
      where: {
        accountId: auth.accountId,
        provider: { in: ['OPENAI', 'ANTHROPIC'] },
        isActive: true
      },
      select: { provider: true, credentials: true }
    });

    const hasDbKey = dbCreds.some((c) => {
      const creds = c.credentials as Record<string, string> | null;
      return !!(creds?.apiKey || creds?.accessToken);
    });

    // Check environment variables as fallback
    const hasEnvKey = !!(
      process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY
    );

    return NextResponse.json({
      hasAiKey: hasDbKey || hasEnvKey,
      source: hasDbKey ? 'database' : hasEnvKey ? 'environment' : 'none'
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json(
      { error: 'Failed to check AI status' },
      { status: 500 }
    );
  }
}
