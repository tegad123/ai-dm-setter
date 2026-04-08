import prisma from '@/lib/prisma';
import { processScheduledReply } from '@/lib/webhook-processor';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    console.log('[cron] starting');
    const now = new Date();

    // Find pending replies that are due
    const pendingReplies = await prisma.scheduledReply.findMany({
      where: {
        status: 'PENDING',
        scheduledFor: { lte: now },
        attempts: { lt: 3 }
      },
      orderBy: { scheduledFor: 'asc' },
      take: 10
    });
    console.log(`[cron] picked up ${pendingReplies.length} pending replies`);

    if (pendingReplies.length === 0) {
      return NextResponse.json({ processed: 0, failed: 0, total: 0 });
    }

    // Mark as PROCESSING (optimistic lock to prevent double-pickup)
    const ids = pendingReplies.map((r) => r.id);
    await prisma.scheduledReply.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'PROCESSING' }
    });

    let sent = 0;
    let failed = 0;

    for (const reply of pendingReplies) {
      console.log(
        `[cron] processing reply ${reply.id} convo=${reply.conversationId}`
      );
      try {
        await processScheduledReply(reply.conversationId, reply.accountId);
        console.log(`[cron] processed reply ${reply.id} OK`);

        await prisma.scheduledReply.update({
          where: { id: reply.id },
          data: { status: 'SENT', processedAt: new Date() }
        });
        sent++;
      } catch (err: any) {
        console.error(
          `[cron] Failed to process scheduled reply ${reply.id}:`,
          err
        );
        await prisma.scheduledReply.update({
          where: { id: reply.id },
          data: {
            status: reply.attempts + 1 >= 3 ? 'FAILED' : 'PENDING',
            attempts: { increment: 1 },
            lastError: (err?.message || 'Unknown error').slice(0, 500)
          }
        });
        failed++;
      }
    }

    console.log(
      `[cron] Processed scheduled replies: ${sent} sent, ${failed} failed`
    );
    return NextResponse.json({
      processed: sent,
      failed,
      total: pendingReplies.length
    });
  } catch (error) {
    console.error('[cron] process-scheduled-replies error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
