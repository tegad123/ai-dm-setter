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

    const allowedFields = [
      'stage',
      'previousStage',
      'stageEnteredAt',
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

    const lead = await prisma.lead.update({
      where: { id },
      data
    });

    // Broadcast real-time lead update
    broadcastLeadUpdate({
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
