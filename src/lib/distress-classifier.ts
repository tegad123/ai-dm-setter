// ---------------------------------------------------------------------------
// distress-classifier.ts
// ---------------------------------------------------------------------------
// LLM-backed distress classifier used as a secondary confirmation layer for
// MEDIUM-tier signals in distress-detector.ts. HARD-tier signals fire
// immediately from pure regex — this file is only called when a MEDIUM
// signal matches, to reduce false positives on phrases that occasionally
// appear in normal trading-DM context.
//
// Model: claude-haiku-4-5-20251001 — fast, cheap, sufficient for binary
// classification. Typical latency: 200–400ms. Fail-open: if the call
// throws or times out, distress is NOT assumed (the regex already fired a
// MEDIUM hit; we default to "not confirmed" to avoid blocking every
// "things are hard right now bro" message on an API outage).
//
// This is a pure function wrapper. No DB, no side effects.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

export interface ClassifierResult {
  confirmed: boolean;
  reason: string;
}

// ── Classifier-first API (2026-07-24, shadow-mode rollout) ─────────────────
// The richer result the PRIMARY (classifier-first) path consumes. `ok` is
// distinct from `detected`: `ok=false` means the classifier could not produce a
// verdict (no key / timeout / parse error) — the caller must fail CLOSED on the
// safety path, not treat "no verdict" as "no distress" (that conflation was the
// original fail-open bug). `category` names the top matched class; `span` is the
// phrase the model keyed on (for the review log).
export interface DistressClassification {
  ok: boolean;
  detected: boolean;
  category: string | null;
  span: string | null;
  reason: string;
}

// Kill switch — flip DISTRESS_CLASSIFIER_ENABLED=false to disable the classifier
// path entirely (3am rollback without a deploy). Defaults to ENABLED; only the
// explicit string "false" disables it.
export function isClassifierEnabled(): boolean {
  return process.env.DISTRESS_CLASSIFIER_ENABLED !== 'false';
}

// LRU-ish cache keyed sha1(text), ~60s TTL. Collapses the duplicate Layer-1
// (webhook) + Layer-2 (ai-engine) classifier call per turn — roughly halves cost
// and latency for the common case where both layers see the same message.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const classificationCache = new Map<
  string,
  { at: number; value: DistressClassification }
>();

function cacheKey(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

// Haiku sometimes wraps JSON in a ```json … ``` markdown fence despite "JSON
// only". Stripping it BEFORE JSON.parse is essential — an unstripped fence
// throws, which on the primary path fail-closes and pauses EVERY message. Also
// tolerates leading prose by extracting the first {...} block.
function parseClassifierJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();
  if (!s.startsWith('{')) {
    const brace = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (brace !== -1 && end > brace) s = s.slice(brace, end + 1);
  }
  return JSON.parse(s);
}

function cacheGet(text: string): DistressClassification | null {
  const key = cacheKey(text);
  const hit = classificationCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    classificationCache.delete(key);
    return null;
  }
  // refresh recency (LRU)
  classificationCache.delete(key);
  classificationCache.set(key, hit);
  return hit.value;
}

function cacheSet(text: string, value: DistressClassification): void {
  // Never cache a non-ok verdict — an outage-time failure must not stick for
  // 60s and suppress detection once the API recovers.
  if (!value.ok) return;
  const key = cacheKey(text);
  classificationCache.set(key, { at: Date.now(), value });
  if (classificationCache.size > CACHE_MAX) {
    const oldest = classificationCache.keys().next().value;
    if (oldest) classificationCache.delete(oldest);
  }
}

const SYSTEM_PROMPT = `You are a distress classifier for a sales conversation platform. Your job is to decide whether an inbound message from a lead contains genuine personal distress, crisis, trauma, or hardship that should pause the sales pipeline and route to a human.

Respond with JSON only. No other text.

FIRE (confirmed=true) for:
- Caring for a seriously ill, disabled, or paralyzed family member
- Terminal illness (own or close family)
- Recent bereavement or grief
- Domestic abuse or unsafe home situation
- Homelessness or severe food/housing insecurity
- Mental health crisis language (breakdown, can't cope, falling apart)
- Severe financial desperation (can't pay for basics, about to lose home)
- Any combination of hardship that signals the person is in genuine crisis

DO NOT fire (confirmed=false) for:
- Normal trading frustration ("things are tough", "markets are hard")
- General financial aspiration ("I need more money", "my job doesn't pay enough")
- Sales-assistance requests ("please help me", "I need this")
- Mild life stress that is common in sales conversations

Response format:
{"confirmed": true|false, "reason": "<one sentence explaining decision>"}`;

// Standing production risk fixed here (2026-07-22), separate from the
// classifier-first rework: the SDK defaults to a 10-MINUTE request timeout
// and 2 retries. This call sits on the inbound webhook path (Layer 1
// distress gate), so a single hung Haiku request could block a webhook for
// up to ~10 minutes with retries. We bound it hard.
const CLASSIFIER_TIMEOUT_MS = 1200;
const CLASSIFIER_MAX_RETRIES = 1;

export async function classifyDistressIntent(
  text: string
): Promise<ClassifierResult> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { confirmed: false, reason: 'no_api_key' };
    }

    // Per-request timeout + a tight retry cap. maxRetries drops from the
    // SDK default of 2 to 1; the client-level timeout is a hard per-attempt
    // ceiling. Worst case is now ~2 attempts * 1200ms, not 10 minutes.
    const client = new Anthropic({
      apiKey,
      maxRetries: CLASSIFIER_MAX_RETRIES
    });
    const response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 64,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Message: "${text}"` }]
      },
      { timeout: CLASSIFIER_TIMEOUT_MS }
    );

    const raw =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';
    // Same fence-tolerant parse as the classifier-first path — Haiku wraps JSON
    // in a ```json fence often enough that a bare JSON.parse here was silently
    // failing (→ fail-open → MEDIUM tier never confirmed).
    const parsed = parseClassifierJson(raw) as {
      confirmed: boolean;
      reason: string;
    };
    return {
      confirmed: Boolean(parsed.confirmed),
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'parsed'
    };
  } catch (err) {
    // Fail-open here (secondary/MEDIUM-tier path): don't block generation on
    // classifier errors. The classifier-first rework introduces a distinct
    // `ok` field so the PRIMARY path can fail CLOSED instead — this function's
    // current callers all treat "no answer" as "not distress", which is
    // correct only because HARD regex already fired upstream.
    const kind =
      err instanceof Error &&
      (err.name === 'APIConnectionTimeoutError' || /timeout/i.test(err.message))
        ? 'classifier_timeout'
        : 'classifier_error';
    return { confirmed: false, reason: kind };
  }
}

// ── Classifier-first prompt + function ─────────────────────────────────────
// Distinct from SYSTEM_PROMPT above: this is the PRIMARY detector, so suicidal
// ideation is the explicit top category (the regex-era prompt assumed regex
// handled it), all grammatical forms are called out, hedges are explicitly
// non-downgrading, and the DO-NOT-FIRE list prevents pausing normal sales talk.
const CLASSIFIER_FIRST_SYSTEM_PROMPT = `You are the PRIMARY distress detector for a sales-conversation platform. Decide whether an inbound lead message contains genuine personal distress/crisis that must PAUSE the sales pipeline and route to a human. You are the safety net — when genuinely unsure, prefer to FIRE.

Respond with JSON only, no other text, no markdown fences. Keep "reason" to at most 8 words so the JSON is never truncated:
{"detected": true|false, "category": "<one of the categories below or null>", "span": "<the short phrase you keyed on, or null>", "reason": "<max 8 words>"}

FIRE (detected=true), most critical first:
- suicidal_ideation — ANY form: "giving up on life", "dont wanna be here anymore", "end it all", "better off dead", "no reason to live", "cant do this anymore", hopelessness about being alive. Catch all grammatical forms (give/giving/gave up; want/wanna/wanted to die). A hedge ("some days", "kinda", "lately") does NOT downgrade it.
- self_harm — hurting/cutting oneself.
- caregiving_crisis — caring for a seriously ill/disabled/paralyzed/bedridden/terminal family member. FIRE on this EVEN IF the lead states it calmly and expresses no explicit emotion — the caregiving burden itself is the crisis to route to a human. "my mom is paralyzed and i take care of her" / "my dad is bedridden and i look after him" MUST fire. Regex cannot express this — it is a core reason the classifier exists.
- bereavement — recent death/grief of someone close.
- abuse_or_unsafe — domestic abuse, violence, unsafe home.
- severe_hardship — homelessness, can't afford basics, about to lose home; mental-health crisis (breakdown, can't cope, falling apart).

DO NOT fire (detected=false, category null):
- Normal trading frustration ("this market is killing me", "im dead bro 😂", "i blew my account").
- Money ambition ("i need more money", "my job doesn't pay enough").
- Sales-assistance requests ("please help me bro", "i need this").
- Mild everyday stress common in sales DMs.`;

// Classifier-first detection. Returns a rich verdict with `ok` distinct from
// `detected` so the caller can fail CLOSED. Kill-switchable, cached, hard
// timeout. Never throws.
export async function classifyDistress(
  text: string
): Promise<DistressClassification> {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return {
      ok: true,
      detected: false,
      category: null,
      span: null,
      reason: 'empty'
    };
  }
  if (!isClassifierEnabled()) {
    return {
      ok: false,
      detected: false,
      category: null,
      span: null,
      reason: 'classifier_disabled'
    };
  }
  const cached = cacheGet(trimmed);
  if (cached) return cached;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      detected: false,
      category: null,
      span: null,
      reason: 'no_api_key'
    };
  }

  try {
    const client = new Anthropic({
      apiKey,
      maxRetries: CLASSIFIER_MAX_RETRIES
    });
    const response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        // 300 (not 64): the richer JSON — category + span + reason — truncates
        // at 64 AND at 200 when the model writes a long reason, which yields a
        // parse error and (on the primary path) a fail-closed pause on EVERY
        // message. Combined with the "reason ≤ 8 words" prompt instruction this
        // keeps the response well within budget. This cap is the #1 day-one
        // outage risk if left small.
        max_tokens: 300,
        temperature: 0,
        system: CLASSIFIER_FIRST_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Message: "${trimmed}"` }]
      },
      { timeout: CLASSIFIER_TIMEOUT_MS }
    );
    const raw =
      response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : '';
    const parsed = parseClassifierJson(raw) as {
      detected?: boolean;
      category?: string | null;
      span?: string | null;
      reason?: string;
    };
    const value: DistressClassification = {
      ok: true,
      detected: Boolean(parsed.detected),
      category: typeof parsed.category === 'string' ? parsed.category : null,
      span: typeof parsed.span === 'string' ? parsed.span : null,
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'classified'
    };
    cacheSet(trimmed, value);
    return value;
  } catch (err) {
    const kind =
      err instanceof Error &&
      (err.name === 'APIConnectionTimeoutError' || /timeout/i.test(err.message))
        ? 'classifier_timeout'
        : err instanceof SyntaxError
          ? 'classifier_parse_error'
          : 'classifier_error';
    // ok=false — the caller decides fail-closed vs fail-open per its mode.
    return {
      ok: false,
      detected: false,
      category: null,
      span: null,
      reason: kind
    };
  }
}
