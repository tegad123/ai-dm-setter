import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
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

    // Update lead stage based on outcome
    const leadUpdate: Record<string, unknown> = { showedUp: showed };
    if (showed) leadUpdate.stage = 'SHOWED';
    if (closed) {
      leadUpdate.stage = 'CLOSED_WON';
      leadUpdate.closedAt = new Date();
      if (dealValue) leadUpdate.revenue = dealValue;
    }
    if (!showed) leadUpdate.stage = 'NO_SHOWED';

    const updatedLead = await prisma.lead.update({
      where: { id },
      data: leadUpdate
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
