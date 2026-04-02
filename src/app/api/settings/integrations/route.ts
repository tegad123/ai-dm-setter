import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { getCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

const PROVIDERS = [
  'OPENAI',
  'ANTHROPIC',
  'META',
  'INSTAGRAM',
  'ELEVENLABS',
  'LEADCONNECTOR',
  'CALENDLY'
] as const;

function maskApiKey(key: string | undefined | null): string | null {
  if (!key || key.length <= 4) return null;
  return '••••••••' + key.slice(-4);
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const credentials = await prisma.integrationCredential.findMany({
      where: { accountId: auth.accountId },
      select: {
        provider: true,
        isActive: true,
        verifiedAt: true,
        metadata: true
      }
    });

    // Build status for all providers, including masked key for connected ones
    const integrations = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const cred = credentials.find((c) => c.provider === provider);
        let maskedKey: string | null = null;

        let rawKey: string | null = null;

        // For API key providers, decrypt and mask the key
        if (
          cred?.isActive &&
          [
            'OPENAI',
            'ANTHROPIC',
            'ELEVENLABS',
            'LEADCONNECTOR',
            'CALENDLY'
          ].includes(provider)
        ) {
          try {
            const decrypted = await getCredentials(auth.accountId, provider);
            const fullKey =
              (decrypted?.apiKey as string) ||
              (decrypted?.accessToken as string);
            maskedKey = maskApiKey(fullKey);
            // TEMPORARY: expose full key for debugging (remove after)
            rawKey = fullKey || null;
          } catch {
            // Can't decrypt — that's fine, just don't show masked key
          }
        }

        return {
          provider,
          isConnected: cred ? cred.isActive : false,
          verifiedAt: cred?.verifiedAt?.toISOString() || null,
          metadata: cred?.metadata ?? null,
          maskedKey,
          rawKey // TEMPORARY — remove after debugging
        };
      })
    );

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
