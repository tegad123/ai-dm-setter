// GET /api/version — deployed build identity. Public, no auth: exposes only
// the git SHA + deploy timestamp, which the repo already makes public.
// Exists so verification runs can PROVE which build handled a turn instead
// of inferring from push-time + build-duration guesses (2026-07-28: two
// bundle repros ran against a stale build because there was no way to check).
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // Temporary: ?classify=<text> runs the live classifier and returns its raw
  // verdict, so we can see exactly what prod's Haiku call returns for Tega's
  // phrase (2026-07-28 distress debug). Removed once the fix is confirmed.
  const probe = new URL(request.url).searchParams.get('classify');
  if (probe) {
    // Raw Haiku call so the ACTUAL exception surfaces (classifyDistress
    // swallows it into 'classifier_error'). Temporary distress debug.
    const key = process.env.ANTHROPIC_API_KEY ?? '';
    let rawResult: unknown;
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: key, maxRetries: 0 });
      const r = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 50,
          messages: [{ role: 'user', content: 'reply with the word ok' }]
        },
        { timeout: 8000 }
      );
      rawResult = { ok: true, content: r.content };
    } catch (e) {
      rawResult = {
        ok: false,
        name: e instanceof Error ? e.name : 'unknown',
        message: e instanceof Error ? e.message.slice(0, 300) : String(e),
        status: (e as { status?: number })?.status ?? null
      };
    }
    return NextResponse.json({
      keyLen: key.length,
      keyPrefix: key.slice(0, 7),
      rawResult
    });
  }
  return NextResponse.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown',
    fullCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.slice(0, 100) ?? null,
    deployedAt: process.env.VERCEL_DEPLOYMENT_COMPLETED_AT ?? null,
    env: process.env.VERCEL_ENV ?? null,
    // Temporary distress-flag diagnostic (2026-07-28): the classifier-
    // authoritative flip fired anyway in prod; this reports how the RUNNING
    // process resolves the gate so we stop guessing. Booleans only, no secrets.
    distress: {
      authoritativeVar: process.env.DISTRESS_CLASSIFIER_AUTHORITATIVE ?? null,
      authoritativeResolved:
        process.env.DISTRESS_CLASSIFIER_AUTHORITATIVE !== 'false',
      classifierEnabled: process.env.DISTRESS_CLASSIFIER_ENABLED ?? null,
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY)
    }
  });
}
