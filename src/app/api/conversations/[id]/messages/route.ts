import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  broadcastNewMessage,
  broadcastConversationUpdate,
  broadcastAIStatusChange
} from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { accountId: auth.accountId } }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const before = searchParams.get('before');

    const messages = await prisma.message.findMany({
      where: {
        conversationId: id,
        ...(before ? { timestamp: { lt: new Date(before) } } : {})
      },
      orderBy: { timestamp: 'asc' },
      take: limit
    });

    return NextResponse.json({ messages });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch messages:', error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(request);
    const { id } = await params;

    // Verify conversation belongs to this account
    const conversation = await prisma.conversation.findFirst({
      where: { id, lead: { accountId: auth.accountId } }
    });
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const {
      content,
      sender = 'HUMAN',
      stage,
      stageConfidence,
      sentimentScore,
      systemPromptVersion,
      followUpAttemptNumber
    } = body;

    if (!content) {
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 }
      );
    }

    const now = new Date();

    const message = await prisma.message.create({
      data: {
        conversationId: id,
        content,
        sender,
        timestamp: now,
        // Self-optimizing layer tracking fields (only set for AI messages)
        ...(sender === 'AI'
          ? {
              stage: stage ?? null,
              stageConfidence:
                typeof stageConfidence === 'number'
                  ? Math.max(0, Math.min(1, stageConfidence))
                  : null,
              sentimentScore:
                typeof sentimentScore === 'number'
                  ? Math.max(-1, Math.min(1, sentimentScore))
                  : null,
              systemPromptVersion: systemPromptVersion ?? null,
              followUpAttemptNumber: followUpAttemptNumber ?? null
            }
          : {})
      }
    });

    // If human override, pause AI and update lastMessageAt
    const updateData: { lastMessageAt: Date; aiActive?: boolean } = {
      lastMessageAt: now
    };
    if (sender === 'HUMAN') {
      updateData.aiActive = false;
    }

    const updatedConvo = await prisma.conversation.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        leadId: true,
        aiActive: true,
        unreadCount: true,
        lastMessageAt: true
      }
    });

    // Broadcast real-time events
    broadcastNewMessage({
      id: message.id,
      conversationId: id,
      sender: message.sender,
      content: message.content,
      timestamp: message.timestamp.toISOString()
    });

    broadcastConversationUpdate({
      id: updatedConvo.id,
      leadId: updatedConvo.leadId,
      aiActive: updatedConvo.aiActive,
      unreadCount: updatedConvo.unreadCount,
      lastMessageAt: updatedConvo.lastMessageAt?.toISOString()
    });

    if (sender === 'HUMAN') {
      broadcastAIStatusChange({ conversationId: id, aiActive: false });
    }

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to send message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
