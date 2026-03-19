import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // Find conversations that ended in LEFT_ON_READ or where lead is GHOSTED
    const droppedConversations = await prisma.conversation.findMany({
      where: {
        lead: { accountId: auth.accountId },
        OR: [{ outcome: 'LEFT_ON_READ' }, { lead: { status: 'GHOSTED' } }]
      },
      include: {
        messages: {
          where: { sender: 'AI' },
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: {
            content: true,
            stage: true
          }
        }
      }
    });

    const total = droppedConversations.length;

    // Collect last AI messages (the ones that got no reply)
    const lastAIMessages: { stage: string; preview: string }[] = [];
    for (const convo of droppedConversations) {
      const lastMsg = convo.messages[0];
      if (lastMsg) {
        lastAIMessages.push({
          stage: lastMsg.stage || 'unknown',
          preview: lastMsg.content.substring(0, 50)
        });
      }
    }

    // Group by stage
    const stageCounts = new Map<string, number>();
    for (const msg of lastAIMessages) {
      stageCounts.set(msg.stage, (stageCounts.get(msg.stage) || 0) + 1);
    }

    const byStage = Array.from(stageCounts.entries())
      .map(([stage, count]) => ({
        stage,
        count,
        percentage: total > 0 ? Math.round((count / total) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);

    // Group by message preview (first 50 chars) + stage
    const messagePatterns = new Map<
      string,
      { preview: string; stage: string; count: number }
    >();
    for (const msg of lastAIMessages) {
      const key = `${msg.stage}::${msg.preview}`;
      if (!messagePatterns.has(key)) {
        messagePatterns.set(key, {
          preview: msg.preview,
          stage: msg.stage,
          count: 0
        });
      }
      messagePatterns.get(key)!.count++;
    }

    const topDropOffMessages = Array.from(messagePatterns.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return NextResponse.json({ byStage, topDropOffMessages, total });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch drop-off hotspots:', error);
    return NextResponse.json(
      { error: 'Failed to fetch drop-off hotspot data' },
      { status: 500 }
    );
  }
}
