// GET /api/version — deployed build identity. Public, no auth: exposes only
// the git SHA + deploy timestamp, which the repo already makes public.
// Exists so verification runs can PROVE which build handled a turn instead
// of inferring from push-time + build-duration guesses (2026-07-28: two
// bundle repros ran against a stale build because there was no way to check).
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'unknown',
    fullCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    message: process.env.VERCEL_GIT_COMMIT_MESSAGE?.slice(0, 100) ?? null,
    deployedAt: process.env.VERCEL_DEPLOYMENT_COMPLETED_AT ?? null,
    env: process.env.VERCEL_ENV ?? null,
    // Fix D cutover state — non-secret flag echo so a verification run can
    // PROVE the egress gate is authoritative (and for which platforms)
    // instead of inferring it. Never exposes a secret value, only which
    // platforms enforce and whether shadow logging is on.
    fixD: {
      egressAuthoritativePlatforms:
        process.env.FIX_D_CANSEND_AUTHORITATIVE ?? null,
      egressShadowEnabled: process.env.FIX_D_EGRESS_SHADOW !== 'false'
    }
  });
}
