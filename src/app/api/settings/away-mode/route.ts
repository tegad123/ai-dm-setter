import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { rescueOrphanAISuggestions } from '@/lib/webhook-processor';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Away Mode — per-platform AI takeover toggles
// ---------------------------------------------------------------------------
// When a platform's away mode is ON, the AI auto-sends replies for every
// conversation on that platform regardless of the per-conversation aiActive
// flag. This is the "I'm away, take over" switch.
//
// Backward compatibility: the legacy `{ awayMode: boolean }` PUT payload is
// still accepted — it flips BOTH Instagram and Facebook to the same value.
// The GET response returns the new per-platform fields AND a derived
// top-level `awayMode` boolean (true if EITHER platform is on) for any UI
// that hasn't migrated yet.
// ---------------------------------------------------------------------------

interface AwayModeResponse {
  awayModeInstagram: boolean;
  awayModeInstagramEnabledAt: string | null;
  awayModeFacebook: boolean;
  awayModeFacebookEnabledAt: string | null;
  // Legacy-compatible derived field: true if EITHER platform is on.
  awayMode: boolean;
  awayModeEnabledAt: string | null;
}

// GET /api/settings/away-mode — current per-platform away mode status
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: {
        awayModeInstagram: true,
        awayModeInstagramEnabledAt: true,
        awayModeFacebook: true,
        awayModeFacebookEnabledAt: true
      }
    });

    if (!account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Derived legacy field: true if EITHER platform is on. Use the earlier
    // enablement timestamp so the UI says "enabled since X".
    const eitherOn = account.awayModeInstagram || account.awayModeFacebook;
    const timestamps = [
      account.awayModeInstagramEnabledAt,
      account.awayModeFacebookEnabledAt
    ].filter((t): t is Date => t !== null);
    const legacyEnabledAt =
      timestamps.length > 0
        ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
        : null;

    const body: AwayModeResponse = {
      awayModeInstagram: account.awayModeInstagram,
      awayModeInstagramEnabledAt:
        account.awayModeInstagramEnabledAt?.toISOString() ?? null,
      awayModeFacebook: account.awayModeFacebook,
      awayModeFacebookEnabledAt:
        account.awayModeFacebookEnabledAt?.toISOString() ?? null,
      awayMode: eitherOn,
      awayModeEnabledAt: legacyEnabledAt?.toISOString() ?? null
    };
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/away-mode error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch away mode status' },
      { status: 500 }
    );
  }
}

// PUT /api/settings/away-mode — toggle per-platform away mode
// Accepts:
//   - { awayModeInstagram?: boolean, awayModeFacebook?: boolean }
//     (preferred — updates only the fields provided)
//   - { awayMode: boolean }
//     (legacy — sets BOTH platforms to the same value)
export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can toggle away mode' },
        { status: 403 }
      );
    }

    const body = await req.json();
    const { awayMode, awayModeInstagram, awayModeFacebook } = body;

    // Validate: at least one known field must be a boolean
    const hasLegacy = typeof awayMode === 'boolean';
    const hasIg = typeof awayModeInstagram === 'boolean';
    const hasFb = typeof awayModeFacebook === 'boolean';
    if (!hasLegacy && !hasIg && !hasFb) {
      return NextResponse.json(
        {
          error:
            'Provide at least one of awayModeInstagram, awayModeFacebook, or (legacy) awayMode'
        },
        { status: 400 }
      );
    }

    // Fetch BEFORE state once up front. We reuse it for (a) the legacy
    // derived-bool computation below AND (b) orphan-suggestion rescue:
    // on any platform that transitions false → true, we re-fire any
    // recent AISuggestion rows that were generated while the gate was
    // closed. See rescueOrphanAISuggestions() in webhook-processor.ts.
    const before = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: { awayModeInstagram: true, awayModeFacebook: true }
    });
    const beforeIg = before?.awayModeInstagram ?? false;
    const beforeFb = before?.awayModeFacebook ?? false;

    const now = new Date();
    const data: Record<string, unknown> = {};

    // Legacy payload: flip both platforms together
    if (hasLegacy) {
      data.awayModeInstagram = awayMode;
      data.awayModeInstagramEnabledAt = awayMode ? now : null;
      data.awayModeFacebook = awayMode;
      data.awayModeFacebookEnabledAt = awayMode ? now : null;
      // Also update the legacy column so older code that still reads it
      // during the deprecation window stays consistent.
      data.awayMode = awayMode;
      data.awayModeEnabledAt = awayMode ? now : null;
    }
    // Per-platform payload overrides the legacy payload when both are
    // present (explicit wins over implicit).
    if (hasIg) {
      data.awayModeInstagram = awayModeInstagram;
      data.awayModeInstagramEnabledAt = awayModeInstagram ? now : null;
    }
    if (hasFb) {
      data.awayModeFacebook = awayModeFacebook;
      data.awayModeFacebookEnabledAt = awayModeFacebook ? now : null;
    }
    // Keep the derived legacy column in sync for the deprecation window.
    if (hasIg || hasFb) {
      const nextIg = hasIg ? awayModeInstagram : beforeIg;
      const nextFb = hasFb ? awayModeFacebook : beforeFb;
      data.awayMode = nextIg || nextFb;
      data.awayModeEnabledAt = nextIg || nextFb ? now : null;
    }

    const account = await prisma.account.update({
      where: { id: auth.accountId },
      data,
      select: {
        awayModeInstagram: true,
        awayModeInstagramEnabledAt: true,
        awayModeFacebook: true,
        awayModeFacebookEnabledAt: true
      }
    });

    console.log(
      `[away-mode] Account ${auth.accountId} updated by ${auth.name}: instagram=${account.awayModeInstagram} facebook=${account.awayModeFacebook}`
    );

    // Orphan AISuggestion rescue — see the comment on
    // rescueOrphanAISuggestions in webhook-processor.ts for the full
    // explanation. Briefly: when operators flip per-chat aiActive on
    // before the platform toggle, replies get generated but not shipped
    // because the dual-gate blocks send. Flipping the platform now
    // should rescue those orphans. Fire-and-forget via .catch() so the
    // toggle response doesn't block on network round-trips for every
    // stranded convo.
    const platformsToRescue: Array<'INSTAGRAM' | 'FACEBOOK'> = [];
    if (account.awayModeInstagram && !beforeIg)
      platformsToRescue.push('INSTAGRAM');
    if (account.awayModeFacebook && !beforeFb)
      platformsToRescue.push('FACEBOOK');
    for (const platform of platformsToRescue) {
      rescueOrphanAISuggestions(auth.accountId, platform).catch((err) => {
        console.error(
          `[away-mode] Rescue failed for ${platform} on account ${auth.accountId}:`,
          err
        );
      });
    }

    const eitherOn = account.awayModeInstagram || account.awayModeFacebook;
    const timestamps = [
      account.awayModeInstagramEnabledAt,
      account.awayModeFacebookEnabledAt
    ].filter((t): t is Date => t !== null);
    const legacyEnabledAt =
      timestamps.length > 0
        ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
        : null;

    const resp: AwayModeResponse = {
      awayModeInstagram: account.awayModeInstagram,
      awayModeInstagramEnabledAt:
        account.awayModeInstagramEnabledAt?.toISOString() ?? null,
      awayModeFacebook: account.awayModeFacebook,
      awayModeFacebookEnabledAt:
        account.awayModeFacebookEnabledAt?.toISOString() ?? null,
      awayMode: eitherOn,
      awayModeEnabledAt: legacyEnabledAt?.toISOString() ?? null
    };
    return NextResponse.json(resp);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/away-mode error:', error);
    return NextResponse.json(
      { error: 'Failed to update away mode' },
      { status: 500 }
    );
  }
}
