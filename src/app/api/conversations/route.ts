import prisma from '@/lib/prisma';
import { requireAuth, AuthError, scopedAccountId } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');
    const priority = searchParams.get('priority'); // "true" to filter high-priority
    const unreadOnly = searchParams.get('unread'); // "true" to filter unread only
    const platform = searchParams.get('platform'); // "INSTAGRAM" | "FACEBOOK"
    const qualification = searchParams.get('qualification'); // "qualified" | "unqualified"
    const tagFilter = searchParams.get('tag'); // "cold-pitch" to surface SPAM bucket; omit = exclude
    const accountId = scopedAccountId(auth, searchParams.get('accountId'));

    // Cold-pitch / SPAM gating. By default (no `tag` param) the
    // conversations list excludes spam-bucket rows so Omar-style
    // pitches don't clutter the operator's main view. When ops
    // explicitly passes `?tag=cold-pitch`, we INVERT the filter and
    // show only those rows.
    const leadFilter: Record<string, unknown> = {
      accountId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { handle: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {})
    };
    if (tagFilter === 'cold-pitch') {
      leadFilter.tags = { some: { tag: { name: 'cold-pitch' } } };
    } else {
      // Default: hide cold-pitch tagged leads from the main feed.
      leadFilter.tags = { none: { tag: { name: 'cold-pitch' } } };
    }
    if (platform === 'INSTAGRAM' || platform === 'FACEBOOK') {
      leadFilter.platform = platform;
    }
    // "Qualified" = past the capital gate and still in-flight toward revenue.
    // We include CLOSED_WON (revenue already recorded) but NOT CLOSED_LOST,
    // NO_SHOWED, GHOSTED, NURTURE — those are terminal non-revenue states
    // that belong in their own buckets even though the lead was once
    // qualified. UNQUALIFIED is its own tab.
    if (qualification === 'qualified') {
      leadFilter.stage = {
        in: ['QUALIFIED', 'CALL_PROPOSED', 'BOOKED', 'SHOWED', 'CLOSED_WON']
      };
    } else if (qualification === 'unqualified') {
      leadFilter.stage = 'UNQUALIFIED';
    }

    const where: Record<string, unknown> = { lead: leadFilter };

    if (priority === 'true') {
      where.priorityScore = { gte: 50 };
    }
    if (unreadOnly === 'true') {
      where.unreadCount = { gt: 0 };
    }

    // Sort by priority score when in priority mode, otherwise by last message
    const orderBy =
      priority === 'true'
        ? { priorityScore: 'desc' as const }
        : { lastMessageAt: 'desc' as const };

    // Pending-suggestion cutoff — mirrors GET /api/conversations/[id]/suggestion.
    const pendingSuggestionCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Fetch account-level awayMode flags once; we gate the ⚡ indicator
    // per-conversation using the same "would this conversation auto-
    // send?" rule as the banner endpoint, so a graduated account never
    // shows ⚡ on conversations that will auto-send new inbounds.
    // showSuggestionBanner is the account-level master switch — when
    // false, ⚡ never shows anywhere (matches the banner endpoint).
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        awayModeInstagram: true,
        awayModeFacebook: true,
        showSuggestionBanner: true
      }
    });
    const awayModeInstagram = account?.awayModeInstagram ?? false;
    const awayModeFacebook = account?.awayModeFacebook ?? false;
    const showSuggestionBanner = account?.showSuggestionBanner ?? true;

    const rawConversations = await prisma.conversation.findMany({
      where,
      include: {
        lead: {
          select: {
            id: true,
            name: true,
            handle: true,
            platformUserId: true,
            platform: true,
            stage: true,
            qualityScore: true,
            tags: {
              include: {
                tag: { select: { id: true, name: true, color: true } }
              }
            }
          }
        },
        messages: {
          where: {
            AND: [
              { sender: { not: 'SYSTEM' } },
              { NOT: { content: { startsWith: 'OPERATOR NOTE:' } } }
            ]
          },
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { content: true }
        },
        // Zero-or-one lookup of the most recent unactioned suggestion.
        // The frontend just needs a boolean ("show the ⚡ indicator");
        // taking 1 row keeps the payload small. The per-conversation
        // gate below then masks this to false for auto-sending convos.
        aiSuggestions: {
          where: {
            dismissed: false,
            actionedAt: null,
            wasSelected: false,
            generatedAt: { gte: pendingSuggestionCutoff }
          },
          orderBy: { generatedAt: 'desc' },
          take: 1,
          select: { id: true }
        }
      },
      orderBy
    });

    // Flatten the lead data for the frontend
    const conversations = rawConversations.map((c) => {
      // Mirror webhook-processor.ts:988's shouldAutoSend rule so the
      // ⚡ indicator only shows when this conversation is genuinely in
      // review-banner mode (inbounds don't auto-ship).
      const awayModeForPlatform =
        c.lead.platform === 'INSTAGRAM'
          ? awayModeInstagram
          : c.lead.platform === 'FACEBOOK'
            ? awayModeFacebook
            : false;
      const wouldAutoSend =
        c.aiActive && (awayModeForPlatform || c.autoSendOverride);
      return {
        id: c.id,
        leadId: c.lead.id,
        leadName:
          c.lead.name || c.lead.handle || c.lead.platformUserId || 'Unknown',
        leadHandle: c.lead.handle || c.lead.platformUserId || '',
        platform: c.lead.platform.toLowerCase(),
        stage: c.lead.stage,
        aiActive: c.aiActive,
        lastMessage: c.messages[0]?.content ?? '',
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        unreadCount: c.unreadCount,
        priorityScore: c.priorityScore,
        qualityScore: c.lead.qualityScore ?? 0,
        tags: c.lead.tags.map((lt) => ({
          id: lt.tag.id,
          name: lt.tag.name,
          color: lt.tag.color
        })),
        // Call badge in sidebar list: null if no call scheduled or >7 days out
        scheduledCallAt: c.scheduledCallAt?.toISOString() ?? null,
        // ⚡ indicator — suppressed when: (a) account-level banner is
        // disabled, or (b) this conversation's own inbounds would auto-
        // send (no review-banner UX).
        hasPendingSuggestion:
          showSuggestionBanner && !wouldAutoSend && c.aiSuggestions.length > 0,
        source: c.source,
        createdAt: c.createdAt.toISOString()
      };
    });

    return NextResponse.json({ conversations });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch conversations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch conversations' },
      { status: 500 }
    );
  }
}
