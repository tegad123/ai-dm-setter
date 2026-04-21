import { bookUnifiedAppointment } from '@/lib/calendar-adapter';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { calculateAndApplyCommissions } from '@/lib/commission-calculator';
import { transitionLeadStage } from '@/lib/lead-stage';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { leadId, slotStart, slotEnd, notes } = body as {
      leadId?: string;
      slotStart?: string;
      slotEnd?: string;
      notes?: string;
    };

    if (!leadId || !slotStart || !slotEnd) {
      return NextResponse.json(
        { error: 'leadId, slotStart, and slotEnd are required' },
        { status: 400 }
      );
    }

    // Fetch lead (scoped to account)
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Book using the unified calendar adapter (auto-detects provider)
    const result = await bookUnifiedAppointment(auth.accountId, {
      leadName: lead.name,
      leadHandle: lead.handle,
      platform: lead.platform,
      slotStart,
      slotEnd,
      notes:
        notes ??
        `Auto-booked via DM Setter. Platform: ${lead.platform}. Lead stage: ${lead.stage}.`
    });

    // Update lead stage to BOOKED via the sanctioned helper so the
    // transition lands an audit row + SSE broadcast. The `bookedAt`
    // timestamp is updated separately because it isn't part of the
    // stage-transition schema.
    await transitionLeadStage(
      leadId,
      'BOOKED',
      'user',
      `Calendar booking created (provider=${result.provider}, slot=${slotStart})`
    );
    await prisma.lead.update({
      where: { id: leadId },
      data: { bookedAt: new Date() }
    });

    // Update content attribution callsBooked count if linked
    if (lead.contentAttributionId) {
      await prisma.contentAttribution.update({
        where: { id: lead.contentAttributionId },
        data: { callsBooked: { increment: 1 } }
      });
    }

    // Create team notification for the booked call
    await prisma.notification.create({
      data: {
        accountId: auth.accountId,
        type: 'CALL_BOOKED',
        title: 'New Call Booked',
        body: `${lead.name} (@${lead.handle}) booked a call for ${new Date(slotStart).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. Provider: ${result.provider}.`,
        leadId: lead.id,
        userId: null
      }
    });

    return NextResponse.json({
      provider: result.provider,
      appointmentId: result.appointmentId,
      confirmationUrl: result.confirmationUrl,
      meetingUrl: result.meetingUrl,
      startTime: result.startTime
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/calendar/book error:', error);
    return NextResponse.json(
      { error: 'Failed to book appointment' },
      { status: 500 }
    );
  }
}
