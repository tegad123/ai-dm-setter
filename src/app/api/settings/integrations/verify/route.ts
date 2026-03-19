import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// POST — Verify an API key before saving it
// Performs a lightweight API call to check the key is valid.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req);

    const body = await req.json();
    const { provider, credentials } = body as {
      provider?: string;
      credentials?: Record<string, string>;
    };

    if (!provider || !credentials) {
      return NextResponse.json(
        { error: 'provider and credentials are required' },
        { status: 400 }
      );
    }

    let valid = false;
    let error: string | undefined;

    switch (provider.toUpperCase()) {
      case 'OPENAI': {
        const apiKey = credentials.apiKey;
        if (!apiKey) {
          return NextResponse.json({
            valid: false,
            error: 'apiKey is required'
          });
        }
        try {
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` }
          });
          valid = res.ok;
          if (!valid) {
            const data = await res.json().catch(() => null);
            error = data?.error?.message || `OpenAI returned ${res.status}`;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : 'Failed to reach OpenAI';
        }
        break;
      }

      case 'ANTHROPIC': {
        const apiKey = credentials.apiKey;
        if (!apiKey) {
          return NextResponse.json({
            valid: false,
            error: 'apiKey is required'
          });
        }
        try {
          // Use a minimal messages call to verify the key
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }]
            })
          });
          // A 200 means the key works; 401 means invalid
          valid = res.ok;
          if (!valid) {
            const data = await res.json().catch(() => null);
            error = data?.error?.message || `Anthropic returned ${res.status}`;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : 'Failed to reach Anthropic';
        }
        break;
      }

      case 'ELEVENLABS': {
        const apiKey = credentials.apiKey;
        if (!apiKey) {
          return NextResponse.json({
            valid: false,
            error: 'apiKey is required'
          });
        }
        try {
          const res = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey }
          });
          valid = res.ok;
          if (!valid) {
            error = `ElevenLabs returned ${res.status}`;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : 'Failed to reach ElevenLabs';
        }
        break;
      }

      case 'LEADCONNECTOR': {
        const apiKey = credentials.apiKey;
        if (!apiKey) {
          return NextResponse.json({
            valid: false,
            error: 'apiKey is required'
          });
        }
        try {
          const res = await fetch(
            'https://services.leadconnectorhq.com/calendars',
            {
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                Version: '2021-07-28'
              }
            }
          );
          valid = res.ok;
          if (!valid) {
            error = `LeadConnector returned ${res.status}`;
          }
        } catch (e) {
          error =
            e instanceof Error ? e.message : 'Failed to reach LeadConnector';
        }
        break;
      }

      default:
        return NextResponse.json(
          { valid: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
    }

    return NextResponse.json({ valid, ...(error ? { error } : {}) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/settings/integrations/verify error:', error);
    return NextResponse.json(
      { error: 'Failed to verify credentials' },
      { status: 500 }
    );
  }
}
