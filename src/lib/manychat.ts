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
  options?: { windowDays?: number }
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
  // contact when their last interaction was within `windowDays`. A
  // cold-store hit from 6 months ago is NOT evidence ManyChat just
  // sent the opener; treat that as INBOUND.
  const windowMs = (options?.windowDays ?? 7) * 24 * 60 * 60 * 1000;
  if (data.last_interaction) {
    const lastMs = Date.parse(data.last_interaction);
    if (!Number.isNaN(lastMs)) {
      if (Date.now() - lastMs > windowMs) {
        console.log(
          `[manychat] subscriber ${cleanedUsername} found but last interaction ${data.last_interaction} is outside ${options?.windowDays ?? 7}-day window — treating as INBOUND`
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
  options?: { windowDays?: number }
): Promise<boolean> {
  const sub = await findSubscriberByInstagramUsername(
    apiKey,
    igUsername,
    options
  );
  return sub !== null;
}
