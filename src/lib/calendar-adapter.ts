import { getCredentials } from '@/lib/credential-store';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Diagnostic logging — temporary verbose logging for booking diagnosis.
// Remove or reduce after the bug is found.
// ---------------------------------------------------------------------------

function redactHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const safe = { ...headers };
  if (safe.Authorization) safe.Authorization = 'Bearer [REDACTED]';
  return safe;
}

function calLog(
  phase: string,
  data: Record<string, unknown>,
  requestId?: string
) {
  console.log(
    `[CALENDAR_ADAPTER] ${phase}`,
    JSON.stringify({ requestId, ts: new Date().toISOString(), ...data })
  );
}

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
  const reqId = randomUUID().slice(0, 8);
  calLog(
    'UnifiedAvailability.start',
    { accountId, startDate, endDate, timezone },
    reqId
  );

  const range =
    startDate && endDate ? { start: startDate, end: endDate } : undefined;

  // 1. LeadConnector first
  const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
  calLog(
    'UnifiedAvailability.credsCheck',
    {
      hasApiKey: !!lcCreds?.apiKey,
      hasCalendarId: !!lcCreds?.calendarId,
      hasLocationId: !!lcCreds?.locationId
    },
    reqId
  );

  if (lcCreds?.apiKey && lcCreds?.calendarId) {
    try {
      const slots = await getLeadConnectorAvailability(
        lcCreds.apiKey as string,
        lcCreds.calendarId as string,
        range,
        timezone,
        reqId
      );
      calLog(
        'UnifiedAvailability.lcSuccess',
        { slotCount: slots.length },
        reqId
      );
      return { provider: 'leadconnector', slots, timezone };
    } catch (err) {
      calLog('UnifiedAvailability.lcFailed', { error: String(err) }, reqId);
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
  const reqId = randomUUID().slice(0, 8);
  calLog(
    'UnifiedBooking.start',
    {
      accountId,
      leadName: params.leadName,
      leadHandle: params.leadHandle,
      slotStart: params.slotStart,
      slotEnd: params.slotEnd,
      timezone: params.timezone
    },
    reqId
  );

  // 1. LeadConnector first
  const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
  calLog(
    'UnifiedBooking.credsCheck',
    {
      hasApiKey: !!lcCreds?.apiKey,
      hasCalendarId: !!lcCreds?.calendarId,
      hasLocationId: !!lcCreds?.locationId
    },
    reqId
  );

  if (lcCreds?.apiKey && lcCreds?.calendarId && lcCreds?.locationId) {
    try {
      const result = await bookLeadConnectorAppointment(
        {
          apiKey: lcCreds.apiKey as string,
          calendarId: lcCreds.calendarId as string,
          locationId: lcCreds.locationId as string
        },
        params,
        reqId
      );
      calLog(
        'UnifiedBooking.lcResult',
        {
          success: result.success,
          appointmentId: result.appointmentId,
          contactId: result.contactId,
          error: result.error
        },
        reqId
      );
      return result;
    } catch (err) {
      calLog('UnifiedBooking.lcThrew', { error: String(err) }, reqId);
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
  timezone?: string,
  requestId?: string
): Promise<TimeSlot[]> {
  const reqId = requestId || randomUUID().slice(0, 8);
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

    calLog(
      'LC.Availability.request',
      {
        url,
        headers: redactHeaders(lcHeaders(apiKey)),
        queryParams: {
          startDate: startMs,
          endDate: endMs,
          timezone: timezone || null
        },
        dateRangeHuman: {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString()
        }
      },
      reqId
    );

    const res = await fetch(url, { headers: lcHeaders(apiKey) });
    const bodyText = await res.text();

    calLog(
      'LC.Availability.response',
      {
        status: res.status,
        statusText: res.statusText,
        body: bodyText.slice(0, 3000)
      },
      reqId
    );

    if (!res.ok) {
      return [];
    }

    const data = JSON.parse(bodyText) as Record<
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

    calLog(
      'LC.Availability.parsed',
      {
        totalDateKeys: Object.keys(data).filter((k) =>
          /^\d{4}-\d{2}-\d{2}$/.test(k)
        ).length,
        totalSlots: result.length,
        firstSlot: result[0] || null,
        lastSlot: result[result.length - 1] || null
      },
      reqId
    );

    return result;
  } catch (err) {
    calLog(
      'LC.Availability.error',
      { error: String(err), stack: (err as Error)?.stack?.slice(0, 500) },
      reqId
    );
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
  params: BookingParams,
  requestId?: string
): Promise<BookingResult> {
  const reqId = requestId || randomUUID().slice(0, 8);
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

  // ── Step 1: Create contact ──────────────────────────────────────
  const contactBody = {
    locationId,
    firstName,
    lastName,
    email,
    phone: params.leadPhone || undefined,
    source: params.platform ? `DMsetter ${params.platform}` : 'DMsetter DM',
    tags: ['dmsetter', 'auto-booked']
  };

  calLog(
    'LC.ContactCreate.request',
    {
      url: `${LC_BASE}/contacts/`,
      headers: redactHeaders(lcHeaders(apiKey)),
      body: contactBody
    },
    reqId
  );

  let contactId: string | undefined;
  let contactErrText: string | undefined;
  let contactErrStatus: number | undefined;
  try {
    const contactRes = await fetch(`${LC_BASE}/contacts/`, {
      method: 'POST',
      headers: lcHeaders(apiKey),
      body: JSON.stringify(contactBody)
    });

    const contactResText = await contactRes.text();

    calLog(
      'LC.ContactCreate.response',
      {
        status: contactRes.status,
        statusText: contactRes.statusText,
        body: contactResText.slice(0, 2000)
      },
      reqId
    );

    if (contactRes.ok) {
      const contactData = JSON.parse(contactResText) as any;
      contactId = contactData?.contact?.id || contactData?.id;
      calLog('LC.ContactCreate.success', { contactId }, reqId);
    } else {
      contactErrStatus = contactRes.status;
      contactErrText = contactResText;

      // Try to parse meta.contactId from the duplicate-error body first
      try {
        const errBody = JSON.parse(contactErrText) as any;
        const dupId =
          errBody?.meta?.contactId ||
          errBody?.meta?.contact?.id ||
          errBody?.contactId;
        if (dupId) {
          contactId = dupId;
          calLog(
            'LC.ContactCreate.duplicateResolved',
            { contactId, source: 'error_meta' },
            reqId
          );
        }
      } catch {
        // body wasn't JSON — fall through to the search-by-duplicate path
      }

      // Defensive fallback: hit the actual v2 search endpoint
      if (!contactId) {
        const searchUrl = `${LC_BASE}/contacts/search/duplicate?locationId=${encodeURIComponent(
          locationId
        )}&email=${encodeURIComponent(email)}`;

        calLog('LC.ContactSearch.request', { url: searchUrl }, reqId);

        try {
          const searchRes = await fetch(searchUrl, {
            headers: lcHeaders(apiKey)
          });
          const searchText = await searchRes.text();

          calLog(
            'LC.ContactSearch.response',
            {
              status: searchRes.status,
              body: searchText.slice(0, 2000)
            },
            reqId
          );

          if (searchRes.ok) {
            const searchData = JSON.parse(searchText) as any;
            contactId =
              searchData?.contact?.id ||
              searchData?.contacts?.[0]?.id ||
              undefined;
            if (contactId) {
              calLog('LC.ContactSearch.resolved', { contactId }, reqId);
            }
          }
        } catch (searchErr) {
          calLog('LC.ContactSearch.error', { error: String(searchErr) }, reqId);
        }
      }
    }
  } catch (err) {
    calLog('LC.ContactCreate.threw', { error: String(err) }, reqId);
    contactErrText = err instanceof Error ? err.message : String(err);
  }

  if (!contactId) {
    calLog(
      'LC.ContactCreate.failed',
      {
        errStatus: contactErrStatus,
        errText: (contactErrText || '').slice(0, 300)
      },
      reqId
    );
    return {
      success: false,
      provider: 'leadconnector',
      error: `LC contact create${contactErrStatus ? ` (${contactErrStatus})` : ''}: ${(
        contactErrText || 'unknown error'
      ).slice(0, 300)}`
    };
  }

  // ── Step 2: Create appointment ──────────────────────────────────
  const apptBody = {
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
  };

  calLog(
    'LC.AppointmentCreate.request',
    {
      url: `${LC_BASE}/calendars/events/appointments`,
      headers: redactHeaders(lcHeaders(apiKey)),
      body: apptBody
    },
    reqId
  );

  try {
    const apptRes = await fetch(`${LC_BASE}/calendars/events/appointments`, {
      method: 'POST',
      headers: lcHeaders(apiKey),
      body: JSON.stringify(apptBody)
    });

    const apptResText = await apptRes.text();

    calLog(
      'LC.AppointmentCreate.response',
      {
        status: apptRes.status,
        statusText: apptRes.statusText,
        body: apptResText.slice(0, 2000)
      },
      reqId
    );

    if (!apptRes.ok) {
      return {
        success: false,
        provider: 'leadconnector',
        contactId,
        error: `LC appointment create ${apptRes.status}: ${apptResText}`
      };
    }

    const apptData = JSON.parse(apptResText) as any;
    const appointmentId =
      apptData?.id ||
      apptData?.appointment?.id ||
      apptData?.event?.id ||
      undefined;
    const meetingUrl =
      apptData?.address || apptData?.meetingUrl || apptData?.location || '';

    calLog(
      'LC.AppointmentCreate.success',
      { appointmentId, meetingUrl },
      reqId
    );

    return {
      success: true,
      provider: 'leadconnector',
      contactId,
      appointmentId,
      meetingUrl,
      startTime: params.slotStart
    };
  } catch (err) {
    calLog('LC.AppointmentCreate.threw', { error: String(err) }, reqId);
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
