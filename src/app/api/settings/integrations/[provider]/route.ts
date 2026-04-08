import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  getCredentials,
  saveCredentials,
  deleteCredentials
} from '@/lib/credential-store';
import { NextRequest, NextResponse } from 'next/server';

const VALID_PROVIDERS = [
  'META',
  'INSTAGRAM',
  'ELEVENLABS',
  'LEADCONNECTOR',
  'OPENAI',
  'ANTHROPIC',
  'CALENDLY'
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

    // For Meta/Instagram, revoke the grant on Facebook's side BEFORE deleting
    // the local credential. Otherwise Meta will silently re-use the existing
    // grant on the next OAuth attempt — even with auth_type=rerequest — and
    // any newly-approved scopes will be silently dropped from the new token.
    // The DELETE /me/permissions endpoint nukes the user's entire app
    // authorization, forcing a fresh consent dialog next time.
    if (provider === 'META' || provider === 'INSTAGRAM') {
      try {
        const existing = await getCredentials(auth.accountId, provider);
        const token = existing?.accessToken;
        if (token) {
          // Use the right host: Instagram tokens (IGAA*) live on
          // graph.instagram.com, Meta tokens (EAA*) on graph.facebook.com.
          const host = String(token).startsWith('IGAA')
            ? 'https://graph.instagram.com'
            : 'https://graph.facebook.com';
          const revokeRes = await fetch(
            `${host}/v21.0/me/permissions?access_token=${token}`,
            { method: 'DELETE' }
          );
          if (revokeRes.ok) {
            const revokeData = await revokeRes.json();
            console.log(
              `[disconnect] Revoked ${provider} grant for account ${auth.accountId}:`,
              revokeData
            );
          } else {
            const errBody = await revokeRes.text();
            console.warn(
              `[disconnect] Failed to revoke ${provider} grant for account ${auth.accountId} (${revokeRes.status}):`,
              errBody.slice(0, 300)
            );
            // Don't fail the disconnect — local cleanup still has value
          }
        }
      } catch (revokeErr) {
        console.warn(
          `[disconnect] Error revoking ${provider} grant:`,
          revokeErr
        );
      }
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
