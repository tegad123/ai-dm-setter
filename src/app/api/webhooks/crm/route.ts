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
    const { accountId, leadId, showed, closed, dealValue, closeReason, notes } =
      body;

    // Leak-audit 6-1/2-1 (CRITICAL cross-tenant WRITE): the secret is
    // currently platform-wide, and the lead was resolved by caller-supplied
    // `leadId` with NO account scope — so any holder of the shared secret
    // could POST an arbitrary leadId and mutate ANY other tenant's lead
    // (force CLOSED_WON, set revenue, corrupt their pipeline). Require the
    // caller to name the account and scope EVERY lookup/write to
    // { id: leadId, accountId }: a leadId that does not belong to the named
    // account 404s, so the shared secret can no longer reach across tenants.
    // (Full fix — a per-account CRM secret in IntegrationCredential, matching
    // LeadConnector/Typeform — needs a `CRM` IntegrationProvider enum value
    // and a migration; tracked as the follow-on. This scoping closes the
    // cross-tenant mutation today without a schema change.)
    if (!accountId || !leadId || showed === undefined) {
      return NextResponse.json(
        { error: 'accountId, leadId and showed are required' },
        { status: 400 }
      );
    }

    // Find the lead SCOPED to the named account — cross-tenant leadIds 404.
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId }
    });
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
    // Scope the write with updateMany({ id, accountId }) so it is impossible
    // to mutate a lead outside the named account even if the lead was
    // somehow re-pointed between the findFirst above and here.
    await prisma.lead.updateMany({
      where: { id: leadId, accountId },
      data: nonStageUpdate
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('POST /api/webhooks/crm error:', error);
    return NextResponse.json(
      { error: 'Failed to process CRM outcome' },
      { status: 500 }
    );
  }
}
