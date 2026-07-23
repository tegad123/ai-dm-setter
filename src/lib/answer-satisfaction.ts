// ---------------------------------------------------------------------------
// answer-satisfaction.ts
// ---------------------------------------------------------------------------
// The SINGLE source of truth for "did this lead reply actually ANSWER the ask?"
// A leaf module (no project imports) so both script-state-recovery (step
// completion) and script-variable-resolver (variable binding) can share ONE
// hardened predicate instead of drifting copies — the divergence between them
// was itself a bug (the resolver's copy lagged the recovery module's fixes).
//
// F4/F3/F6 (2026-07-22 → 2026-07-23, full-pipeline research). The engine used to
// complete an ASK step and bind its variable on the FIRST lead reply after the
// ask, content-blind — so "how much does this cost" advanced the step AND was
// stored as the answer, and a deferral let an LLM fabricate a goal. This gate
// blocks that.
//
// Deterministic, no LLM. Conservative: defaults to TRUE (answers) for anything
// with real answer substance — including a statement that also asks something
// ("i want 5k a month, is that realistic?") — so it can never wrongly BLOCK a
// legitimate advance. Returns FALSE only for a CLEAR non-answer: a pricing/cost
// question, an explicit deferral, or a pure question-back with no answer clause.
// ---------------------------------------------------------------------------

export function replyAnswersAsk(reply: string | null | undefined): boolean {
  const t = (reply ?? '').trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase();
  const core = lower
    .replace(
      /^(and|but|so|ok(ay)?|yeah?|yes|yep|yup|nah?|nope|sure|hmm+|well|bro|man)[\s,]+/i,
      ''
    )
    .trim();

  // "Answer substance" — a first-person declarative clause, a number, a
  // duration, or a hedged quantity. If present the reply ANSWERS even if it
  // also asks something.
  const hasAnswerSubstance =
    /\b(i|we|my|i'?m|i'?ve|im|ive)\s+(want|wanna|need|make|makin|earn|been|have|got|do|did|am|feel|just|already|trade|traded|started|work|working|use|used)\b/i.test(
      core
    ) ||
    /\b\d/.test(core) ||
    /\b(a\s+)?(month|year|week|day)s?\b/i.test(core) ||
    /\b(enough|plenty|about|around|like|roughly|maybe)\s+\S/i.test(core);

  const deferral =
    /\b(hold up|hold on|before (you|we|send|sending|anything)|answer (me|my)|not (yet|now|ready)|why (do|would) (you|i) (need|have|wanna|gotta) (to )?(know|tell|answer|give)|dont send|don'?t send|not gonna (say|answer|tell))\b/i.test(
      lower
    ) || /^(wait|hold)\b/i.test(core);

  const pricingQuestion =
    /\b(how much (does|is|would|for|to)|what('?s| is) (the |your )?(price|cost)|does (it|this) cost|whats the price|how much is it|what(?:'|’)?s? the (damage|cost|price)|is (this|it) (free|paid|expensive))\b/i.test(
      lower
    ) || /^(price|cost)\??$/i.test(core);

  const startsInterrogative =
    /^(how|what|when|where|why|who|which|can|could|would|do|does|did|is|are|will|should|whats?|hows?)\b/i.test(
      core
    );
  const isPureQuestion =
    (core.endsWith('?') || startsInterrogative) &&
    core.split(/\s+/).length <= 20;

  // A concrete quantity/number/duration wins even over a deferral clause
  // ("not yet, but i've got 5k ready" answers the capital ask). A BARE deferral
  // has no such substance and still blocks.
  const hasConcreteAnswer =
    /\b\d/.test(core) ||
    /\b(a\s+)?(month|year|week|day)s?\b/i.test(core) ||
    /\b(enough|plenty|about|around|like|roughly|maybe)\s+\S/i.test(core);
  if (hasConcreteAnswer) return true;
  if (deferral) return false;
  if (pricingQuestion) return false;
  if (hasAnswerSubstance) return true;
  if (isPureQuestion) return false;
  return true;
}

// Convenience: given a message history, does the LATEST lead message fail to
// answer? Used by the variable resolver to block fabricated bindings when the
// lead just deferred/asked back.
export function latestLeadMessageIsNonAnswer(
  history: Array<{ sender?: string | null; content?: string | null }>
): boolean {
  const lastLead = [...history]
    .reverse()
    .find((m) => (m.sender ?? '').toUpperCase() === 'LEAD');
  if (!lastLead) return false;
  return !replyAnswersAsk(lastLead.content);
}
