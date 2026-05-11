import { callHaikuText } from '@/lib/haiku-text';

export interface BookingInfoFields {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  timezone: string | null;
  dayAndTime: string | null;
}

export const BOOKING_INFO_FIELD_NAMES = [
  'fullName',
  'email',
  'phone',
  'timezone',
  'dayAndTime'
] as const;

const EMPTY_BOOKING_INFO: BookingInfoFields = {
  fullName: null,
  email: null,
  phone: null,
  timezone: null,
  dayAndTime: null
};

function cleanFieldValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value)
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!trimmed || /^none|null|undefined$/i.test(trimmed)) return null;
  return trimmed.slice(0, 180);
}

function extractJsonObject(text: string | null | undefined): string | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  return candidate.match(/\{[\s\S]*\}/)?.[0] ?? null;
}

export function parseBookingInfoExtractionOutput(
  text: string | null | undefined
): BookingInfoFields {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return { ...EMPTY_BOOKING_INFO };

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    return {
      fullName: cleanFieldValue(parsed.fullName),
      email: cleanFieldValue(parsed.email),
      phone: cleanFieldValue(parsed.phone),
      timezone: cleanFieldValue(parsed.timezone),
      dayAndTime: cleanFieldValue(parsed.dayAndTime)
    };
  } catch {
    return { ...EMPTY_BOOKING_INFO };
  }
}

export function mergeBookingInfoFields(
  primary: BookingInfoFields,
  fallback: BookingInfoFields
): BookingInfoFields {
  return {
    fullName: primary.fullName ?? fallback.fullName,
    email: primary.email ?? fallback.email,
    phone: primary.phone ?? fallback.phone,
    timezone: primary.timezone ?? fallback.timezone,
    dayAndTime: primary.dayAndTime ?? fallback.dayAndTime
  };
}

export function hasAnyBookingInfoField(fields: BookingInfoFields): boolean {
  return BOOKING_INFO_FIELD_NAMES.some((field) => !!fields[field]);
}

export function hasAllBookingInfoFields(fields: BookingInfoFields): boolean {
  return BOOKING_INFO_FIELD_NAMES.every((field) => !!fields[field]);
}

export function isBookingInfoRequestText(text: string | null | undefined) {
  const lower = (text || '').toLowerCase();
  const matches = [
    /\b(full\s+name|name)\b/.test(lower),
    /\bemail\b/.test(lower),
    /\bphone\b/.test(lower),
    /\b(timezone|time\s+zone)\b/.test(lower),
    /\b(day\s+and\s+time|day\/time|what\s+day|best\s+time|time\s+works)\b/.test(
      lower
    )
  ];
  return matches.filter(Boolean).length >= 4;
}

export function extractBookingInfoHeuristically(
  leadMessage: string
): BookingInfoFields {
  const email =
    leadMessage.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;
  const phone =
    leadMessage.match(
      /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/
    )?.[0] ?? null;
  const timezone =
    leadMessage.match(
      /\b(EST|EDT|ET|CST|CDT|CT|MST|MDT|MT|PST|PDT|PT|GMT|UTC)\b/i
    )?.[0] ?? null;
  const dayAndTime =
    leadMessage.match(
      /\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow)\b.{0,40}?\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i
    )?.[0] ?? null;

  let fullName: string | null = null;
  const firstSegment = leadMessage
    .split(',')
    .map((part) => part.trim())
    .find(Boolean);
  if (
    firstSegment &&
    !/@/.test(firstSegment) &&
    !/\d/.test(firstSegment) &&
    firstSegment.split(/\s+/).filter(Boolean).length >= 2
  ) {
    fullName = firstSegment.slice(0, 120);
  }

  return {
    fullName,
    email,
    phone,
    timezone: timezone?.toUpperCase() ?? null,
    dayAndTime
  };
}

export async function extractBookingInfoWithHaiku(params: {
  accountId: string;
  leadMessage: string;
}): Promise<BookingInfoFields> {
  const heuristic = extractBookingInfoHeuristically(params.leadMessage);

  const result = await callHaikuText({
    accountId: params.accountId,
    maxTokens: 180,
    temperature: 0,
    timeoutMs: 3000,
    logPrefix: '[booking-info-extractor]',
    prompt:
      `The lead replied to a booking info request. Extract these fields. ` +
      `Return JSON with exact field names. Use null for missing fields.\n\n` +
      `Lead reply: ${params.leadMessage}\n\n` +
      `Required fields:\n` +
      `- fullName: full name with first and last\n` +
      `- email: email address\n` +
      `- phone: phone number\n` +
      `- timezone: timezone abbreviation (EST, CT, PT, etc.)\n` +
      `- dayAndTime: day and time for call\n\n` +
      `Return JSON only.`
  });

  return mergeBookingInfoFields(
    parseBookingInfoExtractionOutput(result.text),
    heuristic
  );
}
