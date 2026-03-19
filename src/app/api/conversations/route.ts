import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const search = searchParams.get('search');

    const where: Record<string, unknown> = {
      lead: {
        accountId: auth.accountId,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { handle: { contains: search, mode: 'insensitive' } }
              ]
            }
          : {})
      }
    };

    const rawConversations = await prisma.conversation.findMany({
      where,
      include: {
        lead: {
          select: {
            id: true,
            name: true,
            handle: true,
            platform: true,
            status: true
          }
        },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { content: true }
        }
      },
      orderBy: { lastMessageAt: 'desc' }
    });

    // Flatten the lead data for the frontend
    const conversations = rawConversations.map((c) => ({
      id: c.id,
      leadId: c.lead.id,
      leadName: c.lead.name,
      leadHandle: c.lead.handle,
      platform: c.lead.platform,
      status: c.lead.status,
      aiActive: c.aiActive,
      lastMessage: c.messages[0]?.content ?? '',
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      unreadCount: c.unreadCount,
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
