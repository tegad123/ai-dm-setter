import { requireAuth, AuthError } from '@/lib/auth-guard';
import { saveCredentials, deleteCredentials } from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

const VALID_PROVIDERS = [
  'META',
  'ELEVENLABS',
  'LEADCONNECTOR',
  'OPENAI',
  'ANTHROPIC'
] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

function isValidProvider(value: string): value is Provider {
  return VALID_PROVIDERS.includes(value as Provider);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { provider } = await params;

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        {
          error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}`
        },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { credentials, metadata } = body;

    if (!credentials || typeof credentials !== 'object') {
      return NextResponse.json(
        { error: 'Missing required field: credentials (object)' },
        { status: 400 }
      );
    }

    await saveCredentials(auth.accountId, provider, credentials, metadata);

    return NextResponse.json({
      message: `${provider} credentials saved`,
      provider
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/integrations/[provider] error:', error);
    return NextResponse.json(
      { error: 'Failed to save credentials' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { provider } = await params;

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        {
          error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}`
        },
        { status: 400 }
      );
    }

    await deleteCredentials(auth.accountId, provider);

    return NextResponse.json({
      message: `${provider} credentials removed`,
      provider
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/settings/integrations/[provider] error:', error);
    return NextResponse.json(
      { error: 'Failed to remove credentials' },
      { status: 500 }
    );
  }
}
