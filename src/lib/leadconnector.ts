import { getCredentials } from '@/lib/credential-store';

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

/**
 * Resolve LeadConnector credentials for the given account.
 * Tries the per-account credential store first, then falls back to env vars.
 */
async function resolveLeadConnectorCredentials(accountId: string): Promise<{
  apiKey: string;
  calendarId: string;
  locationId: string;
}> {
  const stored = await getCredentials(accountId, 'LEADCONNECTOR');

  const apiKey = stored?.apiKey ?? process.env.LEADCONNECTOR_API_KEY;
  const calendarId =
    stored?.calendarId ?? process.env.LEADCONNECTOR_CALENDAR_ID;
  const locationId =
    stored?.locationId ?? process.env.LEADCONNECTOR_LOCATION_ID;

  if (!apiKey) {
    throw new Error(
      `No LeadConnector API key found for account ${accountId}. ` +
        'Store credentials via the credential store or set LEADCONNECTOR_API_KEY env var.'
    );
  }
  if (!calendarId) {
    throw new Error(
      `No LeadConnector calendar ID found for account ${accountId}. ` +
        'Store credentials via the credential store or set LEADCONNECTOR_CALENDAR_ID env var.'
    );
  }
  if (!locationId) {
    throw new Error(
      `No LeadConnector location ID found for account ${accountId}. ` +
        'Store credentials via the credential store or set LEADCONNECTOR_LOCATION_ID env var.'
    );
  }

  return { apiKey, calendarId, locationId };
}

async function getHeaders(accountId: string): Promise<HeadersInit> {
  const { apiKey } = await resolveLeadConnectorCredentials(accountId);
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: API_VERSION
  };
}

// ─── Types ──────────────────────────────────────────────

export interface TimeSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
  available: boolean;
}

export interface AppointmentResult {
  appointmentId: string;
  confirmationUrl: string;
}

export interface ContactResult {
  contactId: string;
}

export interface Calendar {
  id: string;
  name: string;
}

export interface BookAppointmentParams {
  contactId: string;
  calendarId: string;
  startTime: string;
  endTime: string;
  title: string;
  notes?: string;
}

export interface CreateContactParams {
  name: string;
  email?: string;
  phone?: string;
  tags?: string[];
}

// ─── Functions ──────────────────────────────────────────

/**
 * Get available calendar slots for the given date range.
 */
export async function getAvailability(
  accountId: string,
  startDate: string,
  endDate: string
): Promise<TimeSlot[]> {
  const { calendarId } = await resolveLeadConnectorCredentials(accountId);
  const params = new URLSearchParams({
    startDate,
    endDate
  });

  const response = await fetch(
    `${BASE_URL}/calendars/${calendarId}/free-slots?${params}`,
    { headers: await getHeaders(accountId) }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LeadConnector availability error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  // LeadConnector returns slots grouped by date; flatten into TimeSlot[]
  const slots: TimeSlot[] = [];
  const slotsData = data?.slots ?? data ?? {};

  for (const [, daySlots] of Object.entries(slotsData)) {
    if (Array.isArray(daySlots)) {
      for (const slot of daySlots) {
        slots.push({
          start: slot.start ?? slot.startTime,
          end: slot.end ?? slot.endTime,
          available: true
        });
      }
    }
  }

  return slots;
}

/**
 * Book an appointment on the calendar.
 */
export async function bookAppointment(
  accountId: string,
  params: BookAppointmentParams
): Promise<AppointmentResult> {
  const { calendarId, locationId } =
    await resolveLeadConnectorCredentials(accountId);

  const response = await fetch(`${BASE_URL}/calendars/events/appointments`, {
    method: 'POST',
    headers: await getHeaders(accountId),
    body: JSON.stringify({
      calendarId: params.calendarId || calendarId,
      locationId,
      contactId: params.contactId,
      startTime: params.startTime,
      endTime: params.endTime,
      title: params.title,
      notes: params.notes ?? '',
      appointmentStatus: 'confirmed'
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LeadConnector booking error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  return {
    appointmentId: data.id ?? data.appointmentId,
    confirmationUrl:
      data.confirmationUrl ??
      `https://app.leadconnectorhq.com/appointments/${data.id ?? data.appointmentId}`
  };
}

/**
 * Create a new contact in LeadConnector.
 */
export async function createContact(
  accountId: string,
  params: CreateContactParams
): Promise<ContactResult> {
  const { locationId } = await resolveLeadConnectorCredentials(accountId);

  const response = await fetch(`${BASE_URL}/contacts`, {
    method: 'POST',
    headers: await getHeaders(accountId),
    body: JSON.stringify({
      locationId,
      name: params.name,
      email: params.email,
      phone: params.phone,
      tags: params.tags ?? []
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LeadConnector create contact error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  return {
    contactId: data.contact?.id ?? data.id ?? data.contactId
  };
}

/**
 * List all calendars in the location.
 */
export async function getCalendars(accountId: string): Promise<Calendar[]> {
  const { locationId } = await resolveLeadConnectorCredentials(accountId);
  const params = new URLSearchParams({
    locationId
  });

  const response = await fetch(`${BASE_URL}/calendars?${params}`, {
    headers: await getHeaders(accountId)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LeadConnector calendars error (${response.status}): ${errorBody}`
    );
  }

  const data = await response.json();

  return (data.calendars ?? []).map((c: { id: string; name: string }) => ({
    id: c.id,
    name: c.name
  }));
}

/**
 * Cancel an existing appointment.
 */
export async function cancelAppointment(
  accountId: string,
  appointmentId: string
): Promise<void> {
  const response = await fetch(
    `${BASE_URL}/calendars/events/appointments/${appointmentId}`,
    {
      method: 'PUT',
      headers: await getHeaders(accountId),
      body: JSON.stringify({
        appointmentStatus: 'cancelled'
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `LeadConnector cancel error (${response.status}): ${errorBody}`
    );
  }
}
