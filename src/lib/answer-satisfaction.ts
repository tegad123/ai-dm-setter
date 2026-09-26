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

export function replyAnswersAsk(
  reply: string | null | undefined,
  ask?: string | null
): boolean {
  const t = (reply ?? '').trim();
  if (t.length === 0) return false;
  const lower = t.toLowerCase().replace(/[’‘]/g, "'");
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
    // Location replies commonly answer the setter and then ask the same
    // question back: "I'm based in Nairobi, Kenya, you?". The generic
    // interrogative check below used to classify those as pure questions,
    // leaving the script on the location step and making the next generation
    // repeat the greeting and location ask.
    /\b(i'?m|im|we'?re)\s+(?:currently\s+)?(?:based|located|living|staying)\b/i.test(
      core
    ) ||
    /\b(i|we)\s+(?:currently\s+)?(?:live|reside|stay)\s+(?:in|at|near)\b/i.test(
      core
    ) ||
    /\b(i'?m|im|we'?re)\s+(?:currently\s+)?(?:from|in|at|near)\s+\S/i.test(
      core
    ) ||
    /\b\d/.test(core) ||
    /\b(a\s+)?(month|year|week|day)s?\b/i.test(core) ||
    /\b(enough|plenty|about|around|like|roughly|maybe)\s+\S/i.test(core);

  const deferral =
    /\b(hold up|hold on|before (you|we|send|sending|anything|i pay|paying)|answer (me|my)|not (yet|now|ready)|why (do|would) (you|i) (need|have|wanna|gotta) (to )?(know|tell|answer|give)|dont send|don'?t send|not gonna (say|answer|tell))\b/i.test(
      lower
    ) || /^(wait|hold)\b/i.test(core);

  const pricingQuestion =
    /\b(how much (does|is|would|for|to)|what('?s| is) (the |your )?(price|cost)|does (it|this) cost|whats the price|how much is it|what(?:'|’)?s? the (damage|cost|price)|is (this|it) (free|paid|expensive))\b/i.test(
      lower
    ) || /^(price|cost)\??$/i.test(core);

  // "not yet" is normally a deferral. For an ask about whether the lead has
  // traded (including demo trading), "not yet, still learning" is a direct
  // answer to the offered alternative. Keep the exception tied to the ask so
  // the same reply cannot complete an unrelated capital or purchase step.
  if (
    ask &&
    /\b(?:trading anything|traded anything|demo|paper trad(?:e|ing)|started trading)\b/i.test(
      ask
    ) &&
    /^not yet\b/i.test(core) &&
    /\b(?:still|just)\s+(?:in\s+)?(?:learning|studying)\b/i.test(core) &&
    !pricingQuestion
  ) {
    return true;
  }

  const startsInterrogative =
    /^(how|what|when|where|why|who|which|can|could|would|do|does|did|is|are|will|should|whats?|hows?)\b/i.test(
      core
    );
  const isPureQuestion =
    (core.endsWith('?') || startsInterrogative) &&
    core.split(/\s+/).length <= 20;

  // A concise answer followed by a reciprocal question still answers the
  // setter. This also covers terse location replies such as "Nairobi, you?"
  // that do not include a first-person verb. Explicit deferrals and pricing
  // questions remain blocked below.
  const reciprocalQuestion = core.match(
    /^(.+?)[,;]?\s*(?:and\s+)?(?:you|u|wbu|hbu|what about you)\?$/i
  );
  const isPureReciprocalQuestion =
    /^(?:and\s+)?(?:you|u|wbu|hbu|what about you)\?$/i.test(core);
  const hasAnswerBeforeReciprocalQuestion =
    !!reciprocalQuestion?.[1]?.trim() &&
    !/^(how|what|when|where|why|who|which|can|could|would|do|does|did|is|are|will|should|whats?|hows?)\b/i.test(
      reciprocalQuestion[1].trim()
    );

  // A concrete quantity/number/duration wins even over a deferral clause
  // ("not yet, but i've got 5k ready" answers the capital ask). A BARE deferral
  // has no such substance and still blocks.
  const hasConcreteAnswer =
    /\b\d/.test(core) ||
    /\b(a\s+)?(month|year|week|day)s?\b/i.test(core) ||
    /\b(enough|plenty)\b/i.test(core) ||
    /\b(about|around|like|roughly|maybe)\s+(?:\$?\d|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple)\b/i.test(
      core
    );
  // A quantity inside a question is not an answer: "What does the $200
  // include?" must not complete the affordability step. Keep mixed replies
  // eligible when they also contain their own declarative answer clause,
  // such as "not yet, but I've got 5k ready".
  const hasIndependentAnswerClause =
    /^(?:(?:(?:about|around|roughly|maybe)\s+)?\$?\d|enough\b|plenty\b)/i.test(
      core
    ) ||
    /^(?:how|what)\s+about\s+\$?\d/i.test(core) ||
    /^(?:would|is)\s+\$?\d[\d,.]*(?:k|m)?\s+(?:be\s+)?enough\b/i.test(core) ||
    /(?:^|[.!?;,]\s*|\b(?:but|and)\s+)(?:i|we|i'?ve|we'?ve|ive)\s+(?:want|wanna|make|earn|have|got|can afford|can pay|can cover)\b/i.test(
      core
    ) ||
    /\bbut\s+(?:\$?\d|enough\b|plenty\b)/i.test(core);
  if (
    (startsInterrogative || deferral || pricingQuestion) &&
    hasConcreteAnswer &&
    !hasIndependentAnswerClause
  ) {
    return false;
  }
  if (hasConcreteAnswer) return true;
  if (deferral) return false;
  if (pricingQuestion) return false;
  if (isPureReciprocalQuestion) return false;
  if (hasAnswerBeforeReciprocalQuestion) return true;
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
