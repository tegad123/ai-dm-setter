// ---------------------------------------------------------------------------
// Google Calendar provider for the unified calendar adapter.
//
// - getGoogleCalendarAvailability(): FreeBusy query → free 30-min slots within
//   business hours (timezone-aware), excluding busy intervals.
// - bookGoogleCalendarAppointment(): Events.insert with a Google Meet link.
// - Auto-refresh: the OAuth2 client refreshes the 1-hour access token from the
//   stored refresh_token and persists the new token back to the credential.
//
// Credentials (IntegrationCredential provider=GOOGLE_CALENDAR) hold:
//   { accessToken, refreshToken, calendarId? }  (calendarId defaults to 'primary')
// ---------------------------------------------------------------------------

import { google } from 'googleapis';
import { randomUUID } from 'crypto';
import prisma from '@/lib/prisma';
import { setCredentials } from '@/lib/credential-store';
import type {
  TimeSlot,
  BookingParams,
  BookingResult
} from '@/lib/calendar-adapter';

/**
 * Detect Google's `invalid_grant` — what we get when Google has REVOKED the
 * refresh token itself (vs. an expired access token, which the SDK refreshes
 * silently). Common causes:
 *   - OAuth app in "Testing" publishing status (refresh tokens expire after
 *     7 days regardless of activity)
 *   - User revoked access in their Google account
 *   - Refresh token unused for 6+ months
 *   - Password change
 *
 * The SDK surfaces this in different shapes depending on the call site, so
 * we duck-type on a few of them.
 */
function isInvalidGrantError(err: unknown): boolean {
  const e = (err ?? {}) as {
    message?: string;
    code?: string | number;
    response?: { data?: { error?: string } };
    error?: string;
  };
  const msg = String(e.message ?? '').toLowerCase();
  if (msg.includes('invalid_grant')) return true;
  if (e.error === 'invalid_grant') return true;
  if (e.response?.data?.error === 'invalid_grant') return true;
  return false;
}

/**
 * When Google has revoked the refresh token, the integration is dead until
 * the operator re-consents. Mark it inactive so the calendar selector hides
 * Google from booking, and create a SYSTEM notification so the operator
 * actually finds out (instead of every future booking silently failing).
 */
async function markGoogleIntegrationInvalid(
  accountId: string,
  reason: string
): Promise<void> {
  try {
    await prisma.integrationCredential.updateMany({
      where: { accountId, provider: 'GOOGLE_CALENDAR' },
      data: { isActive: false }
    });
    await prisma.notification.create({
      data: {
        accountId,
        type: 'SYSTEM',
        title: 'Google Calendar disconnected',
        body: `Google revoked the calendar access token (${reason}). Reconnect from Settings → Integrations so the AI can book calls again. This usually happens when the OAuth app is in "Testing" mode (7-day token expiry) — publishing the consent screen prevents it.`
      }
    });
    console.warn(
      `[google-calendar] Marked GOOGLE_CALENDAR inactive for account=${accountId} (reason=${reason}). Operator notified.`
    );
  } catch (e) {
    console.error(
      '[google-calendar] failed to mark integration invalid (non-fatal):',
      e
    );
  }
}

export interface GoogleCalendarCreds {
  accessToken?: string;
  refreshToken?: string;
  calendarId?: string;
}

const SLOT_MINUTES = 30;
const BUSINESS_START_HOUR = 9; // 9am local
const BUSINESS_END_HOUR = 17; // 5pm local
const MAX_SLOTS = 40;
const DEFAULT_WINDOW_DAYS = 14;

/**
 * Build an OAuth2 client seeded with the stored tokens. The googleapis client
 * auto-refreshes the access token when it's expired (using refresh_token +
 * the app's client id/secret). We listen for the refreshed token and persist
 * it so subsequent requests skip the refresh round-trip.
 */
function buildOAuthClient(accountId: string, creds: GoogleCalendarCreds) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    process.env.GOOGLE_OAUTH_REDIRECT_URI
  );
  client.setCredentials({
    access_token: creds.accessToken,
    refresh_token: creds.refreshToken
  });
  client.on('tokens', (tokens) => {
    if (!tokens.access_token) return;
    setCredentials(accountId, 'GOOGLE_CALENDAR', {
      accessToken: tokens.access_token,
      // Google only returns a refresh_token on the first consent; keep the
      // existing one unless a new one is issued.
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {})
    }).catch((err) =>
      console.error('[google-calendar] failed to persist refreshed token:', err)
    );
  });
  return client;
}

/** Hour-of-day (0-23) for a given instant in a specific IANA timezone. */
function hourInTimezone(date: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone
  }).format(date);
  return parseInt(h, 10) % 24;
}

/** Day-of-week (0=Sun..6=Sat) for a given instant in a specific timezone. */
function weekdayInTimezone(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone
  }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

export async function getGoogleCalendarAvailability(
  accountId: string,
  creds: GoogleCalendarCreds,
  range?: { start: string; end: string },
  timezone: string = 'UTC'
): Promise<TimeSlot[]> {
  try {
    return await fetchGoogleAvailability(accountId, creds, range, timezone);
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markGoogleIntegrationInvalid(accountId, 'invalid_grant');
    }
    throw err;
  }
}

async function fetchGoogleAvailability(
  accountId: string,
  creds: GoogleCalendarCreds,
  range?: { start: string; end: string },
  timezone: string = 'UTC'
): Promise<TimeSlot[]> {
  const auth = buildOAuthClient(accountId, creds);
  const cal = google.calendar({ version: 'v3', auth });
  const calendarId = creds.calendarId || 'primary';

  const now = Date.now();
  const timeMin = range?.start ? new Date(range.start) : new Date(now);
  const timeMax = range?.end
    ? new Date(range.end)
    : new Date(now + DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const fb = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      timeZone: timezone,
      items: [{ id: calendarId }]
    }
  });

  const busy = (fb.data.calendars?.[calendarId]?.busy ?? [])
    .filter((b) => b.start && b.end)
    .map((b) => ({
      start: new Date(b.start as string).getTime(),
      end: new Date(b.end as string).getTime()
    }));

  // Walk the window in 30-min steps; keep slots that are in the future, fall
  // on a weekday during business hours (in the lead's timezone), and don't
  // overlap any busy interval.
  const slots: TimeSlot[] = [];
  const slotMs = SLOT_MINUTES * 60 * 1000;
  let cursor = Math.ceil(timeMin.getTime() / slotMs) * slotMs;
  const endMs = timeMax.getTime();

  while (cursor < endMs && slots.length < MAX_SLOTS) {
    const slotStart = cursor;
    const slotEnd = cursor + slotMs;
    cursor += slotMs;

    if (slotStart <= now) continue;
    const d = new Date(slotStart);
    const wd = weekdayInTimezone(d, timezone);
    if (wd === 0 || wd === 6) continue; // skip weekends
    const hour = hourInTimezone(d, timezone);
    if (hour < BUSINESS_START_HOUR || hour >= BUSINESS_END_HOUR) continue;
    const overlaps = busy.some((b) => slotStart < b.end && slotEnd > b.start);
    if (overlaps) continue;

    slots.push({
      start: new Date(slotStart).toISOString(),
      end: new Date(slotEnd).toISOString()
    });
  }

  return slots;
}

export async function bookGoogleCalendarAppointment(
  accountId: string,
  creds: GoogleCalendarCreds,
  params: BookingParams
): Promise<BookingResult> {
  try {
    const auth = buildOAuthClient(accountId, creds);
    const cal = google.calendar({ version: 'v3', auth });
    const calendarId = creds.calendarId || 'primary';

    const startIso = params.slotStart;
    const endIso =
      params.slotEnd ||
      new Date(
        new Date(params.slotStart).getTime() + SLOT_MINUTES * 60 * 1000
      ).toISOString();
    const tz = params.timezone || 'UTC';

    const event = await cal.events.insert({
      calendarId,
      conferenceDataVersion: 1,
      sendUpdates: 'all',
      requestBody: {
        summary: `Call with ${params.leadName}`,
        description:
          params.notes ||
          `Booked via Convlo${params.platform ? ` (${params.platform})` : ''}. Lead: ${params.leadHandle || params.leadName}`,
        start: { dateTime: startIso, timeZone: tz },
        end: { dateTime: endIso, timeZone: tz },
        attendees: params.leadEmail
          ? [{ email: params.leadEmail, displayName: params.leadName }]
          : undefined,
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' }
          }
        }
      }
    });

    return {
      success: true,
      provider: 'google',
      appointmentId: event.data.id ?? undefined,
      meetingUrl: event.data.hangoutLink ?? undefined,
      confirmationUrl: event.data.htmlLink ?? undefined,
      startTime: startIso
    };
  } catch (err) {
    if (isInvalidGrantError(err)) {
      await markGoogleIntegrationInvalid(accountId, 'invalid_grant');
      return {
        success: false,
        provider: 'google',
        error:
          'Google Calendar disconnected — refresh token revoked. Reconnect from Settings → Integrations.'
      };
    }
    return {
      success: false,
      provider: 'google',
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
