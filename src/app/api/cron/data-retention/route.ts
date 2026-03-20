import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

const RETENTION_DAYS = 90;

export async function GET(req: NextRequest) {
  try {
    // Validate bearer token against CRON_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const retentionThreshold = new Date(
      Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    );

    // 1. Redact old message content (keep metadata)
    const redactedMessages = await prisma.message.updateMany({
      where: {
        timestamp: { lt: retentionThreshold },
        content: { not: '[REDACTED - 90 day retention]' }
      },
      data: {
        content: '[REDACTED - 90 day retention]'
      }
    });

    // 2. Anonymize leads with no conversations in 90 days
    //    Find leads whose conversation has no messages newer than the threshold
    //    OR leads with no conversation at all and created > 90 days ago
    const staleLeads = await prisma.lead.findMany({
      where: {
        AND: [
          // Not already anonymized
          { NOT: { name: { startsWith: 'Lead #' } } },
          { NOT: { handle: { startsWith: 'anon_' } } },
          // No recent conversation activity
          {
            OR: [
              // Has a conversation but no messages in 90 days
              {
                conversation: {
                  lastMessageAt: { lt: retentionThreshold }
                }
              },
              // Has a conversation with no lastMessageAt set and it was created > 90 days ago
              {
                conversation: {
                  lastMessageAt: null,
                  createdAt: { lt: retentionThreshold }
                }
              },
              // Has no conversation at all and was created > 90 days ago
              {
                conversation: null,
                createdAt: { lt: retentionThreshold }
              }
            ]
          }
        ]
      },
      select: { id: true, name: true, handle: true }
    });

    let leadsAnonymized = 0;
    for (const lead of staleLeads) {
      const hash = createHash('sha256')
        .update(lead.id)
        .digest('hex')
        .slice(0, 8);

      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          name: `Lead #${hash}`,
          handle: `anon_${hash}`
        }
      });
      leadsAnonymized++;
    }

    console.log(
      `[CRON] Data retention: ${redactedMessages.count} messages redacted, ${leadsAnonymized} leads anonymized`
    );

    return NextResponse.json({
      messagesRedacted: redactedMessages.count,
      leadsAnonymized,
      retentionDays: RETENTION_DAYS,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('GET /api/cron/data-retention error:', error);
    return NextResponse.json(
      { error: 'Failed to run data retention' },
      { status: 500 }
    );
  }
}
