// ---------------------------------------------------------------------------
// distress-detector.ts
// ---------------------------------------------------------------------------
// Scans inbound lead messages for distress signals. Triggered BEFORE any AI
// generation so the sales pipeline never produces a pitch in response to a
// person in crisis.
//
// Incidents that drove this feature:
//   daetradez 2026-04-18: Lead expressed suicidal ideation → AI pitched trading
//
// Policy: false positives are ACCEPTABLE (operator can re-enable).
//         False negatives are NOT. Err heavily on the side of caution.
//
// ---------------------------------------------------------------------------
//
// THREE-TIER MODEL
//
//   HARD    — single regex match fires immediately. No LLM call. These are
//             phrases unambiguous enough on their own: direct ideation,
//             suicide, self-harm, giving-up-on-life, spiritual crisis,
//             last-hope appeals, severe financial crisis.
//
//   MEDIUM  — regex matches a likely-distress phrase but common enough in
//             trading DMs to produce occasional false positives. A Haiku
//             classifier confirms before firing. Fail-open: if the classifier
//             call fails, MEDIUM does NOT fire (keep generation unblocked on
//             API outages; HARD covers the clearest cases).
//
//   SOFT    — ambiguous distress register ("broken", "stressed up"). Too
//             common in normal trading complaints. Requires a HELP_PLEA match
//             in the same message to promote to a fire (no LLM call needed).
//
//   HELP_PLEA — combiner for SOFT. Standalone these are NOT distress.
//
// Fire rule:
//   HARD match                            → fire (sync, no LLM)
//   MEDIUM match + classifier confirmed   → fire (async, Haiku call)
//   MEDIUM match + classifier denied/err  → no fire
//   SOFT match AND HELP_PLEA match        → fire (sync, no LLM)
//   HELP_PLEA alone                       → no fire
//   SOFT alone                            → no fire
//
// ---------------------------------------------------------------------------

interface Signal {
  pattern: RegExp;
  label: string;
}

// ── HARD patterns ────────────────────────────────────────────────────────────
// Single match fires alone.

// ─────────────────────────────────────────────────────────────────────────
// INTERIM (2026-07-22, F1 part 2). These patterns were widened after a
// production miss: a lead wrote "giving up on life" and the pattern was
// `give up on life` — no gerund alternation, so a textbook ideation phrase
// did not match and the safety gate never ran.
//
// This is a STOPGAP, explicitly not the fix. A phrase list cannot cover
// natural language: it still misses whole categories (caregiving for a
// paralyzed relative, bereavement, abuse) that carry no fixed wording. The
// real fix is the classifier-first path, where the LLM decides and these
// patterns become a zero-latency fast path underneath it.
//
// Every alternation below is inflection coverage (giv-e/es/ing/gave,
// end/ends/ending, kill/kills/killing, want/wants/wanted/wanting) plus the
// four phrasings from Tega's test set that regex CAN express.
// ─────────────────────────────────────────────────────────────────────────
const HARD_PATTERNS: Signal[] = [
  // Direct suicidal ideation
  {
    pattern:
      /\b((giv(e|es|ing)|gave)\s+up\s+on\s+life|end(s|ing)?\s+it\s+all|kill(s|ing)?\s+(myself|my\s?self)|want(s|ed|ing)?\s+to\s+die|wanna\s+die|gonna\s+die|going\s+to\s+die|wish\s+i\s+(was|were)\s+dead|tak(e|ing)\s+my\s+(own\s+)?life|end(ing)?\s+my\s+life)\b/i,
    label: 'direct_ideation'
  },
  {
    pattern: /\b(suicide|suicidal)\b/i,
    label: 'suicide_mention'
  },
  {
    pattern:
      /\b(self[-\s]?harm|hurt(ing|s)?\s+myself|harm(ing|s)?\s+myself|cut(ting)?\s+myself)\b/i,
    label: 'self_harm'
  },
  {
    // Tolerate intervening adverbs ("even", "really", "just", "also") between
    // "dont" and "want/wanna", and an optional "anymore" suffix — live Shazim
    // repro 2026-07-24 MISSED "dont even wanna be here anymore" because the old
    // pattern required "dont" directly adjacent to "want/wanna" and to
    // "live/be here". (Interim regex patch; the classifier-first close is what
    // ultimately covers arbitrary phrasing.)
    pattern:
      /\b(rather\s+be\s+dead|better\s+off\s+dead|don'?t\s+(even\s+|really\s+|just\s+|also\s+)?(want|wanna)\s+(to\s+)?(live|be\s+here)(\s+anymore)?|dont\s+(even\s+|really\s+|just\s+)?wanna\s+be\s+here(\s+anymore)?|tired\s+of\s+living|not\s+worth\s+living|no\s+reason\s+to\s+live|what'?s\s+the\s+point\s+of\s+living)\b/i,
    label: 'indirect_ideation'
  },
  {
    pattern:
      /\b(nothing\s+left\s+to\s+live\s+for|can'?t\s+go\s+on|done\s+with\s+(life|everything|all\s+of\s+(this|it))|no\s+point\s+(in\s+)?going\s+on|what'?s\s+the\s+point\s+of\s+(any(thing)?|it\s+all|any\s+of\s+this)|can'?t\s+do\s+this\s+anymore)\b/i,
    label: 'giving_up'
  },
  // Spiritual crisis
  {
    pattern:
      /\b(can'?t\s+call\s+on\s+god|don'?t\s+know\s+how\s+to\s+(pray|call\s+on\s+god)|lost\s+my\s+faith|lost\s+all\s+faith)\b/i,
    label: 'spiritual_crisis'
  },
  // Last-hope appeals
  {
    pattern:
      /\b(i\s+believe\s+you\s+(can|are)\s+(be\s+)?the\s+light|you\s+are\s+my\s+(only\s+)?hope|you('?re|\s+are)\s+my\s+last\s+(hope|chance))\b/i,
    label: 'last_hope_appeal'
  },
  // "Darkest season/time/place" — strong distress register
  {
    pattern: /\bdarkest\s+(season|time|place|moment|period|hour|day|night)\b/i,
    label: 'darkest_season'
  },

  // ── Severe financial crisis ───────────────────────────────────────────────
  // "can't afford rent/food/bills/medical" is specific enough to fire alone.
  {
    pattern:
      /\bcan'?t\s+(afford|pay\s+(for\s+)?|cover|manage)\s+(rent|food|groceries|bills|medical|hospital|treatment|medication|utilities|mortgage)\b/i,
    label: 'financial_hardship'
  },
  {
    pattern:
      /\b(about\s+to\s+(lose|be\s+evicted\s+from|get\s+kicked\s+out\s+of)\s+(my\s+)?(home|house|apartment|flat)|facing\s+eviction|getting\s+evicted)\b/i,
    label: 'financial_hardship'
  }
];

// ── MEDIUM patterns ───────────────────────────────────────────────────────────
// Regex matches but requires Haiku classifier confirmation before firing.
// These phrases appear occasionally in normal trading conversations
// ("things are really bad right now in the markets", "I have no one to
// guide me in trading") so pure regex would produce too many false positives.

const MEDIUM_PATTERNS: Signal[] = [
  {
    pattern:
      /\b(things\s+are\s+really\s+(bad|tough|hard|rough|dark)\s+right\s+now|really\s+(struggling|suffering)\s+right\s+now)\b/i,
    label: 'medium_hardship'
  },
  {
    pattern:
      /\b(i\s+have\s+no\s+one(\s+to\s+(help|turn\s+to|lean\s+on|talk\s+to))?|completely\s+alone(\s+in\s+this)?|no\s+support\s+(system|network|at\s+all))\b/i,
    label: 'medium_isolation'
  },
  {
    pattern:
      /\b(falling\s+apart|breaking\s+down|can'?t\s+cope|can'?t\s+handle\s+(this|it|anymore|life)|at\s+my\s+(breaking\s+point|wit['']?s?\s+end|lowest\s+point))\b/i,
    label: 'medium_breakdown'
  },
  {
    pattern:
      /\b(lost\s+everything|rock\s+bottom|hit\s+rock\s+bottom|everything\s+(is\s+)?falling\s+apart|my\s+whole\s+(world|life)\s+(is\s+)?(falling|crumbling|collapsing))\b/i,
    label: 'medium_despair'
  }
];

// ── SOFT patterns ─────────────────────────────────────────────────────────────
// Common ambiguous distress register. Require HELP_PLEA combiner to fire.

const SOFT_PATTERNS: Signal[] = [
  {
    pattern: /\b(broken(\s+down)?|stressed\s+(up|out))\b/i,
    label: 'emotional_breakdown'
  },
  {
    pattern:
      /\bgoing\s+through\s+(a\s+lot|it|my\s+darkest|so\s+much|hell|the\s+worst)\b/i,
    label: 'going_through'
  }
];

// ── HELP_PLEA patterns ────────────────────────────────────────────────────────
// Combiner for SOFT tier only.

const HELP_PLEA_PATTERNS: Signal[] = [
  {
    pattern:
      /\b(kindly\s+help\s+me|please\s+help\s+me|help\s+me\s+(bro|sir|please|man|pls))\b/i,
    label: 'help_plea'
  }
];

export const DISTRESS_PATTERNS = [
  ...HARD_PATTERNS,
  ...MEDIUM_PATTERNS,
  ...SOFT_PATTERNS,
  ...HELP_PLEA_PATTERNS
];

export interface DistressDetectionResult {
  detected: boolean;
  label: string | null;
  match: string | null;
  helpPleaMatch?: string | null;
  /** Set when MEDIUM tier fired and classifier was called */
  classifierReason?: string;
  /** Which authority decided this turn — for the trace/review log. */
  decidedBy?: 'classifier' | 'regex_failclosed' | 'regex_legacy';
}

// HARD ideation-class labels. When the classifier can't produce a verdict
// (API down / no key / parse error) AND the regex saw one of these, we fail
// CLOSED and hold — a missed ideation disclosure is the one failure mode that
// is never acceptable. Financial/ambiguous HARD labels are deliberately NOT
// here: those are the false-positive-prone ones (the "tired of living
// paycheck to paycheck" class), so a classifier outage must NOT resurrect
// them as authoritative.
// Fail-closed ONLY on UNAMBIGUOUS ideation — labels whose regex cannot match
// benign phrasing. 2026-07-28: indirect_ideation and giving_up were removed
// after the fix itself resurrected the false positive — indirect_ideation's
// regex includes `tired of living`, which matches "tired of living paycheck to
// paycheck", so failing closed on it on a classifier blip re-fired the exact
// 988 message we were killing. direct_ideation ("kill myself", "want to die"),
// suicide_mention ("suicide"/"suicidal"), and self_harm ("cutting myself")
// have no benign continuation — those still hold on a classifier outage.
const IDEATION_FAILCLOSED_LABELS = new Set<string>([
  'direct_ideation',
  'suicide_mention',
  'self_harm'
]);

/**
 * Sync scan — HARD and SOFT+HELP_PLEA tiers only. No LLM call.
 * Used internally and exported for unit tests.
 */
export function detectDistressSync(text: string): DistressDetectionResult {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { detected: false, label: null, match: null };
  }
  const trimmed = text.trim();

  // 1. HARD — fires alone
  for (const { pattern, label } of HARD_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) return { detected: true, label, match: m[0] };
  }

  // 2. SOFT + HELP_PLEA combo
  let softMatch: { label: string; match: string } | null = null;
  for (const { pattern, label } of SOFT_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      softMatch = { label, match: m[0] };
      break;
    }
  }
  if (softMatch) {
    for (const { pattern } of HELP_PLEA_PATTERNS) {
      const m = trimmed.match(pattern);
      if (m) {
        return {
          detected: true,
          label: `combination:${softMatch.label}`,
          match: softMatch.match,
          helpPleaMatch: m[0]
        };
      }
    }
  }

  return { detected: false, label: null, match: null };
}

export interface DetectDistressOptions {
  /**
   * Shadow mode (2026-07-24, classifier-first rollout). When set, the LLM
   * classifier runs ALONGSIDE the regex tiers and its verdict is logged for
   * joint review — but REGEX STAYS AUTHORITATIVE (the returned result is the
   * regex verdict). This lets us compare classifier vs regex fire-rate on real
   * traffic before flipping the classifier authoritative. Off = current
   * behavior exactly.
   */
  shadowClassifier?: boolean;
  conversationId?: string | null;
  accountId?: string | null;
  /**
   * Classifier-authoritative mode (2026-07-28). When true, the LLM classifier
   * (`classifyDistress`) DECIDES; regex is demoted to an advisory pre-filter
   * that can never fire alone. On a classifier outage we fail CLOSED only when
   * the regex saw an ideation-class signal. This is the fix for the
   * false-positive class (e.g. "tired of living paycheck to paycheck" firing
   * the crisis response on a funnel whose audience is broke by definition).
   */
  classifierAuthoritative?: boolean;
  /**
   * True for low-ticket funnel personas (disableLeadStageProgression). Passed
   * into the classifier so it knows financial frustration is the NORMAL
   * register for this audience and must not be read as severe hardship.
   */
  lowTicketFunnel?: boolean;
}

// Best-effort shadow log — records the regex-vs-classifier comparison. Never
// throws, never blocks the caller (fire-and-forget). Only the disagreements
// (agreed=false) are the joint-review queue.
async function logDistressShadow(params: {
  text: string;
  regex: DistressDetectionResult;
  conversationId?: string | null;
  accountId?: string | null;
}): Promise<void> {
  try {
    const started = Date.now();
    const { classifyDistress } = await import('@/lib/distress-classifier');
    const c = await classifyDistress(params.text);
    const latencyMs = Date.now() - started;
    const agreed = params.regex.detected === c.detected;
    const { default: prisma } = await import('@/lib/prisma');
    await prisma.distressShadowLog
      .create({
        data: {
          conversationId: params.conversationId ?? null,
          accountId: params.accountId ?? null,
          messageText: params.text.slice(0, 2000),
          regexDetected: params.regex.detected,
          regexLabel: params.regex.label ?? null,
          classifierDetected: c.detected,
          classifierOk: c.ok,
          classifierCategory: c.category ?? null,
          classifierReason: c.reason,
          agreed,
          latencyMs
        }
      })
      .catch(() => {});
    if (!agreed) {
      console.warn(
        `[distress-shadow] DISAGREEMENT regex=${params.regex.detected}(${params.regex.label ?? '-'}) ` +
          `classifier=${c.detected}(${c.category ?? '-'}, ok=${c.ok}) :: "${params.text.slice(0, 80)}"`
      );
    }
  } catch {
    // shadow logging must never affect the live path
  }
}

/**
 * Full async scan — HARD + SOFT+combo (sync) then MEDIUM tier (Haiku confirm).
 * This is the function called by ai-engine.ts Layer 2 and webhook-processor.ts
 * Layer 1.
 *
 * With `opts.shadowClassifier`, additionally runs the classifier-first detector
 * in the background and logs a regex-vs-classifier comparison row (regex stays
 * authoritative — shadow only).
 */
export async function detectDistress(
  text: string,
  opts: DetectDistressOptions = {}
): Promise<DistressDetectionResult> {
  // ── Classifier-authoritative path (2026-07-28) ────────────────────────────
  // The LLM decides. Regex is an ADVISORY pre-filter only — it can prompt a
  // fail-closed hold on a classifier outage, but it can never fire on its own.
  // This is what kills the "tired of living paycheck to paycheck" false
  // positive: that phrase matches the regex's indirect_ideation pattern, but
  // classifyDistress reads it as money-ambition and returns detected=false,
  // and the classifier's verdict is the one that ships.
  if (opts.classifierAuthoritative) {
    const { classifyDistress, CLASSIFIER_AUTH_ATTEMPTS } = await import(
      '@/lib/distress-classifier'
    );
    const regexPrefilter = detectDistressSync(text);
    // Retry the whole classifier call on a non-verdict (ok:false) — a
    // transient error would otherwise drop a regex-invisible crisis
    // (caregiving / bereavement) to the fail-closed path, which only catches
    // ideation. Kill-switch / no-key return ok:false immediately and don't
    // benefit from retry, but a timeout/parse blip does.
    let c = await classifyDistress(text, {
      lowTicketFunnel: opts.lowTicketFunnel === true
    });
    for (
      let attempt = 1;
      attempt < CLASSIFIER_AUTH_ATTEMPTS &&
      !c.ok &&
      /timeout|parse/i.test(c.reason);
      attempt++
    ) {
      c = await classifyDistress(text, {
        lowTicketFunnel: opts.lowTicketFunnel === true
      });
    }

    if (c.ok) {
      // Classifier produced a verdict — it is authoritative, full stop.
      const result: DistressDetectionResult = c.detected
        ? {
            detected: true,
            label: c.category ?? 'classifier_distress',
            match: c.span ?? null,
            classifierReason: c.reason,
            decidedBy: 'classifier'
          }
        : {
            detected: false,
            label: null,
            match: null,
            classifierReason: c.reason,
            decidedBy: 'classifier'
          };
      // Still log the regex-vs-classifier comparison for the review ledger.
      if (opts.shadowClassifier) {
        void logDistressShadow({
          text,
          regex: regexPrefilter,
          conversationId: opts.conversationId,
          accountId: opts.accountId
        });
      }
      return result;
    }

    // Classifier could NOT produce a verdict (API down / no key / parse error).
    // Fail CLOSED only when the regex pre-filter saw an ideation-class signal —
    // a missed ideation disclosure is never acceptable. Financial/ambiguous
    // regex hits do NOT resurrect here (that would reinstate the exact false
    // positive we are fixing).
    const failClosed =
      regexPrefilter.detected &&
      typeof regexPrefilter.label === 'string' &&
      IDEATION_FAILCLOSED_LABELS.has(regexPrefilter.label);
    console.warn(
      `[distress] classifier unavailable (${c.reason}) — ${failClosed ? 'FAIL-CLOSED (regex saw ideation)' : 'not firing (regex saw no ideation)'} :: "${(text ?? '').slice(0, 80)}"`
    );
    return failClosed
      ? {
          detected: true,
          label: regexPrefilter.label,
          match: regexPrefilter.match,
          classifierReason: c.reason,
          decidedBy: 'regex_failclosed'
        }
      : {
          detected: false,
          label: null,
          match: null,
          classifierReason: c.reason,
          decidedBy: 'regex_failclosed'
        };
  }

  // ── Legacy regex-authoritative path (unchanged) ───────────────────────────
  const regexResult = await detectDistressRegexTiers(text);
  regexResult.decidedBy = 'regex_legacy';
  // Shadow mode: run the classifier-first detector alongside and log the
  // comparison, but return the AUTHORITATIVE regex verdict. Fire-and-forget.
  if (opts.shadowClassifier) {
    void logDistressShadow({
      text,
      regex: regexResult,
      conversationId: opts.conversationId,
      accountId: opts.accountId
    });
  }
  return regexResult;
}

// The current regex-authoritative detector (HARD/SOFT sync + MEDIUM Haiku
// confirm). Unchanged behavior — extracted so detectDistress can wrap it with
// shadow-mode logging.
async function detectDistressRegexTiers(
  text: string
): Promise<DistressDetectionResult> {
  // Run sync tiers first — if they fire, skip the LLM call entirely
  const syncResult = detectDistressSync(text);
  if (syncResult.detected) return syncResult;

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { detected: false, label: null, match: null };
  }
  const trimmed = text.trim();

  // MEDIUM tier — regex match + Haiku confirmation
  let mediumMatch: { label: string; match: string } | null = null;
  for (const { pattern, label } of MEDIUM_PATTERNS) {
    const m = trimmed.match(pattern);
    if (m) {
      mediumMatch = { label, match: m[0] };
      break;
    }
  }

  if (mediumMatch) {
    try {
      const { classifyDistressIntent } = await import(
        '@/lib/distress-classifier'
      );
      const classification = await classifyDistressIntent(trimmed);
      if (classification.confirmed) {
        return {
          detected: true,
          label: mediumMatch.label,
          match: mediumMatch.match,
          classifierReason: classification.reason
        };
      }
      // Classifier denied — not distress
      return {
        detected: false,
        label: null,
        match: null,
        classifierReason: classification.reason
      };
    } catch {
      // Fail-open on classifier error
      return {
        detected: false,
        label: null,
        match: null,
        classifierReason: 'classifier_error'
      };
    }
  }

  return { detected: false, label: null, match: null };
}
