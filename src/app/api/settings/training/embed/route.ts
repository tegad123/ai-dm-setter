import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { embedTrainingMessagesForAccount } from '@/lib/training-example-retriever';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// POST /api/settings/training/embed — backfill embeddings for training data
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    console.log(
      '[training/embed] Starting embedding backfill for account:',
      auth.accountId
    );
    const result = await embedTrainingMessagesForAccount(auth.accountId);

    return NextResponse.json({
      success: true,
      embedded: result.embedded,
      skipped: result.skipped
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('[training/embed] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Embedding failed' },
      { status: 500 }
    );
  }
}
