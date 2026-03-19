import { bookAppointment, createContact } from '@/lib/leadconnector';
import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
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

    // Create or find contact in LeadConnector (uses account's credentials)
    const { contactId } = await createContact(auth.accountId, {
      name: lead.name,
      tags: ['AI-DM-Setter', lead.platform, lead.status]
    });

    // Book the appointment (calendarId comes from account's credential store)
    const { appointmentId, confirmationUrl } = await bookAppointment(
      auth.accountId,
      {
        contactId,
        calendarId: '', // overridden by bookAppointment from credential store
        startTime: slotStart,
        endTime: slotEnd,
        title: `Sales Call — ${lead.name} (@${lead.handle})`,
        notes:
          notes ??
          `Auto-booked via DM Setter. Platform: ${lead.platform}. Lead status: ${lead.status}.`
      }
    );

    // Update lead status to BOOKED
    await prisma.lead.update({
      where: { id: leadId },
      data: {
        status: 'BOOKED',
        bookedAt: new Date()
      }
    });

    // Create team notification for the booked call
    await prisma.notification.create({
      data: {
        accountId: auth.accountId,
        type: 'CALL_BOOKED',
        title: 'New Call Booked',
        body: `${lead.name} (@${lead.handle}) booked a sales call for ${new Date(slotStart).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}.`,
        leadId: lead.id,
        userId: null // null = team-wide notification
      }
    });

    return NextResponse.json({
      appointmentId,
      confirmationUrl
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
