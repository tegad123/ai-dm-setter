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
    env: process.env.VERCEL_ENV ?? null
  });
}
