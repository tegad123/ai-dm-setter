// ─── Cal.com API Client ─────────────────────────────────────────────────
// Wraps the Cal.com API v2 for availability checks and booking.

import { getCredentials } from '@/lib/credential-store';

const BASE_URL = 'https://api.cal.com/v2';

async function resolveCalcomCredentials(
  accountId: string
): Promise<{ apiKey: string; eventTypeId: string }> {
  const stored = await getCredentials(accountId, 'CALCOM');

  const apiKey = stored?.apiKey ?? process.env.CALCOM_API_KEY;
  const eventTypeId = stored?.eventTypeId ?? process.env.CALCOM_EVENT_TYPE_ID;

  if (!apiKey) {
    throw new Error(
      `No Cal.com API key found for account ${accountId}. ` +
        'Add your Cal.com API key in Settings → Integrations.'
    );
  }
  if (!eventTypeId) {
    throw new Error(
      `No Cal.com event type ID found for account ${accountId}. ` +
        'Add your Cal.com event type ID in Settings → Integrations.'
    );
  }

  return { apiKey, eventTypeId };
}

async function getHeaders(accountId: string): Promise<HeadersInit> {
  const { apiKey } = await resolveCalcomCredentials(accountId);
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'cal-api-version': '2024-08-13'
  };
}

// ─── Types ──────────────────────────────────────────────

export interface CalcomTimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface CalcomBookingResult {
  bookingId: string;
  bookingUid: string;
  startTime: string;
  endTime: string;
  meetingUrl: string | null;
}

// ─── Functions ──────────────────────────────────────────

/**
 * Get available time slots from Cal.com.
 */
export async function getCalcomAvailability(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<CalcomTimeSlot[]> {
  const { eventTypeId } = await resolveCalcomCredentials(accountId);

  const params = new URLSearchParams({
    startTime: new Date(startDate).toISOString(),
    endTime: new Date(endDate).toISOString(),
    eventTypeId
  });

  const response = await fetch(`${BASE_URL}/slots?${params}`, {
    headers: await getHeaders(accountId)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Cal.com availability error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  // Cal.com returns slots grouped by date
  const slots: CalcomTimeSlot[] = [];
  const slotsData = data?.data?.slots ?? data?.slots ?? {};

  for (const [, daySlots] of Object.entries(slotsData)) {
    if (Array.isArray(daySlots)) {
      for (const slot of daySlots as Array<{ time: string }>) {
        slots.push({
          start: slot.time,
          end: '', // Cal.com uses event type duration
          available: true
        });
      }
    }
  }

  return slots;
}

/**
 * Book an appointment on Cal.com.
 */
export async function bookCalcomAppointment(
  accountId: string,
  params: {
    startTime: string;
    attendeeName: string;
    attendeeEmail: string;
    notes?: string;
  }
): Promise<CalcomBookingResult> {
  const { eventTypeId } = await resolveCalcomCredentials(accountId);

  const response = await fetch(`${BASE_URL}/bookings`, {
    method: 'POST',
    headers: await getHeaders(accountId),
    body: JSON.stringify({
      eventTypeId: parseInt(eventTypeId, 10),
      start: params.startTime,
      attendee: {
        name: params.attendeeName,
        email: params.attendeeEmail,
        timeZone: 'America/New_York'
      },
      metadata: {
        source: 'dmsetter',
        notes: params.notes ?? ''
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Cal.com booking error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const booking = data.data ?? data;

  return {
    bookingId: String(booking.id ?? booking.bookingId),
    bookingUid: booking.uid ?? '',
    startTime: booking.startTime ?? booking.start ?? params.startTime,
    endTime: booking.endTime ?? booking.end ?? '',
    meetingUrl: booking.meetingUrl ?? booking.metadata?.videoCallUrl ?? null
  };
}

/**
 * Cancel a Cal.com booking.
 */
export async function cancelCalcomBooking(
  accountId: string,
  bookingId: string
): Promise<void> {
  const response = await fetch(`${BASE_URL}/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers: await getHeaders(accountId),
    body: JSON.stringify({
      cancellationReason: 'Cancelled via DMsetter'
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Cal.com cancel error (${response.status}): ${errorBody}`);
  }
}
