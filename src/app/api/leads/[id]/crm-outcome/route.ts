import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { transitionLeadStage } from '@/lib/lead-stage';
import type { LeadStage } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();
    const { showed, closed, dealValue, closeReason, notes } = body;

    if (showed === undefined) {
      return NextResponse.json(
        { error: 'showed is required' },
        { status: 400 }
      );
    }

    // Verify the lead belongs to this account
    const lead = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Create CRM outcome record
    const crmOutcome = await prisma.crmOutcome.create({
      data: {
        accountId: auth.accountId,
        leadId: id,
        showed,
        closed: closed ?? false,
        dealValue: dealValue ?? null,
        closeReason: closeReason ?? null,
        notes: notes ?? null,
        source: 'manual'
      }
    });

    // Determine target stage and transition via the sanctioned helper
    // so every CRM outcome lands an audit row. Non-stage fields
    // (showedUp, closedAt, revenue) are updated separately.
    let nextStage: LeadStage;
    if (closed) {
      nextStage = 'CLOSED_WON';
    } else if (showed) {
      nextStage = 'SHOWED';
    } else {
      nextStage = 'NO_SHOWED';
    }

    const reasonBits: string[] = [`Manual CRM outcome: showed=${showed}`];
    if (closed) reasonBits.push('closed=true');
    if (dealValue != null) reasonBits.push(`deal=${dealValue}`);
    if (closeReason) reasonBits.push(`reason="${closeReason}"`);
    await transitionLeadStage(id, nextStage, 'user', reasonBits.join(', '));

    const nonStageUpdate: Record<string, unknown> = { showedUp: showed };
    if (closed) {
      nonStageUpdate.closedAt = new Date();
      if (dealValue) nonStageUpdate.revenue = dealValue;
    }
    const updatedLead = await prisma.lead.update({
      where: { id },
      data: nonStageUpdate
    });

    return NextResponse.json({ crmOutcome, lead: updatedLead });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/leads/[id]/crm-outcome error:', error);
    return NextResponse.json(
      { error: 'Failed to create CRM outcome' },
      { status: 500 }
    );
  }
}
