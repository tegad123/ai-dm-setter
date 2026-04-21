import prisma from '@/lib/prisma';
import { transitionLeadStage } from '@/lib/lead-stage';
import type { LeadStage } from '@prisma/client';
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

    // Determine the target stage from the CRM outcome, then transition
    // via the sanctioned helper so the change lands an audit row. The
    // non-stage fields (showedUp, closedAt, revenue) ride in a second
    // update — they're not part of the stage-transition schema.
    let nextStage: LeadStage;
    if (closed) {
      nextStage = 'CLOSED_WON';
    } else if (showed) {
      nextStage = 'SHOWED';
    } else {
      nextStage = 'NO_SHOWED';
    }

    const reasonBits: string[] = [`CRM webhook: showed=${showed}`];
    if (closed) reasonBits.push('closed=true');
    if (dealValue != null) reasonBits.push(`deal=${dealValue}`);
    if (closeReason) reasonBits.push(`reason="${closeReason}"`);
    await transitionLeadStage(
      leadId,
      nextStage,
      'system',
      reasonBits.join(', ')
    );

    const nonStageUpdate: Record<string, unknown> = { showedUp: showed };
    if (closed) {
      nonStageUpdate.closedAt = new Date();
      if (dealValue) nonStageUpdate.revenue = dealValue;
    }
    await prisma.lead.update({ where: { id: leadId }, data: nonStageUpdate });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/webhooks/crm error:', error);
    return NextResponse.json(
      { error: 'Failed to process CRM outcome' },
      { status: 500 }
    );
  }
}
