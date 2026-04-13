import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { transitionLeadStage } from '@/lib/lead-stage';
import { LeadStage } from '@prisma/client';
import { NextRequest, NextResponse } from 'next/server';

const VALID_STAGES = new Set<string>(Object.values(LeadStage));

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const transitions = await prisma.leadStageTransition.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return NextResponse.json({ transitions });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/leads/[id]/stage error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch stage history' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    const { stage, reason } = body as { stage: string; reason?: string };

    // Validate stage is a valid LeadStage value
    if (!stage || !VALID_STAGES.has(stage)) {
      return NextResponse.json(
        {
          error: `Invalid stage "${stage}". Must be one of: ${Array.from(VALID_STAGES).join(', ')}`
        },
        { status: 400 }
      );
    }

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const updatedLead = await transitionLeadStage(
      id,
      stage as LeadStage,
      'user',
      reason
    );

    return NextResponse.json({
      id: updatedLead.id,
      stage: updatedLead.stage,
      previousStage: updatedLead.previousStage,
      stageEnteredAt: updatedLead.stageEnteredAt
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/leads/[id]/stage error:', error);
    return NextResponse.json(
      { error: 'Failed to transition stage' },
      { status: 500 }
    );
  }
}
