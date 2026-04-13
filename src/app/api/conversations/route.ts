import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');
    const priority = searchParams.get('priority'); // "true" to filter high-priority
    const unreadOnly = searchParams.get('unread'); // "true" to filter unread only
    const platform = searchParams.get('platform'); // "INSTAGRAM" | "FACEBOOK"

    const leadFilter: Record<string, unknown> = {
      accountId: auth.accountId,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { handle: { contains: search, mode: 'insensitive' } }
            ]
          }
        : {})
    };
    if (platform === 'INSTAGRAM' || platform === 'FACEBOOK') {
      leadFilter.platform = platform;
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
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { content: true }
        }
      },
      orderBy
    });

    // Flatten the lead data for the frontend
    const conversations = rawConversations.map((c) => ({
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
      createdAt: c.createdAt.toISOString()
    }));

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
