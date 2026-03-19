// ─── Calendly API Client ────────────────────────────────────────────────
// Wraps the Calendly API v2 for availability checks and booking.

import { getCredentials } from '@/lib/credential-store';

const BASE_URL = 'https://api.calendly.com';

async function resolveCalendlyCredentials(
  accountId: string
): Promise<{ apiKey: string; userUri: string; eventTypeUri: string }> {
  const stored = await getCredentials(accountId, 'CALENDLY');

  const apiKey = stored?.apiKey ?? process.env.CALENDLY_API_KEY;
  const userUri = stored?.userUri ?? process.env.CALENDLY_USER_URI;
  const eventTypeUri =
    stored?.eventTypeUri ?? process.env.CALENDLY_EVENT_TYPE_URI;

  if (!apiKey) {
    throw new Error(
      `No Calendly API key found for account ${accountId}. ` +
        'Add your Calendly Personal Access Token in Settings → Integrations.'
    );
  }
  if (!userUri) {
    throw new Error(
      `No Calendly user URI found for account ${accountId}. ` +
        'Add your Calendly user URI in Settings → Integrations.'
    );
  }

  return { apiKey, userUri, eventTypeUri: eventTypeUri || '' };
}

async function getHeaders(accountId: string): Promise<HeadersInit> {
  const { apiKey } = await resolveCalendlyCredentials(accountId);
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
}

// ─── Types ──────────────────────────────────────────────

export interface CalendlyTimeSlot {
  start: string;
  end: string;
  available: boolean;
}

export interface CalendlyBookingResult {
  schedulingUrl: string;
  eventTypeUri: string;
}

// ─── Functions ──────────────────────────────────────────

/**
 * Get available time slots from Calendly.
 * Uses the event_type_available_times endpoint.
 */
export async function getCalendlyAvailability(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<CalendlyTimeSlot[]> {
  const { eventTypeUri } = await resolveCalendlyCredentials(accountId);

  if (!eventTypeUri) {
    throw new Error('No Calendly event type URI configured.');
  }

  const params = new URLSearchParams({
    event_type: eventTypeUri,
    start_time: new Date(startDate).toISOString(),
    end_time: new Date(endDate).toISOString()
  });

  const response = await fetch(
    `${BASE_URL}/event_type_available_times?${params}`,
    { headers: await getHeaders(accountId) }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Calendly availability error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  return (data.collection ?? []).map(
    (slot: { start_time: string; status: string }) => ({
      start: slot.start_time,
      end: '', // Calendly doesn't return end time in availability, duration from event type
      available: slot.status === 'available'
    })
  );
}

/**
 * Get a scheduling link for Calendly (Calendly uses hosted booking pages).
 * Returns the scheduling URL that can be sent to the lead.
 */
export async function getCalendlySchedulingLink(
  accountId: string
): Promise<CalendlyBookingResult> {
  const { eventTypeUri } = await resolveCalendlyCredentials(accountId);

  if (!eventTypeUri) {
    throw new Error('No Calendly event type URI configured.');
  }

  // Fetch event type details to get the scheduling URL
  const response = await fetch(`${BASE_URL}/event_types/${eventTypeUri}`, {
    headers: await getHeaders(accountId)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Calendly event type error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  return {
    schedulingUrl: data.resource?.scheduling_url ?? '',
    eventTypeUri
  };
}

/**
 * List scheduled events (booked appointments).
 */
export async function getCalendlyEvents(
  accountId: string,
  minStartTime?: string,
  maxStartTime?: string
): Promise<
  Array<{
    uri: string;
    name: string;
    startTime: string;
    endTime: string;
    status: string;
  }>
> {
  const { userUri } = await resolveCalendlyCredentials(accountId);

  const params = new URLSearchParams({ user: userUri });
  if (minStartTime) params.set('min_start_time', minStartTime);
  if (maxStartTime) params.set('max_start_time', maxStartTime);

  const response = await fetch(`${BASE_URL}/scheduled_events?${params}`, {
    headers: await getHeaders(accountId)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Calendly events error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();

  return (data.collection ?? []).map(
    (event: {
      uri: string;
      name: string;
      start_time: string;
      end_time: string;
      status: string;
    }) => ({
      uri: event.uri,
      name: event.name,
      startTime: event.start_time,
      endTime: event.end_time,
      status: event.status
    })
  );
}
