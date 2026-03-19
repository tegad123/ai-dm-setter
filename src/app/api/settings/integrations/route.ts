import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

const PROVIDERS = [
  'OPENAI',
  'ANTHROPIC',
  'META',
  'ELEVENLABS',
  'LEADCONNECTOR',
  'CALENDLY'
] as const;

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const credentials = await prisma.integrationCredential.findMany({
      where: { accountId: auth.accountId },
      select: {
        provider: true,
        isActive: true,
        verifiedAt: true
      }
    });

    // Build status for all providers
    const integrations = PROVIDERS.map((provider) => {
      const cred = credentials.find((c) => c.provider === provider);
      return {
        provider,
        isConnected: cred ? cred.isActive : false,
        verifiedAt: cred?.verifiedAt?.toISOString() || null
      };
    });

    return NextResponse.json({ integrations });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/integrations error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch integration status' },
      { status: 500 }
    );
  }
}
