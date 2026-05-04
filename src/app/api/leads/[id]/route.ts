import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { broadcastLeadUpdate } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const lead = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId },
      include: {
        conversation: {
          include: {
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 10
            }
          }
        },
        notifications: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    return NextResponse.json(lead);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/leads/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch lead' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    // Verify the lead belongs to this account
    const existing = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Stage-related fields are deliberately EXCLUDED from this endpoint.
    // Every stage transition must go through PUT /api/leads/[id]/stage
    // (which calls `transitionLeadStage`) so an audit row + SSE broadcast
    // always lands. Allowing `stage` here was a silent-revert vector —
    // Steven Petty's 2026-04-20 CALL_PROPOSED → UNQUALIFIED flip with no
    // LeadStageTransition record traces to a path like this one.
    const allowedFields = [
      'qualityScore',
      'bookedAt',
      'showedUp',
      'closedAt',
      'revenue'
    ];
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    }
    // Surface an explicit 400 if a caller still tries to send stage via
    // this endpoint — silent drops would mask bugs.
    if (
      body.stage !== undefined ||
      body.previousStage !== undefined ||
      body.stageEnteredAt !== undefined
    ) {
      return NextResponse.json(
        {
          error:
            'Stage fields are not modifiable via PATCH /api/leads/[id]. Use PUT /api/leads/[id]/stage instead so the transition is audited.'
        },
        { status: 400 }
      );
    }

    const lead = await prisma.lead.update({
      where: { id },
      data
    });

    // Broadcast real-time lead update (scoped to the auth's tenant).
    broadcastLeadUpdate(auth.accountId, {
      id: lead.id,
      name: lead.name,
      stage: lead.stage,
      qualityScore: lead.qualityScore
    });

    return NextResponse.json(lead);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PATCH /api/leads/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update lead' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Verify the lead belongs to this account
    const existing = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    await prisma.lead.delete({ where: { id } });

    return NextResponse.json({ message: 'Lead deleted' });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/leads/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete lead' },
      { status: 500 }
    );
  }
}
