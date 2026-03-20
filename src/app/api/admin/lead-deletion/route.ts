import { createHash } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    // ADMIN role check
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { leadId } = body;

    if (!leadId || typeof leadId !== 'string') {
      return NextResponse.json(
        { error: 'leadId is required' },
        { status: 400 }
      );
    }

    // Verify lead belongs to this account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId },
      include: {
        conversation: {
          select: { id: true }
        }
      }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // 1. Delete all raw message content for the lead (set to "[DELETED]")
    let messagesDeleted = 0;
    if (lead.conversation) {
      const result = await prisma.message.updateMany({
        where: {
          conversationId: lead.conversation.id,
          content: { not: '[DELETED]' }
        },
        data: {
          content: '[DELETED]'
        }
      });
      messagesDeleted = result.count;
    }

    // 2. Anonymize lead PII
    const hash = createHash('sha256').update(lead.id).digest('hex').slice(0, 8);

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        name: 'Deleted Lead',
        handle: `deleted_${hash}`,
        platformUserId: null
      }
    });

    // 3. Keep anonymized conversation metadata (stages, outcomes, timestamps)
    //    — no action needed, we only modified message content and lead PII above

    console.log(
      `[GDPR] Lead ${leadId} deleted by admin ${auth.userId}: ` +
        `${messagesDeleted} messages cleared, PII anonymized`
    );

    return NextResponse.json({
      message: 'Lead data deleted successfully (GDPR)',
      messagesDeleted,
      leadAnonymized: true
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/admin/lead-deletion error:', error);
    return NextResponse.json(
      { error: 'Failed to delete lead data' },
      { status: 500 }
    );
  }
}
