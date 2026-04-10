import { getCredentials } from '@/lib/credential-store';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TimeSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

export interface AvailabilityResult {
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'none';
  slots: TimeSlot[];
  timezone?: string;
}

export interface BookingParams {
  leadName: string;
  leadHandle?: string;
  leadEmail?: string;
  leadPhone?: string;
  platform?: string;
  slotStart: string; // ISO 8601
  slotEnd?: string; // ISO 8601
  timezone?: string;
  notes?: string;
}

export interface BookingResult {
  success: boolean;
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'none';
  appointmentId?: string;
  contactId?: string;
  confirmationUrl?: string;
  meetingUrl?: string;
  startTime?: string;
  bookingId?: string;
  bookingUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// LeadConnector / HighLevel v2 API constants
// ---------------------------------------------------------------------------

const LC_BASE = 'https://services.leadconnectorhq.com';
const LC_VERSION = '2021-07-28';

function lcHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: LC_VERSION
  };
}

// ---------------------------------------------------------------------------
// Unified public API
// ---------------------------------------------------------------------------

/**
 * Fetch real availability across configured calendar providers.
 *
 * Resolution order:
 *   1. LeadConnector / HighLevel (preferred for DMsetter tenants)
 *   2. Calendly (fallback)
 *   3. Cal.com (fallback)
 *
 * @param accountId  Tenant account id
 * @param startDate  ISO date or ISO datetime (inclusive)
 * @param endDate    ISO date or ISO datetime (inclusive)
 * @param timezone   IANA timezone string (e.g. "America/New_York"). If the
 *                   lead has disclosed their timezone, pass it so providers
 *                   return slots already localized.
 */
export async function getUnifiedAvailability(
  accountId: string,
  startDate?: string,
  endDate?: string,
  timezone?: string
): Promise<AvailabilityResult> {
  const range =
    startDate && endDate ? { start: startDate, end: endDate } : undefined;

  // 1. LeadConnector first
  const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
  if (lcCreds?.apiKey && lcCreds?.calendarId) {
    try {
      const slots = await getLeadConnectorAvailability(
        lcCreds.apiKey as string,
        lcCreds.calendarId as string,
        range,
        timezone
      );
      return { provider: 'leadconnector', slots, timezone };
    } catch (err) {
      console.error(
        '[calendar-adapter] LeadConnector availability failed:',
        err
      );
    }
  }

  // 2. Calendly
  const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
  if (calendlyCreds?.apiKey) {
    const slots = await getCalendlyAvailability(
      calendlyCreds.apiKey as string,
      range
    );
    return { provider: 'calendly', slots };
  }

  // 3. Cal.com
  const calcomCreds = await getCredentials(accountId, 'CALCOM');
  if (calcomCreds?.apiKey) {
    const slots = await getCalcomAvailability(
      calcomCreds.apiKey as string,
      range
    );
    return { provider: 'calcom', slots };
  }

  return { provider: 'none', slots: [] };
}

/**
 * Book a call via the first configured calendar provider.
 * LeadConnector takes priority — it is the canonical DMsetter integration.
 */
export async function bookUnifiedAppointment(
  accountId: string,
  params: BookingParams
): Promise<BookingResult> {
  // 1. LeadConnector first
  const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
  if (lcCreds?.apiKey && lcCreds?.calendarId && lcCreds?.locationId) {
    try {
      return await bookLeadConnectorAppointment(
        {
          apiKey: lcCreds.apiKey as string,
          calendarId: lcCreds.calendarId as string,
          locationId: lcCreds.locationId as string
        },
        params
      );
    } catch (err) {
      return {
        success: false,
        provider: 'leadconnector',
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  // 2. Calendly (link drop only — Calendly can't book server-side via REST)
  const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
  if (calendlyCreds?.apiKey) {
    return {
      success: true,
      provider: 'calendly',
      confirmationUrl: (calendlyCreds as any).schedulingUrl || '',
      bookingUrl: (calendlyCreds as any).schedulingUrl || '',
      startTime: params.slotStart
    };
  }

  // 3. Cal.com
  const calcomCreds = await getCredentials(accountId, 'CALCOM');
  if (calcomCreds?.apiKey) {
    const result = await bookCalcomAppointment(
      calcomCreds.apiKey as string,
      params
    );
    return { ...result, provider: 'calcom', startTime: params.slotStart };
  }

  return {
    success: false,
    provider: 'none',
    error: 'No calendar provider configured'
  };
}

// ---------------------------------------------------------------------------
// LeadConnector (HighLevel v2) — primary provider
// ---------------------------------------------------------------------------

/**
 * Fetch free slots from LeadConnector for a given calendar.
 *
 * GET /calendars/{calendarId}/free-slots
 *   ?startDate={ms}&endDate={ms}&timezone={tz}
 *
 * HighLevel expects startDate/endDate as epoch milliseconds. The response is
 * an availability map keyed by YYYY-MM-DD:
 *   { "2026-04-09": { slots: ["2026-04-09T09:00:00-04:00", ...] }, ... }
 */
export async function getLeadConnectorAvailability(
  apiKey: string,
  calendarId: string,
  dateRange?: { start: string; end: string },
  timezone?: string
): Promise<TimeSlot[]> {
  try {
    // Default to next 7 days if no range supplied
    const now = new Date();
    const endDefault = new Date(now);
    endDefault.setDate(endDefault.getDate() + 7);

    const startMs = dateRange?.start
      ? new Date(dateRange.start).getTime()
      : now.getTime();
    const endMs = dateRange?.end
      ? new Date(dateRange.end).getTime()
      : endDefault.getTime();

    const qs = new URLSearchParams({
      startDate: String(startMs),
      endDate: String(endMs)
    });
    if (timezone) qs.set('timezone', timezone);

    const url = `${LC_BASE}/calendars/${encodeURIComponent(
      calendarId
    )}/free-slots?${qs.toString()}`;

    const res = await fetch(url, { headers: lcHeaders(apiKey) });
    if (!res.ok) {
      console.error(
        `[calendar-adapter] LeadConnector free-slots ${res.status}:`,
        await res.text().catch(() => '')
      );
      return [];
    }

    const data = (await res.json()) as Record<
      string,
      { slots?: string[] } | string[] | undefined
    >;

    // Flatten the { "YYYY-MM-DD": { slots: [...] } } shape into a TimeSlot[].
    const result: TimeSlot[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (!value) continue;
      // Ignore non-date keys like "traceId" if the API adds them
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;

      const rawSlots: string[] = Array.isArray(value)
        ? value
        : Array.isArray(value.slots)
          ? value.slots
          : [];

      for (const slotStart of rawSlots) {
        // HighLevel returns slot start times only. Assume a 30-min block by
        // default; the real duration comes from the calendar config on their
        // side when the appointment is created.
        const start = new Date(slotStart);
        if (isNaN(start.getTime())) continue;
        const end = new Date(start.getTime() + 30 * 60_000);
        result.push({ start: start.toISOString(), end: end.toISOString() });
      }
    }
    return result;
  } catch (err) {
    console.error('[calendar-adapter] getLeadConnectorAvailability:', err);
    return [];
  }
}

/**
 * Create (or find) a contact + book an appointment in LeadConnector.
 *
 * Booking a GHL appointment requires a contactId. We create a new contact
 * from the lead info we have. If the lead has disclosed an email, use it;
 * otherwise fall back to a handle-derived placeholder so the API accepts it.
 */
export async function bookLeadConnectorAppointment(
  creds: { apiKey: string; calendarId: string; locationId: string },
  params: BookingParams
): Promise<BookingResult> {
  const { apiKey, calendarId, locationId } = creds;

  // Split leadName into first/last for GHL contact payload
  const nameParts = (params.leadName || 'Lead').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Lead';
  const lastName = nameParts.slice(1).join(' ') || undefined;

  // Derive a safe email fallback if the lead didn't disclose one
  const safeHandle = (params.leadHandle || 'lead').replace(
    /[^a-zA-Z0-9._-]/g,
    ''
  );
  const email =
    params.leadEmail ||
    `${safeHandle || 'lead'}+${(params.platform || 'dm').toLowerCase()}@dmsetter-leads.local`;

  // 1. Create contact (GHL will return existing id if duplicate)
  //
  // Duplicate handling: when the location has "Allow Duplicate Contacts"
  // disabled (the default), POST /contacts/ returns 400 with a body shaped
  // like:
  //   { statusCode: 400, message: "This location does not allow duplicated contacts.",
  //     meta: { contactId: "...", contactName: "...", matchingField: "email" } }
  // We extract meta.contactId directly so we don't need a second API call.
  // The previous fallback used GET /contacts/lookup?email=... which LC routes
  // as /contacts/{id=lookup} and returns 400 "Contact with id lookup not
  // found" — that endpoint doesn't exist on the v2 API, which is why the
  // 2026-04-08 booking failed even though the contact already existed.
  let contactId: string | undefined;
  let contactErrText: string | undefined;
  let contactErrStatus: number | undefined;
  try {
    const contactRes = await fetch(`${LC_BASE}/contacts/`, {
      method: 'POST',
      headers: lcHeaders(apiKey),
      body: JSON.stringify({
        locationId,
        firstName,
        lastName,
        email,
        phone: params.leadPhone || undefined,
        source: params.platform ? `DMsetter ${params.platform}` : 'DMsetter DM',
        tags: ['dmsetter', 'auto-booked']
      })
    });

    if (contactRes.ok) {
      const contactData = (await contactRes.json()) as any;
      contactId = contactData?.contact?.id || contactData?.id;
    } else {
      contactErrStatus = contactRes.status;
      contactErrText = await contactRes.text().catch(() => '');
      console.error(
        `[calendar-adapter] LC contact create ${contactRes.status}:`,
        contactErrText
      );

      // Try to parse meta.contactId from the duplicate-error body first
      try {
        const errBody = JSON.parse(contactErrText) as any;
        const dupId =
          errBody?.meta?.contactId ||
          errBody?.meta?.contact?.id ||
          errBody?.contactId;
        if (dupId) {
          contactId = dupId;
          console.log(
            `[calendar-adapter] LC duplicate contact resolved from error meta: ${dupId}`
          );
        }
      } catch {
        // body wasn't JSON — fall through to the search-by-duplicate path
      }

      // Defensive fallback: hit the actual v2 search endpoint if meta didn't
      // give us an id. This is the correct LC v2 endpoint
      // (the old /contacts/lookup path is broken — see comment above).
      if (!contactId) {
        try {
          const searchRes = await fetch(
            `${LC_BASE}/contacts/search/duplicate?locationId=${encodeURIComponent(
              locationId
            )}&email=${encodeURIComponent(email)}`,
            { headers: lcHeaders(apiKey) }
          );
          if (searchRes.ok) {
            const searchData = (await searchRes.json()) as any;
            contactId =
              searchData?.contact?.id ||
              searchData?.contacts?.[0]?.id ||
              undefined;
            if (contactId) {
              console.log(
                `[calendar-adapter] LC duplicate contact resolved via /contacts/search/duplicate: ${contactId}`
              );
            }
          }
        } catch (searchErr) {
          console.error(
            '[calendar-adapter] LC search/duplicate fallback failed:',
            searchErr
          );
        }
      }
    }
  } catch (err) {
    console.error('[calendar-adapter] LC contact create threw:', err);
    contactErrText = err instanceof Error ? err.message : String(err);
  }

  if (!contactId) {
    return {
      success: false,
      provider: 'leadconnector',
      error: `LC contact create${contactErrStatus ? ` (${contactErrStatus})` : ''}: ${(
        contactErrText || 'unknown error'
      ).slice(0, 300)}`
    };
  }

  // 2. Create appointment
  try {
    const apptRes = await fetch(`${LC_BASE}/calendars/events/appointments`, {
      method: 'POST',
      headers: lcHeaders(apiKey),
      body: JSON.stringify({
        calendarId,
        locationId,
        contactId,
        startTime: params.slotStart,
        endTime:
          params.slotEnd ||
          new Date(
            new Date(params.slotStart).getTime() + 30 * 60_000
          ).toISOString(),
        title: `Call with ${params.leadName}`,
        appointmentStatus: 'confirmed',
        notes: params.notes,
        ignoreDateRange: false,
        toNotify: true
      })
    });

    if (!apptRes.ok) {
      const errText = await apptRes.text().catch(() => '');
      return {
        success: false,
        provider: 'leadconnector',
        contactId,
        error: `LC appointment create ${apptRes.status}: ${errText}`
      };
    }

    const apptData = (await apptRes.json()) as any;
    const appointmentId =
      apptData?.id ||
      apptData?.appointment?.id ||
      apptData?.event?.id ||
      undefined;
    const meetingUrl =
      apptData?.address || apptData?.meetingUrl || apptData?.location || '';

    return {
      success: true,
      provider: 'leadconnector',
      contactId,
      appointmentId,
      meetingUrl,
      startTime: params.slotStart
    };
  } catch (err) {
    return {
      success: false,
      provider: 'leadconnector',
      contactId,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// ---------------------------------------------------------------------------
// Calendly — fallback (simplified; Calendly's REST availability is complex)
// ---------------------------------------------------------------------------

async function getCalendlyAvailability(
  apiKey: string,
  _dateRange?: { start: string; end: string }
): Promise<TimeSlot[]> {
  try {
    const res = await fetch(
      'https://api.calendly.com/user_availability_schedules',
      {
        headers: { Authorization: `Bearer ${apiKey}` }
      }
    );
    if (!res.ok) return [];
    // Calendly's real availability requires walking availability rules and
    // subtracting busy times — not implemented here. Tenants using Calendly
    // should drop the scheduling link instead of relying on slot proposals.
    return [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cal.com — fallback
// ---------------------------------------------------------------------------

async function getCalcomAvailability(
  apiKey: string,
  _dateRange?: { start: string; end: string }
): Promise<TimeSlot[]> {
  try {
    const res = await fetch(
      'https://api.cal.com/v1/availability?apiKey=' + apiKey
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.slots || []).map((s: any) => ({
      start: s.start,
      end: s.end
    }));
  } catch {
    return [];
  }
}

async function bookCalcomAppointment(
  apiKey: string,
  params: BookingParams
): Promise<BookingResult> {
  try {
    const res = await fetch(
      'https://api.cal.com/v1/bookings?apiKey=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: params.leadName,
          email: params.leadEmail || '',
          start: params.slotStart,
          notes: params.notes || ''
        })
      }
    );
    if (!res.ok)
      return { success: false, provider: 'calcom', error: 'Booking failed' };
    const data = await res.json();
    return {
      success: true,
      provider: 'calcom',
      bookingId: data.id,
      bookingUrl: data.url
    };
  } catch (err) {
    return { success: false, provider: 'calcom', error: String(err) };
  }
}
