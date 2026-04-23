// ---------------------------------------------------------------------------
// GET /api/conversations/[id]/suggestion
// ---------------------------------------------------------------------------
// Returns the latest UNACTIONED AISuggestion for a conversation, or null
// when nothing is pending. Used by the in-conversation review banner
// that appears when a platform has auto-send disabled — the AI
// generates, persists, and broadcasts; the operator approves / edits /
// dismisses via the banner.
//
// "Unactioned" means:
//   - `dismissed` is false (operator didn't hit Dismiss)
//   - `actionedAt` is null (no Send/Dismiss yet)
//   - `wasSelected` is false (AI didn't auto-send this — that path
//     already saves a Message row; the banner would be redundant)
//   - generated within the last 24h (older than that is noise)
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: conversationId } = await params;

    // Verify ownership + pull the auto-send inputs in one round-trip so
    // we can short-circuit review-banner mode when this conversation is
    // already auto-sending. Otherwise the banner flashes stale
    // suggestions for an account that graduated to full autonomy
    // (daetradez 2026-04-23 — 177 pre-graduation rows still sat in
    // the DB after awayModeInstagram flipped on).
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, lead: { accountId: auth.accountId } },
      select: {
        id: true,
        aiActive: true,
        autoSendOverride: true,
        lead: { select: { platform: true } }
      }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: { awayModeInstagram: true, awayModeFacebook: true }
    });
    const awayModeForPlatform =
      conversation.lead.platform === 'INSTAGRAM'
        ? (account?.awayModeInstagram ?? false)
        : conversation.lead.platform === 'FACEBOOK'
          ? (account?.awayModeFacebook ?? false)
          : false;
    const wouldAutoSend =
      conversation.aiActive &&
      (awayModeForPlatform || conversation.autoSendOverride);
    if (wouldAutoSend) {
      // Conversation's own inbounds will auto-ship — review banner has
      // no job here. Never surfaces pre-graduation stale suggestions.
      return NextResponse.json({ suggestion: null });
    }

    const cutoff = new Date(Date.now() - PENDING_WINDOW_MS);
    const suggestion = await prisma.aISuggestion.findFirst({
      where: {
        conversationId,
        dismissed: false,
        actionedAt: null,
        wasSelected: false,
        generatedAt: { gte: cutoff }
      },
      orderBy: { generatedAt: 'desc' },
      select: {
        id: true,
        responseText: true,
        messageBubbles: true,
        bubbleCount: true,
        qualityGateScore: true,
        intentClassification: true,
        intentConfidence: true,
        leadStageSnapshot: true,
        generatedAt: true
      }
    });

    return NextResponse.json({ suggestion });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('GET /api/conversations/[id]/suggestion error:', err);
    return NextResponse.json(
      { error: 'Failed to fetch suggestion' },
      { status: 500 }
    );
  }
}
