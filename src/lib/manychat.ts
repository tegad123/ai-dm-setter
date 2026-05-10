// ---------------------------------------------------------------------------
// manychat.ts
// ---------------------------------------------------------------------------
// Thin client for the ManyChat REST API. We use it for two things:
//   1. verifyApiKey — `/fb/page/getInfo` is the cheapest call that proves
//      a key is valid + returns the connected page name for the UI.
//   2. findSubscriberByInstagramUsername — checks whether the inbound
//      lead is a known ManyChat contact for this account. When the
//      lookup hits, we know ManyChat already sent the cold opener and
//      this lead is a warm reply (Conversation.source='MANYCHAT' →
//      AI suppresses its own opener and starts at the configured step).
//
// All methods fail closed: on network/HTTP error, return null/false
// rather than throwing. Caller (webhook-processor) treats any failure
// as "fall back to INBOUND behavior" — the conversation flow must not
// break if ManyChat is down.
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.manychat.com';

interface ManyChatResponse<T> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
}

interface PageInfo {
  id: string;
  name: string;
  /** Connected platform — 'instagram' / 'facebook' / 'whatsapp'. */
  channel?: string;
  username?: string;
}

interface SubscriberInfo {
  id: string;
  /** Instagram username (without @) — present when subscriber came via IG. */
  ig_username?: string;
  /** Instagram numeric user ID (the 16-17 digit identifier Meta's IG
   *  Send API expects as the recipient). ManyChat returns this as a
   *  JSON number — read it as `string | number` and coerce, since
   *  numbers above ~15 digits can lose precision in JS Number even
   *  though IG IDs currently fit within Number.MAX_SAFE_INTEGER. */
  ig_id?: string | number;
  /** ISO timestamp of the most recent inbound/outbound message on the
   *  ManyChat side. We use this as the "did ManyChat message them
   *  recently?" signal — see windowDays in findSubscriber*. */
  last_interaction?: string;
  last_input_text?: string;
  /** Subscriber name as ManyChat tracked it. */
  name?: string;
  first_name?: string;
  last_name?: string;
}

async function call<T>(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T | null> {
  if (!apiKey) return null;
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        ...(init?.headers || {})
      }
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[manychat] ${path} failed (${res.status}): ${body.slice(0, 200)}`
      );
      return null;
    }
    const json = (await res.json()) as ManyChatResponse<T>;
    if (json.status !== 'success') {
      console.warn(
        `[manychat] ${path} returned non-success status: ${json.message ?? '(no message)'}`
      );
      return null;
    }
    return json.data ?? null;
  } catch (err) {
    console.warn(`[manychat] ${path} threw:`, err);
    return null;
  }
}

/**
 * Verify a ManyChat API key. Returns the connected Page name on
 * success, null on any failure (invalid key, network, schema drift).
 * Used by the integrations UI's verify endpoint before saving.
 */
export async function verifyApiKey(apiKey: string): Promise<{
  valid: boolean;
  pageName?: string;
  error?: string;
}> {
  const data = await call<PageInfo>(apiKey, '/fb/page/getInfo');
  if (!data) {
    return { valid: false, error: 'invalid_or_unreachable' };
  }
  return { valid: true, pageName: data.name };
}

/**
 * Look up a ManyChat subscriber by Instagram username. Returns the
 * subscriber when found AND the subscriber's most recent ManyChat
 * interaction is within `windowDays` (default 7). Returns null when:
 *   - the API key is missing/invalid
 *   - no subscriber matches the username
 *   - the subscriber exists but their last interaction is older than
 *     the window (i.e. the lead didn't just respond to a fresh
 *     ManyChat opener)
 *   - the API errors out
 *
 * The webhook-processor uses a non-null return to mark the new
 * conversation `source='MANYCHAT'` so the AI suppresses its own opener.
 *
 * Note: ManyChat's exact endpoint name has shifted over the years.
 * `findByInstagramUsername` is the IG-specific shape currently
 * documented; older fb/subscriber endpoints accept ?email= or
 * ?phone= but not username. If ManyChat returns 404 here, callers
 * should treat that as "not in ManyChat" (which is the correct
 * fallback — INBOUND).
 */
export async function findSubscriberByInstagramUsername(
  apiKey: string,
  igUsername: string,
  options?: { windowDays?: number; windowMinutes?: number }
): Promise<SubscriberInfo | null> {
  if (!apiKey || !igUsername) return null;
  const cleanedUsername = igUsername.replace(/^@/, '').trim();
  if (!cleanedUsername) return null;
  const data = await call<SubscriberInfo>(
    apiKey,
    `/fb/subscriber/findByInstagramUsername?ig_username=${encodeURIComponent(cleanedUsername)}`
  );
  if (!data) return null;

  // Window check — only treat the subscriber as a recent ManyChat
  // contact when their last interaction was within the configured
  // window. A cold-store hit from 6 months (or even 6 days) ago is
  // NOT evidence ManyChat just sent the opener; treat that as INBOUND.
  //
  // windowMinutes (preferred for handoff detection) takes precedence
  // over windowDays. Default is 7 days for backward compat — but the
  // webhook-processor handoff path now passes windowMinutes=10 since
  // a real ManyChat → IG handoff flow completes in < 5 minutes.
  // Anything older is a stale subscriber from a prior campaign and
  // their current direct DM is INBOUND, not a ManyChat-fired event.
  // (Bug-fix 2026-05-10 — Stella @atstellagram was tagged MANYCHAT
  // because she was in the subscriber list from a prior campaign,
  // which routed her direct DM into the wrong Step 1 branch.)
  const windowMs =
    options?.windowMinutes != null
      ? options.windowMinutes * 60 * 1000
      : (options?.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  if (data.last_interaction) {
    const lastMs = Date.parse(data.last_interaction);
    if (!Number.isNaN(lastMs)) {
      if (Date.now() - lastMs > windowMs) {
        const windowLabel =
          options?.windowMinutes != null
            ? `${options.windowMinutes}min`
            : `${options?.windowDays ?? 7}d`;
        console.log(
          `[manychat] subscriber ${cleanedUsername} found but last interaction ${data.last_interaction} is outside ${windowLabel} window — treating as INBOUND`
        );
        return null;
      }
    }
  }
  return data;
}

/**
 * Convenience: returns true if `findSubscriberByInstagramUsername`
 * hits within the freshness window. Webhook-processor uses this
 * as the boolean "should I tag this conversation MANYCHAT?" check.
 */
export async function looksLikeManyChatHandoff(
  apiKey: string,
  igUsername: string,
  options?: { windowDays?: number; windowMinutes?: number }
): Promise<boolean> {
  const sub = await findSubscriberByInstagramUsername(
    apiKey,
    igUsername,
    options
  );
  return sub !== null;
}

/**
 * Look up a ManyChat subscriber by their ManyChat-internal subscriber
 * ID. Used to resolve the Instagram numeric user ID (`ig_id`) when
 * ManyChat's variable picker only exposes the subscriber ID
 * (`{{contact.id}}`), not the IG numeric ID directly. Without `ig_id`,
 * the AI can't deliver replies via Meta's IG Send API.
 *
 * Returns null on any failure — caller falls back to whatever the lead
 * was created with (typically the handle).
 */
export async function findSubscriberById(
  apiKey: string,
  subscriberId: string
): Promise<SubscriberInfo | null> {
  if (!apiKey || !subscriberId) return null;
  const cleaned = subscriberId.trim();
  if (!cleaned) return null;
  return call<SubscriberInfo>(
    apiKey,
    `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(cleaned)}`
  );
}

/**
 * Coerce a SubscriberInfo's `ig_id` field to a numeric string usable
 * as a Meta IG Send API recipient. Returns null when the field is
 * missing, zero, or doesn't look like a real IG numeric ID (12+
 * digits). The 12-digit floor matches what
 * `silent-stop-recovery.hasUsablePlatformRecipient` requires.
 */
export function extractInstagramNumericId(
  sub: SubscriberInfo | null | undefined
): string | null {
  if (!sub) return null;
  const raw = sub.ig_id;
  if (raw === undefined || raw === null || raw === 0) return null;
  const asString = typeof raw === 'number' ? String(raw) : String(raw).trim();
  if (!/^\d{12,}$/.test(asString)) return null;
  return asString;
}
