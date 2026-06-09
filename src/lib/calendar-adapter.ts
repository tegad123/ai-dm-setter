import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { randomUUID } from 'crypto';
import {
  getGoogleCalendarAvailability,
  bookGoogleCalendarAppointment
} from '@/lib/google-calendar';

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
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'google' | 'none';
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
  provider: 'leadconnector' | 'calendly' | 'calcom' | 'google' | 'none';
  appointmentId?: string;
  contactId?: string;
  confirmationUrl?: string;
  meetingUrl?: string;
  startTime?: string;
  bookingId?: string;
  bookingUrl?: string;
  error?: string;
  // True when the provider cannot confirm a booking server-side and the lead
  // must self-book via a scheduling link (Calendly). The caller MUST NOT treat
  // this as a confirmed booking — drop the link, do not mark the lead BOOKED,
  // and do not send a "you're locked in" message.
  requiresLeadAction?: boolean;
}

// IntegrationProvider keys for the four calendar providers, in fallback
// precedence order (used when no explicit active provider is selected).
type CalProviderKey =
  | 'LEADCONNECTOR'
  | 'CALENDLY'
  | 'CALCOM'
  | 'GOOGLE_CALENDAR';

const CALENDAR_PRECEDENCE: CalProviderKey[] = [
  'LEADCONNECTOR',
  'CALENDLY',
  'CALCOM',
  'GOOGLE_CALENDAR'
];

/**
 * Resolve the ordered list of calendar providers to try for an account.
 *
 * If the account has explicitly chosen an active provider, return ONLY that
 * one — an explicit choice should never silently fall through to a different
 * calendar. If no choice is set, return the full precedence list so existing
 * accounts keep working (first configured provider wins).
 */
async function resolveProviderOrder(
  accountId: string
): Promise<CalProviderKey[]> {
  try {
    const acct = await prisma.account.findUnique({
      where: { id: accountId },
      select: { activeCalendarProvider: true }
    });
    const active = acct?.activeCalendarProvider as CalProviderKey | null;
    if (active && CALENDAR_PRECEDENCE.includes(active)) {
      return [active];
    }
  } catch {
    // fall through to precedence on any read error
  }
  return CALENDAR_PRECEDENCE;
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
 *   1. LeadConnector / HighLevel (preferred for Convlo tenants)
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

  const order = await resolveProviderOrder(accountId);
  calLog('UnifiedAvailability.order', { order }, reqId);

  for (const key of order) {
    if (key === 'LEADCONNECTOR') {
      const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
      calLog(
        'UnifiedAvailability.lcCredsCheck',
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
          // Resolve the calendar/business tz from the LC location so the
          // dashboard renders in the right zone (the slots/free-slots response
          // carries no IANA tz). Prefer an explicitly-requested tz if given.
          const resolvedTz =
            timezone ||
            (lcCreds.locationId
              ? ((await getLeadConnectorTimezone(
                  lcCreds.apiKey as string,
                  lcCreds.locationId as string,
                  reqId
                )) ?? undefined)
              : undefined);
          calLog(
            'UnifiedAvailability.lcSuccess',
            { slotCount: slots.length, resolvedTz },
            reqId
          );
          return { provider: 'leadconnector', slots, timezone: resolvedTz };
        } catch (err) {
          calLog('UnifiedAvailability.lcFailed', { error: String(err) }, reqId);
        }
      }
    } else if (key === 'CALENDLY') {
      const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
      if (calendlyCreds?.apiKey) {
        const slots = await getCalendlyAvailability(
          calendlyCreds.apiKey as string,
          range
        );
        return { provider: 'calendly', slots };
      }
    } else if (key === 'CALCOM') {
      const calcomCreds = await getCredentials(accountId, 'CALCOM');
      if (calcomCreds?.apiKey) {
        const slots = await getCalcomAvailability(
          calcomCreds.apiKey as string,
          range,
          calcomCreds.eventTypeId ? Number(calcomCreds.eventTypeId) : undefined,
          timezone,
          reqId
        );
        return { provider: 'calcom', slots, timezone };
      }
    } else if (key === 'GOOGLE_CALENDAR') {
      const googleCreds = await getCredentials(accountId, 'GOOGLE_CALENDAR');
      if (googleCreds?.refreshToken || googleCreds?.accessToken) {
        try {
          const slots = await getGoogleCalendarAvailability(
            accountId,
            googleCreds as {
              accessToken?: string;
              refreshToken?: string;
              calendarId?: string;
            },
            range,
            timezone
          );
          calLog(
            'UnifiedAvailability.googleSuccess',
            { slotCount: slots.length },
            reqId
          );
          return { provider: 'google', slots, timezone };
        } catch (err) {
          calLog(
            'UnifiedAvailability.googleFailed',
            { error: String(err) },
            reqId
          );
        }
      }
    }
  }

  return { provider: 'none', slots: [] };
}

/**
 * Book a call via the first configured calendar provider.
 * LeadConnector takes priority — it is the canonical Convlo integration.
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

  const order = await resolveProviderOrder(accountId);
  calLog('UnifiedBooking.order', { order }, reqId);

  for (const key of order) {
    if (key === 'LEADCONNECTOR') {
      const lcCreds = await getCredentials(accountId, 'LEADCONNECTOR');
      calLog(
        'UnifiedBooking.lcCredsCheck',
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
    } else if (key === 'CALENDLY') {
      // Calendly cannot create a confirmed booking server-side. We generate a
      // real single-use scheduling link and return it with requiresLeadAction
      // so the caller drops the link and does NOT fake-confirm.
      const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
      if (calendlyCreds?.apiKey) {
        const link = await getCalendlySchedulingLink(
          accountId,
          calendlyCreds.apiKey as string,
          reqId
        );
        calLog('UnifiedBooking.calendlyLink', { hasLink: !!link }, reqId);
        return {
          success: !!link,
          provider: 'calendly',
          confirmationUrl: link || '',
          bookingUrl: link || '',
          startTime: params.slotStart,
          requiresLeadAction: true,
          error: link
            ? undefined
            : 'Could not generate Calendly scheduling link'
        };
      }
    } else if (key === 'CALCOM') {
      const calcomCreds = await getCredentials(accountId, 'CALCOM');
      if (calcomCreds?.apiKey) {
        const result = await bookCalcomAppointment(
          calcomCreds.apiKey as string,
          params,
          calcomCreds.eventTypeId ? Number(calcomCreds.eventTypeId) : undefined,
          reqId
        );
        return { ...result, startTime: params.slotStart };
      }
    } else if (key === 'GOOGLE_CALENDAR') {
      const googleCreds = await getCredentials(accountId, 'GOOGLE_CALENDAR');
      if (googleCreds?.refreshToken || googleCreds?.accessToken) {
        const result = await bookGoogleCalendarAppointment(
          accountId,
          googleCreds as {
            accessToken?: string;
            refreshToken?: string;
            calendarId?: string;
          },
          params
        );
        calLog(
          'UnifiedBooking.googleResult',
          {
            success: result.success,
            appointmentId: result.appointmentId,
            error: result.error
          },
          reqId
        );
        return result;
      }
    }
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

// Cache the resolved location timezone (it's stable) to avoid an extra API call
// on every availability fetch. Keyed by locationId.
const lcTimezoneCache = new Map<string, string>();

/**
 * Resolve a LeadConnector location's IANA timezone (e.g. "America/Chicago").
 * GHL stores the calendar/business tz on the LOCATION, not the calendar or the
 * free-slots response — so the dashboard grid has no authoritative tz without
 * this. Best-effort: returns null on any failure (caller falls back).
 *
 * GET /locations/{locationId} → { location: { timezone } }
 */
export async function getLeadConnectorTimezone(
  apiKey: string,
  locationId: string,
  requestId?: string
): Promise<string | null> {
  if (!locationId) return null;
  const cached = lcTimezoneCache.get(locationId);
  if (cached) return cached;
  const reqId = requestId || randomUUID().slice(0, 8);
  try {
    const res = await fetch(
      `${LC_BASE}/locations/${encodeURIComponent(locationId)}`,
      { headers: lcHeaders(apiKey) }
    );
    if (!res.ok) {
      calLog('LC.Timezone.failed', { status: res.status }, reqId);
      return null;
    }
    const body = (await res.json()) as {
      location?: { timezone?: string | null };
      timezone?: string | null;
    };
    const tz = body.location?.timezone ?? body.timezone ?? null;
    if (tz) lcTimezoneCache.set(locationId, tz);
    calLog('LC.Timezone.resolved', { tz }, reqId);
    return tz;
  } catch (err) {
    calLog('LC.Timezone.threw', { error: String(err) }, reqId);
    return null;
  }
}

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
    source: params.platform ? `Convlo ${params.platform}` : 'Convlo DM',
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
// Calendly — link-mode provider (lead self-books via a scheduling link)
// ---------------------------------------------------------------------------

/**
 * Generate a real single-use Calendly scheduling link the AI can drop in chat.
 *
 * Calendly's public API cannot create a confirmed booking on the host's behalf
 * — the invitee must pick a time and confirm. So instead of faking a booking,
 * we mint a single-use scheduling link scoped to the account's event type:
 *
 *   POST /scheduling_links { max_event_count: 1, owner, owner_type: "EventType" }
 *     → resource.booking_url
 *
 * The owner (event type URI) is read from the stored integration metadata; if
 * it isn't there we look it up from the user's first active event type. Falls
 * back to the plain scheduling URL on the user record if link minting fails.
 */
async function getCalendlySchedulingLink(
  accountId: string,
  apiKey: string,
  requestId?: string
): Promise<string | null> {
  const reqId = requestId || randomUUID().slice(0, 8);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  try {
    // 1. Try the stored event type URI from integration metadata
    let eventTypeUri: string | undefined;
    let userSchedulingUrl: string | undefined;
    try {
      const row = await prisma.integrationCredential.findUnique({
        where: {
          accountId_provider: { accountId, provider: 'CALENDLY' }
        },
        select: { metadata: true }
      });
      const meta = (row?.metadata as Record<string, unknown>) || {};
      if (typeof meta.eventTypeUri === 'string')
        eventTypeUri = meta.eventTypeUri;
      if (typeof meta.schedulingUrl === 'string')
        userSchedulingUrl = meta.schedulingUrl;
    } catch {
      // metadata read is best-effort
    }

    // 2. If no event type stored, look one up from the API
    if (!eventTypeUri) {
      const meRes = await fetch('https://api.calendly.com/users/me', {
        headers
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        const userUri = meData?.resource?.uri as string | undefined;
        userSchedulingUrl =
          userSchedulingUrl ||
          (meData?.resource?.scheduling_url as string | undefined);
        if (userUri) {
          const etRes = await fetch(
            `https://api.calendly.com/event_types?user=${encodeURIComponent(
              userUri
            )}&active=true`,
            { headers }
          );
          if (etRes.ok) {
            const etData = await etRes.json();
            eventTypeUri = etData?.collection?.[0]?.uri;
          }
        }
      }
    }

    // 3. Mint a single-use scheduling link for that event type
    if (eventTypeUri) {
      const linkRes = await fetch('https://api.calendly.com/scheduling_links', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          max_event_count: 1,
          owner: eventTypeUri,
          owner_type: 'EventType'
        })
      });
      if (linkRes.ok) {
        const linkData = await linkRes.json();
        const bookingUrl = linkData?.resource?.booking_url as
          | string
          | undefined;
        if (bookingUrl) {
          calLog('Calendly.schedulingLink.minted', { eventTypeUri }, reqId);
          return bookingUrl;
        }
      } else {
        calLog(
          'Calendly.schedulingLink.failed',
          {
            status: linkRes.status,
            body: (await linkRes.text()).slice(0, 500)
          },
          reqId
        );
      }
    }

    // 4. Fall back to the user's public scheduling URL
    return userSchedulingUrl || null;
  } catch (err) {
    calLog('Calendly.schedulingLink.threw', { error: String(err) }, reqId);
    return null;
  }
}

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
// Cal.com — v2 API (v1 was decommissioned 2026; returns HTTP 410)
//
// Auth: Bearer <cal_live_…>. Endpoints are date-versioned via the
// `cal-api-version` header (different version per endpoint family). Bookings
// only need a start + eventTypeId; Cal.com computes the end from the event
// type's configured length.
// ---------------------------------------------------------------------------

const CALCOM_V2_BASE = 'https://api.cal.com/v2';
const CALCOM_VER_EVENT_TYPES = '2024-06-14';
const CALCOM_VER_SLOTS = '2024-09-04';
const CALCOM_VER_BOOKINGS = '2024-08-13';
const SLOT_MINUTES = 30; // default slot length when an event type omits it
const DEFAULT_WINDOW_DAYS = 14; // default availability look-ahead

function calcomHeaders(
  apiKey: string,
  version: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'cal-api-version': version
  };
}

/**
 * Resolve which Cal.com event type to use. Honors a stored preferredId
 * (from integration metadata); otherwise falls back to the account's first
 * event type. Returns the id + configured length so availability can compute
 * slot end times.
 */
async function getCalcomEventType(
  apiKey: string,
  preferredId?: number,
  requestId?: string
): Promise<{ id: number; lengthMinutes: number } | null> {
  try {
    const res = await fetch(`${CALCOM_V2_BASE}/event-types`, {
      headers: calcomHeaders(apiKey, CALCOM_VER_EVENT_TYPES)
    });
    if (!res.ok) {
      calLog(
        'Calcom.eventTypes.failed',
        { status: res.status, body: (await res.text()).slice(0, 300) },
        requestId
      );
      return null;
    }
    const data = await res.json();
    const list: any[] = Array.isArray(data?.data) ? data.data : [];
    if (list.length === 0) return null;
    const chosen =
      (preferredId && list.find((e) => e.id === preferredId)) || list[0];
    return {
      id: chosen.id,
      lengthMinutes: chosen.lengthInMinutes ?? chosen.length ?? SLOT_MINUTES
    };
  } catch (err) {
    calLog('Calcom.eventTypes.threw', { error: String(err) }, requestId);
    return null;
  }
}

async function getCalcomAvailability(
  apiKey: string,
  dateRange?: { start: string; end: string },
  eventTypeId?: number,
  timeZone: string = 'UTC',
  requestId?: string
): Promise<TimeSlot[]> {
  try {
    const et = await getCalcomEventType(apiKey, eventTypeId, requestId);
    if (!et) return [];

    const now = new Date();
    const startDay = (dateRange?.start ? new Date(dateRange.start) : now)
      .toISOString()
      .slice(0, 10);
    const endDay = (
      dateRange?.end
        ? new Date(dateRange.end)
        : new Date(now.getTime() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    )
      .toISOString()
      .slice(0, 10);

    const qs = new URLSearchParams({
      eventTypeId: String(et.id),
      start: startDay,
      end: endDay,
      timeZone
    });
    const res = await fetch(`${CALCOM_V2_BASE}/slots?${qs.toString()}`, {
      headers: calcomHeaders(apiKey, CALCOM_VER_SLOTS)
    });
    if (!res.ok) {
      calLog(
        'Calcom.slots.failed',
        { status: res.status, body: (await res.text()).slice(0, 300) },
        requestId
      );
      return [];
    }
    const data = await res.json();
    // Shape: { data: { "YYYY-MM-DD": [{ start: ISO }, ...], ... } }
    const byDay = (data?.data ?? {}) as Record<string, { start: string }[]>;
    const slots: TimeSlot[] = [];
    for (const day of Object.values(byDay)) {
      if (!Array.isArray(day)) continue;
      for (const s of day) {
        const start = new Date(s.start);
        if (isNaN(start.getTime())) continue;
        slots.push({
          start: start.toISOString(),
          end: new Date(
            start.getTime() + et.lengthMinutes * 60_000
          ).toISOString()
        });
      }
    }
    calLog('Calcom.slots.parsed', { count: slots.length }, requestId);
    return slots;
  } catch (err) {
    calLog('Calcom.availability.threw', { error: String(err) }, requestId);
    return [];
  }
}

async function bookCalcomAppointment(
  apiKey: string,
  params: BookingParams,
  eventTypeId?: number,
  requestId?: string
): Promise<BookingResult> {
  try {
    const et = await getCalcomEventType(apiKey, eventTypeId, requestId);
    if (!et) {
      return {
        success: false,
        provider: 'calcom',
        error: 'No Cal.com event type available to book'
      };
    }

    const safeHandle = (params.leadHandle || 'lead').replace(
      /[^a-zA-Z0-9._-]/g,
      ''
    );
    const email =
      params.leadEmail ||
      `${safeHandle || 'lead'}+${(
        params.platform || 'dm'
      ).toLowerCase()}@dmsetter-leads.com`;

    const body = {
      start: new Date(params.slotStart).toISOString(),
      eventTypeId: et.id,
      attendee: {
        name: params.leadName || 'Lead',
        email,
        timeZone: params.timezone || 'UTC',
        language: 'en'
      },
      ...(params.notes
        ? { bookingFieldsResponses: { notes: params.notes } }
        : {})
    };

    const res = await fetch(`${CALCOM_V2_BASE}/bookings`, {
      method: 'POST',
      headers: calcomHeaders(apiKey, CALCOM_VER_BOOKINGS),
      body: JSON.stringify(body)
    });
    const text = await res.text();
    calLog(
      'Calcom.booking.response',
      { status: res.status, body: text.slice(0, 600) },
      requestId
    );
    if (!res.ok) {
      return {
        success: false,
        provider: 'calcom',
        error: `Cal.com booking ${res.status}: ${text.slice(0, 200)}`
      };
    }
    const data = JSON.parse(text);
    if (data?.status && data.status !== 'success') {
      return {
        success: false,
        provider: 'calcom',
        error: `Cal.com booking failed: ${text.slice(0, 200)}`
      };
    }
    const b = data?.data ?? data;
    const meetingUrl =
      b?.meetingUrl ||
      b?.location ||
      (typeof b?.location === 'object' ? b?.location?.url : '') ||
      '';
    return {
      success: true,
      provider: 'calcom',
      appointmentId: b?.id ? String(b.id) : undefined,
      bookingId: b?.uid || (b?.id ? String(b.id) : undefined),
      meetingUrl,
      startTime: params.slotStart
    };
  } catch (err) {
    return { success: false, provider: 'calcom', error: String(err) };
  }
}
