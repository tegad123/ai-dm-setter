import prisma from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const staleThreshold = new Date(Date.now() - 72 * 60 * 60 * 1000);

    const staleConversations = await prisma.conversation.findMany({
      where: {
        outcome: 'ONGOING',
        lastMessageAt: { lt: staleThreshold }
      },
      include: {
        messages: { orderBy: { timestamp: 'desc' }, take: 1 }
      }
    });

    let updated = 0;
    for (const convo of staleConversations) {
      const lastMsg = convo.messages[0];
      if (lastMsg && lastMsg.sender !== 'LEAD') {
        await prisma.conversation.update({
          where: { id: convo.id },
          data: { outcome: 'LEFT_ON_READ' }
        });
        updated++;
      }
    }

    return NextResponse.json({ updated, checked: staleConversations.length });
  } catch (error) {
    console.error('GET /api/cron/stale-conversations error:', error);
    return NextResponse.json(
      { error: 'Failed to process stale conversations' },
      { status: 500 }
    );
  }
}
