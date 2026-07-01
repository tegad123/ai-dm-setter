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

const HARD_PATTERNS: Signal[] = [
  // Direct suicidal ideation
  {
    pattern:
      /\b(give\s+up\s+on\s+life|end\s+it\s+all|kill\s+myself|want\s+to\s+die|wanna\s+die|gonna\s+die|going\s+to\s+die|wish\s+i\s+(was|were)\s+dead|take\s+my\s+(own\s+)?life|end\s+my\s+life)\b/i,
    label: 'direct_ideation'
  },
  {
    pattern: /\b(suicide|suicidal)\b/i,
    label: 'suicide_mention'
  },
  {
    pattern: /\b(self[-\s]?harm|hurt(ing)?\s+myself|harm(ing)?\s+myself)\b/i,
    label: 'self_harm'
  },
  {
    pattern:
      /\b(rather\s+be\s+dead|better\s+off\s+dead|don'?t\s+want\s+to\s+(live|be\s+here)|tired\s+of\s+living|not\s+worth\s+living|no\s+reason\s+to\s+live|what'?s\s+the\s+point\s+of\s+living)\b/i,
    label: 'indirect_ideation'
  },
  {
    pattern:
      /\b(nothing\s+left\s+to\s+live\s+for|can'?t\s+go\s+on|done\s+with\s+life|no\s+point\s+(in\s+)?going\s+on)\b/i,
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
}

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

/**
 * Full async scan — HARD + SOFT+combo (sync) then MEDIUM tier (Haiku confirm).
 * This is the function called by ai-engine.ts Layer 2 and webhook-processor.ts
 * Layer 1.
 */
export async function detectDistress(
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
