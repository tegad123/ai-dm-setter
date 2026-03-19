import prisma from '@/lib/prisma';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    // Validate bearer token against CRM_WEBHOOK_SECRET env var
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRM_WEBHOOK_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { leadId, showed, closed, dealValue, closeReason, notes } = body;

    if (!leadId || showed === undefined) {
      return NextResponse.json(
        { error: 'leadId and showed are required' },
        { status: 400 }
      );
    }

    // Find the lead
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Create CRM outcome record
    await prisma.crmOutcome.create({
      data: {
        accountId: lead.accountId,
        leadId,
        showed,
        closed: closed ?? false,
        dealValue: dealValue ?? null,
        closeReason: closeReason ?? null,
        notes: notes ?? null,
        source: 'webhook'
      }
    });

    // Update lead status based on outcome
    const leadUpdate: Record<string, unknown> = { showedUp: showed };
    if (showed) leadUpdate.status = 'SHOWED_UP';
    if (closed) {
      leadUpdate.status = 'CLOSED';
      leadUpdate.closedAt = new Date();
      if (dealValue) leadUpdate.revenue = dealValue;
    }
    if (!showed) leadUpdate.status = 'NO_SHOW';

    await prisma.lead.update({ where: { id: leadId }, data: leadUpdate });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/webhooks/crm error:', error);
    return NextResponse.json(
      { error: 'Failed to process CRM outcome' },
      { status: 500 }
    );
  }
}
