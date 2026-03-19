// ─── Calendar Adapter — Unified interface for all calendar providers ─────
// Delegates to LeadConnector, Calendly, or Cal.com based on account config.

import prisma from '@/lib/prisma';
import {
  getAvailability as getLeadConnectorAvailability,
  bookAppointment as bookLeadConnectorAppointment,
  createContact as createLeadConnectorContact
} from '@/lib/leadconnector';
import {
  getCalendlyAvailability,
  getCalendlySchedulingLink
} from '@/lib/calendly';
import { getCalcomAvailability, bookCalcomAppointment } from '@/lib/calcom';

// ─── Types ──────────────────────────────────────────────

export type CalendarProvider = 'LEADCONNECTOR' | 'CALENDLY' | 'CALCOM';

export interface UnifiedTimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface UnifiedBookingResult {
  provider: CalendarProvider;
  appointmentId: string;
  confirmationUrl: string | null;
  meetingUrl: string | null;
  startTime: string;
}

export interface BookingParams {
  leadName: string;
  leadEmail?: string;
  leadHandle: string;
  platform: string;
  slotStart: string;
  slotEnd: string;
  notes?: string;
}

// ─── Provider Detection ─────────────────────────────────

/**
 * Determine which calendar provider the account has configured.
 * Checks IntegrationCredential table for active calendar providers.
 * Priority: LeadConnector > Calendly > Cal.com
 */
export async function detectCalendarProvider(
  accountId: string
): Promise<CalendarProvider | null> {
  const credentials = await prisma.integrationCredential.findMany({
    where: {
      accountId,
      provider: { in: ['LEADCONNECTOR', 'CALENDLY', 'CALCOM'] },
      isActive: true
    },
    select: { provider: true }
  });

  const providers = credentials.map((c) => c.provider);

  // Priority order
  if (providers.includes('LEADCONNECTOR')) return 'LEADCONNECTOR';
  if (providers.includes('CALENDLY')) return 'CALENDLY';
  if (providers.includes('CALCOM')) return 'CALCOM';

  return null;
}

// ─── Unified Functions ──────────────────────────────────

/**
 * Get availability from whatever calendar provider the account uses.
 */
export async function getUnifiedAvailability(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<{ provider: CalendarProvider; slots: UnifiedTimeSlot[] }> {
  const provider = await detectCalendarProvider(accountId);

  if (!provider) {
    throw new Error(
      'No calendar provider configured. Connect LeadConnector, Calendly, or Cal.com in Settings → Integrations.'
    );
  }

  let slots: UnifiedTimeSlot[] = [];

  switch (provider) {
    case 'LEADCONNECTOR': {
      const lcSlots = await getLeadConnectorAvailability(
        accountId,
        startDate,
        endDate
      );
      slots = lcSlots.map((s) => ({
        start: s.start,
        end: s.end,
        available: s.available
      }));
      break;
    }
    case 'CALENDLY': {
      const calSlots = await getCalendlyAvailability(
        accountId,
        startDate,
        endDate
      );
      slots = calSlots.map((s) => ({
        start: s.start,
        end: s.end,
        available: s.available
      }));
      break;
    }
    case 'CALCOM': {
      const ccSlots = await getCalcomAvailability(
        accountId,
        startDate,
        endDate
      );
      slots = ccSlots.map((s) => ({
        start: s.start,
        end: s.end,
        available: s.available
      }));
      break;
    }
  }

  return { provider, slots };
}

/**
 * Book an appointment using whatever calendar provider the account uses.
 */
export async function bookUnifiedAppointment(
  accountId: string,
  params: BookingParams
): Promise<UnifiedBookingResult> {
  const provider = await detectCalendarProvider(accountId);

  if (!provider) {
    throw new Error(
      'No calendar provider configured. Connect a calendar in Settings → Integrations.'
    );
  }

  switch (provider) {
    case 'LEADCONNECTOR': {
      // Create contact first, then book
      const { contactId } = await createLeadConnectorContact(accountId, {
        name: params.leadName,
        tags: ['AI-DM-Setter', params.platform]
      });

      const { appointmentId, confirmationUrl } =
        await bookLeadConnectorAppointment(accountId, {
          contactId,
          calendarId: '',
          startTime: params.slotStart,
          endTime: params.slotEnd,
          title: `Sales Call — ${params.leadName} (@${params.leadHandle})`,
          notes: params.notes
        });

      return {
        provider: 'LEADCONNECTOR',
        appointmentId,
        confirmationUrl,
        meetingUrl: null,
        startTime: params.slotStart
      };
    }

    case 'CALENDLY': {
      // Calendly uses hosted pages — return the scheduling link
      const { schedulingUrl } = await getCalendlySchedulingLink(accountId);

      return {
        provider: 'CALENDLY',
        appointmentId: '',
        confirmationUrl: schedulingUrl,
        meetingUrl: null,
        startTime: params.slotStart
      };
    }

    case 'CALCOM': {
      const result = await bookCalcomAppointment(accountId, {
        startTime: params.slotStart,
        attendeeName: params.leadName,
        attendeeEmail:
          params.leadEmail || `${params.leadHandle}@placeholder.com`,
        notes: params.notes
      });

      return {
        provider: 'CALCOM',
        appointmentId: result.bookingId,
        confirmationUrl: null,
        meetingUrl: result.meetingUrl,
        startTime: result.startTime
      };
    }
  }
}
