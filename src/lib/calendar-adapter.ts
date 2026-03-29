import { getCredentials } from '@/lib/credential-store';

export interface TimeSlot {
  start: string; // ISO 8601
  end: string;
}

export interface BookingResult {
  success: boolean;
  provider: string;
  appointmentId?: string;
  confirmationUrl?: string;
  meetingUrl?: string;
  startTime?: string;
  bookingId?: string;
  bookingUrl?: string;
  error?: string;
}

/**
 * Get unified availability across calendar providers (Calendly, Cal.com).
 */
export async function getUnifiedAvailability(
  accountId: string,
  startDate?: string,
  endDate?: string
): Promise<{ provider: string; slots: TimeSlot[] }> {
  const dateRange = startDate && endDate ? { start: startDate, end: endDate } : undefined;
  // Try Calendly first
  const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
  if (calendlyCreds?.apiKey) {
    const slots = await getCalendlyAvailability(calendlyCreds.apiKey as string, dateRange);
    return { provider: 'calendly', slots };
  }

  // Try Cal.com
  const calcomCreds = await getCredentials(accountId, 'CALCOM');
  if (calcomCreds?.apiKey) {
    const slots = await getCalcomAvailability(calcomCreds.apiKey as string, dateRange);
    return { provider: 'calcom', slots };
  }

  return { provider: 'none', slots: [] };
}

/**
 * Book a unified appointment across calendar providers.
 */
export async function bookUnifiedAppointment(
  accountId: string,
  params: {
    leadName: string;
    leadHandle?: string;
    leadEmail?: string;
    platform?: string;
    startTime?: string;
    slotStart?: string;
    slotEnd?: string;
    notes?: string;
  }
): Promise<BookingResult> {
  const startTime = params.startTime || params.slotStart || '';
  const calendlyCreds = await getCredentials(accountId, 'CALENDLY');
  if (calendlyCreds?.apiKey) {
    // Calendly bookings are typically done via the invite link
    return {
      success: true,
      provider: 'calendly',
      confirmationUrl: (calendlyCreds as any).schedulingUrl || '',
      bookingUrl: (calendlyCreds as any).schedulingUrl || '',
      startTime
    };
  }

  const calcomCreds = await getCredentials(accountId, 'CALCOM');
  if (calcomCreds?.apiKey) {
    const result = await bookCalcomAppointment(calcomCreds.apiKey as string, { ...params, startTime });
    return { ...result, provider: 'calcom', startTime };
  }

  return { success: false, provider: 'none', error: 'No calendar provider configured' };
}

// Calendly helpers
async function getCalendlyAvailability(
  apiKey: string,
  _dateRange?: { start: string; end: string }
): Promise<TimeSlot[]> {
  try {
    const res = await fetch('https://api.calendly.com/user_availability_schedules', {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return [];
    // Simplified — real implementation would parse availability rules
    return [];
  } catch {
    return [];
  }
}

// Cal.com helpers
async function getCalcomAvailability(
  apiKey: string,
  _dateRange?: { start: string; end: string }
): Promise<TimeSlot[]> {
  try {
    const res = await fetch('https://api.cal.com/v1/availability?apiKey=' + apiKey);
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
  params: { leadName: string; leadEmail?: string; startTime: string; notes?: string }
): Promise<BookingResult> {
  try {
    const res = await fetch('https://api.cal.com/v1/bookings?apiKey=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.leadName,
        email: params.leadEmail || '',
        start: params.startTime,
        notes: params.notes || ''
      })
    });
    if (!res.ok) return { success: false, provider: 'calcom', error: 'Booking failed' };
    const data = await res.json();
    return { success: true, provider: 'calcom', bookingId: data.id, bookingUrl: data.url };
  } catch (err) {
    return { success: false, provider: 'calcom', error: String(err) };
  }
}
