// ---------------------------------------------------------------------------
// voice-quality-gate.ts
// ---------------------------------------------------------------------------
// Post-generation quality scoring to enforce Daniel's texting voice.
// Runs on every AI response. Hard fails trigger regeneration.
// ---------------------------------------------------------------------------

export interface QualityResult {
  score: number; // 0.0 – 1.0
  passed: boolean;
  hardFails: string[];
  softSignals: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DANIEL_VOCAB = new Set([
  'bro',
  'g',
  'brotha',
  'man',
  'haha',
  'ahaha',
  'ahh',
  'damn',
  'fr',
  'tbh',
  'ye',
  'ngl',
  'gotchu',
  'lemme',
  'wanna',
  'gonna',
  'kinda',
  'gotta',
  'lotta',
  'fire',
  'sick',
  'bet',
  'fasho',
  'dialled',
  'dope',
  'tho',
  'nah',
  'yo',
  'yoo',
  'aight'
]);

const BANNED_PHRASES = [
  "i'm sorry to hear",
  'i understand that',
  'i understand how',
  'what specifically',
  'maybe i can help',
  "i'm here to listen",
  "i'm here for you",
  "i'd be happy to",
  'great question',
  "that's wonderful",
  "that's fantastic",
  "that's an excellent",
  'could you elaborate',
  'i appreciate you sharing',
  'let me explain',
  'allow me to',
  'it sounds like you',
  'i can certainly',
  'i completely understand',
  'that must be really',
  'that sounds really difficult'
];

const BANNED_WORDS = [
  'specifically',
  'ultimately',
  'essentially',
  'additionally',
  'furthermore',
  'therefore',
  'nevertheless',
  'consequently',
  'nonetheless'
];

// "however" only banned at sentence start (not mid-sentence like "however you want")
const BANNED_SENTENCE_STARTERS = ['however,', 'however '];

// Patterns that promise follow-up content ("I'll explain", "lemme show you").
// Exported because ai-engine uses them for promise-tracking across turns.
export const PROMISE_PATTERNS: RegExp[] = [
  /\bi['']ll explain\b/i,
  /\blemme explain\b/i,
  /\blet me explain\b/i,
  /\blet me show you\b/i,
  /\blemme show you\b/i,
  /\blet me tell you\b/i,
  /\blemme tell you\b/i,
  /\bi['']ll send you (something|a|the)\b/i,
  /\bhold up[.,]?\s*i['']ll\b/i,
  /\bgimme a sec\b/i,
  /\blemme break (it|this) down\b/i
];

/**
 * Check whether a message looks like an UNKEPT promise — a short cliffhanger
 * that promises content without delivering it. Used by ai-engine to detect
 * when the PREVIOUS AI turn made a promise that the next turn must fulfill.
 *
 * Returns the matched pattern if the message is a short unkept promise,
 * otherwise null. Uses the same 80-char threshold as the hard-fail gate.
 */
export function isUnkeptPromise(message: string): RegExp | null {
  if (!message || message.trim().length >= 80) return null;
  for (const pattern of PROMISE_PATTERNS) {
    if (pattern.test(message)) return pattern;
  }
  return null;
}

// Emojis that are NOT in Daniel's approved set (💪🏿 😂 🔥 💯 ❤) and
// have been observed slipping through in production. The gate hard-fails
// any reply containing one of these, forcing a retry. Keep this in sync
// with what the prompt tells the LLM is allowed.
const BANNED_EMOJIS = [
  '🙏',
  '👍',
  '🙂',
  '😊',
  '😄',
  '✨',
  '🎯',
  '✅',
  '📈',
  '💰',
  '🚀',
  '💡',
  '🌟',
  '👏',
  '🤝',
  '🤙', // "call me" hand — LLM kept using this despite not being in the set
  '🙌', // raised hands — same
  '💪' // without skin tone — Daniel uses 💪🏿 specifically
];

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

export interface VoiceQualityOptions {
  /**
   * When true, relax the 300-char length cap. Used when the turn is
   * delivering on a prior promise ("I'll explain") — explanations need
   * room to actually explain, so we allow up to 500 chars.
   */
  relaxLengthLimit?: boolean;
  /**
   * Opt-out for the R26 off-topic-advice regex. Defaults to false, which
   * means the gate blocks messages mentioning freelancing / Fiverr /
   * side-hustles / etc. — the AI is a sales setter for a specific
   * business, not a general wealth-building advisor. Set to true ONLY
   * for accounts whose actual business legitimately covers these topics
   * (a financial-literacy coach, a side-hustle teacher, etc.). Most
   * accounts should leave this false.
   */
  allowGeneralAdvice?: boolean;
}

export function scoreVoiceQuality(
  reply: string,
  options?: VoiceQualityOptions
): QualityResult {
  const hardFails: string[] = [];
  const softSignals: Record<string, number> = {};

  const lower = reply.toLowerCase();

  // ── Hard fail checks ────────────────────────────────────────────

  // 1. Banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      hardFails.push(`banned_phrase: "${phrase}"`);
    }
  }

  // 2. Banned words (full word match)
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(reply)) {
      hardFails.push(`banned_word: "${word}"`);
    }
  }

  // 3. Banned sentence starters
  const sentences = reply.split(/[.!?\n]+/).map((s) => s.trim().toLowerCase());
  for (const sentence of sentences) {
    for (const starter of BANNED_SENTENCE_STARTERS) {
      if (sentence.startsWith(starter)) {
        hardFails.push(`banned_starter: "However"`);
        break;
      }
    }
  }

  // 4. Banned emojis
  for (const emoji of BANNED_EMOJIS) {
    if (reply.includes(emoji) && !reply.includes(emoji + '\u{1F3FF}')) {
      // Allow 💪🏿 (with dark skin tone) but ban plain 💪
      hardFails.push(`banned_emoji: ${emoji}`);
    }
  }

  // 5. Em dash or en dash
  if (reply.includes('—')) {
    hardFails.push('em_dash');
  }
  if (reply.includes('–')) {
    hardFails.push('en_dash');
  }

  // 6. Semicolon
  if (reply.includes(';')) {
    hardFails.push('semicolon');
  }

  // 7. "lol" (Daniel uses "haha")
  if (/\blol\b/i.test(reply)) {
    hardFails.push('lol_instead_of_haha');
  }

  // 8. Message too long — 300 chars normally, 500 when relaxed (e.g., when
  // the turn is delivering on a prior promise and needs room to explain).
  const lengthCap = options?.relaxLengthLimit ? 500 : 300;
  if (reply.length > lengthCap) {
    hardFails.push(
      `message_too_long: ${reply.length} chars (cap ${lengthCap})`
    );
  }

  // 9. Cliffhanger preamble — a short message that promises follow-up
  // content without delivering it. Happens when the LLM generates a
  // voice-note intro ("My G! I'll explain") but the voice note never
  // gets attached (empty library, matcher miss, ElevenLabs fails). The
  // result is a standalone fragment that reads like the AI ghosted the
  // lead mid-thought.
  for (const cliffhangerPattern of PROMISE_PATTERNS) {
    if (cliffhangerPattern.test(reply)) {
      if (reply.trim().length < 80) {
        hardFails.push(
          `cliffhanger_preamble: matched "${cliffhangerPattern.source}" in ${reply.trim().length}-char message`
        );
        break;
      }
    }
  }

  // 9b. Bracketed placeholder leak — e.g. "[BOOKING LINK]", "[CALENDAR LINK]",
  // "[APPLICATION LINK]", "[HOMEWORK LINK]", "[LINK]", "[URL]", "[RESULTS
  // VIDEO]". These are LITERAL placeholder tokens the LLM learned from
  // training examples (persona breakdowns, script fragments). If one of them
  // reaches the lead, they see raw brackets in the message instead of a real
  // URL — a critical failure. Match any token of the form [A-Z][A-Z0-9 _]{2+}
  // enclosed in square brackets. We do NOT match single-char or lowercase
  // bracketed content (that can be legitimate formatting like [a] or [1]).
  const BRACKETED_PLACEHOLDER_REGEX = /\[[A-Z][A-Z0-9 _]{2,}\]/;
  const placeholderMatch = reply.match(BRACKETED_PLACEHOLDER_REGEX);
  if (placeholderMatch) {
    hardFails.push(
      `bracketed_placeholder_leaked: "${placeholderMatch[0]}" — LITERAL placeholder token in outgoing message, not a URL. If the script has no matching URL, use the script-driven handoff flow instead of a placeholder.`
    );
  }

  // 9c. R19 — fabricated action claims. The AI must NEVER claim to have taken
  // actions it didn't actually take. "Just sent the link", "just got your
  // booking", "just checked with the team", "email is on the way" — these are
  // all LIES when the system didn't actually perform those actions in this
  // turn. Violations degrade trust and can trigger lead confusion ("I never
  // got the email"). Observed pattern: conversation cmo38clid003tjp04wauomdtm
  // fired 4 fabrications on 2026-04-17. Prompt-only enforcement of R19 is
  // insufficient — this regex guard forces regeneration when the LLM slips.
  const FABRICATED_ACTION_PATTERNS: RegExp[] = [
    /\bjust (sent|got|checked|received|confirmed|grabbed|booked)\b/i,
    /\bjust (reached out|heard back|followed up)\b/i,
    /\bemail is on the way\b/i,
    /\blink is on the way\b/i,
    /\bjust saw (it|your)\b/i,
    /\bsent (the|it|this) (link|email|zoom)\b/i,
    /\bi (just )?received your\b/i,
    /\bi can see your (booking|email|payment|signup)\b/i
  ];
  for (const pat of FABRICATED_ACTION_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `r19_fabricated_action: matched "${pat.source}" — claims an action the system did not actually perform`
      );
      break;
    }
  }

  // 9d. R19 EXTENSION — fabricated FUTURE plans/releases. Mirror of 9c in
  // the forward direction. Production example: lead asked "is part 2 of
  // the video out?" and the AI invented "part 2 is in the works, stay
  // tuned" with zero context support. Unless the persona/script/campaigns
  // context explicitly describes an upcoming release, the AI must not
  // claim one. These phrases can be legitimate in narrow cases (e.g.
  // confirming a booked call is "coming up soon"), but the gate is
  // worth the occasional forced regeneration — the regen will pick
  // non-fabricated wording that still conveys any real meaning.
  const FABRICATED_FUTURE_PLAN_PATTERNS: RegExp[] = [
    /\bin the works\b/i,
    /\bcoming soon\b/i,
    /\bstay tuned\b/i,
    /\bdropping soon\b/i,
    /\bnext month\b/i,
    /\bnext week\b/i,
    /\bvery soon\b/i,
    /\baround the corner\b/i
  ];
  for (const pat of FABRICATED_FUTURE_PLAN_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `r19_fabricated_future_plan: matched "${pat.source}" — claims an upcoming release / feature / plan not supported by context`
      );
      break;
    }
  }

  // 9e. R26 — off-topic life/career/side-hustle advice. The AI is a sales
  // setter for the account owner's SPECIFIC business, not a general
  // wealth-building advisor. Real production example: when a lead said
  // they couldn't afford the mentorship, the AI started recommending
  // Fiverr freelancing and flipping items from thrift stores. That's
  // not what the account owner does; it wastes LLM budget and trains
  // leads to expect free coaching from the account.
  //
  // The persona-level `allowGeneralAdvice` flag bypasses this guard
  // (e.g. for a legit financial-literacy coach). Default = enforce.
  if (!options?.allowGeneralAdvice) {
    const OFF_TOPIC_ADVICE_PATTERNS: RegExp[] = [
      /\bside[\s-]?hustle(s|)\b/i,
      /\bflip(ping)?\s+(items|stuff|products|goods)\b/i,
      /\bFiverr\b/i,
      /\bUpwork\b/i,
      /\bfreelanc(e|ing|er)\b/i,
      /\bthrift\s+store(s|)\b/i,
      /\bgarage\s+sale(s|)\b/i,
      /\beBay\b/i,
      /\bFacebook\s+Marketplace\b/i,
      /\b(make|earn|build)\s+extra\s+(income|cash|money)\b/i
    ];
    for (const pat of OFF_TOPIC_ADVICE_PATTERNS) {
      if (pat.test(reply)) {
        hardFails.push(
          `r26_offtopic_advice: matched "${pat.source}" — AI drifted into general wealth-building / side-hustle advice outside the account owner's lane`
        );
        break;
      }
    }
  }

  // 9f. CTA mechanism leak — the active_campaigns prompt block asks the
  // AI to RECOGNISE a lead coming from a campaign and respond naturally,
  // not announce the matching mechanism. A real production failure had
  // the AI emit "welcome, my G! since you sent the word 'market', I'll
  // hook you up with some free insights. here's a link to get
  // started:..." — four violations in one message: it quoted the keyword,
  // over-narrated the link drop, used a corporate "welcome" opener, and
  // wall-of-texted everything into a single turn.
  //
  // These patterns hard-fail the obvious leaks. Not exhaustive (the LLM
  // can paraphrase), but catches the 80%+ shape of the failure mode.
  // Always on — no persona opt-out, because no legitimate account wants
  // the AI to quote the lead's keyword or open with "welcome".
  const CTA_MECHANISM_LEAK_PATTERNS: RegExp[] = [
    // "since you sent 'market'" / "since you typed the keyword"
    /\bsince\s+you\s+(sent|typed|wrote|used|messaged|dropped|commented)\s+(the\s+)?(word|keyword|magic\s+word|phrase|comment)\b/i,
    /\bsince\s+you\s+(sent|typed|wrote|dropped|commented)\s+['"\u2018\u2019\u201C\u201D][^'"\u2018\u2019\u201C\u201D]{1,40}['"\u2018\u2019\u201C\u201D]/i,
    // "you used the magic word" / "you said the keyword"
    /\byou\s+(used|said|sent|typed)\s+the\s+(magic\s+word|keyword|code\s+word|trigger\s+word)/i,
    // "I'll hook you up with some (free) insights/content/breakdown/video"
    /\bI'?ll\s+hook\s+you\s+up\s+with\s+(some\s+|a\s+|the\s+)?(free\s+)?(insights?|content|breakdown|info|video|training|resource)/i,
    // "here's a link to get started" / "here's the link to get you started"
    /\bhere'?s\s+(a|the)\s+link\s+to\s+get\s+(started|you\s+started)/i,
    // "thanks for reaching out via (the/my) campaign/post/story"
    /\bthanks\s+for\s+reaching\s+out\s+(via|through)\s+(the|my)\s+(campaign|story|post|content)/i,
    // Corporate opener at start of message
    /^(welcome\s+(my\s+g|to\s+the|aboard|in)|welcome[,!]|hey\s+there[,!]|greetings)/i
  ];
  for (const pat of CTA_MECHANISM_LEAK_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `cta_mechanism_leak: matched "${pat.source}" — AI exposed the campaign matching mechanism or used a corporate onboarding opener instead of recognising the lead naturally`
      );
      break;
    }
  }

  // 9g. CTA acknowledgment-only truncation check moved out of
  // scoreVoiceQuality and into scoreVoiceQualityGroup (see
  // checkCtaAckOnlyTruncation below). Rationale: when a multi-bubble
  // response splits the acknowledgment and the question across bubbles,
  // bubble 0 alone would false-fire this check. The correct check
  // operates on the CONCATENATED group so a legit split passes. For
  // single-message (flag-off) calls, the group wrapper still fires this
  // check over the one-element array, so single-message accounts see
  // identical behaviour to the pre-multi-bubble state.

  // 10b. Fabricated time-slot proposal — the booking flow is script-driven:
  // the AI sends the booking link from the script and the lead picks their
  // own time. The AI must NOT propose specific day+time combinations.
  // Hallucinated slots like "Monday at 2 PM" are a critical failure (R14)
  // because we have no way to guarantee the time is available and the
  // system isn't going to book it automatically.
  // Matches patterns like "Monday at 2 PM", "Tuesday 10am", "Friday at 4
  // PM CST", "tomorrow at 3pm", and the lead-in phrase "here are a couple
  // of slots".
  const TIME_SLOT_PATTERNS: RegExp[] = [
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
    /\b(tomorrow|today)\s+(at\s+)?\d{1,2}(:\d{2})?\s*(am|pm)\b/i,
    /\bhere are (a|some|2|3|two|three) (couple of )?slots?\b/i,
    /\bchoose from\b.*\b\d{1,2}\s*(am|pm)\b/i,
    /\b(which|what) (one|time|slot) works (best|better)\b/i
  ];
  for (const pat of TIME_SLOT_PATTERNS) {
    if (pat.test(reply)) {
      hardFails.push(
        `fabricated_time_slot: matched "${pat.source}" — booking is script-driven, don't propose specific times`
      );
      break;
    }
  }

  // 10. Title-case opener — Daniel's voice starts messages in lowercase.
  // "That's smart thinking bro" breaks the voice; "that's smart thinking bro"
  // keeps it. Only fires on the first alphabetic character — inside the
  // message proper nouns (names, FTMO) stay capitalized. Exceptions:
  //   - "I" as a standalone pronoun ("I feel you")
  //   - ALL-CAPS first word of <=3 chars ("OMG", "WYD", "IMO")
  const firstCharMatch = reply.trim().match(/[A-Za-z]/);
  if (
    firstCharMatch &&
    firstCharMatch.index !== undefined &&
    reply.trim().length >= 3
  ) {
    const ch = firstCharMatch[0];
    const firstWord = reply
      .trim()
      .slice(firstCharMatch.index)
      .split(/\s+/)[0]
      .replace(/[^A-Za-z]/g, '');
    const isAllCapsShort =
      firstWord.length > 0 &&
      firstWord.length <= 3 &&
      firstWord === firstWord.toUpperCase();
    const isStandaloneI = firstWord === 'I';
    if (
      ch === ch.toUpperCase() &&
      ch !== ch.toLowerCase() &&
      !isAllCapsShort &&
      !isStandaloneI
    ) {
      hardFails.push(
        `title_case_opener: starts with "${firstWord}" — voice requires lowercase openers`
      );
    }
  }

  // ── Soft scoring ────────────────────────────────────────────────

  // R27 — third-party capability claim detection (soft signal, NOT a
  // hard fail). Unlike R19 fabrications which have tight surface
  // patterns, R27 violations are open-ended factual assertions
  // ("Anthony speaks German", "we have 24/7 support", "the course
  // covers options"). Regex can't reliably catch every variant —
  // primary enforcement is at the prompt level (R27). These patterns
  // just flag the message for prioritised operator review so Daniel
  // can verify whether the claim was accurate and, if not, log a
  // correction + expand the persona's verifiedDetails block.
  //
  // We log to softSignals with 0 score impact so the quality gate
  // still passes (the message might be a legitimate citation of a
  // verifiedDetails entry), but the signal surfaces in downstream
  // analytics. The End-of-Day Review (future) queries on these keys.
  const R27_SOFT_PATTERNS: RegExp[] = [
    // Closer / team capability assertion: "<proper noun> <capability verb>"
    /\b(he|she|they|the team|the coach|the closer|our team|my team)\s+(speaks|offers|has|handles|works|gives|provides|covers|supports)\b/i,
    // Universal availability / language claims
    /\b(24\/7|any\s?time|anytime|any\s+time\s?zone|any\s+timezone|all\s+languages|every\s+language|in\s+any\s+language)\b/i,
    // Product/offer content claim: "we/the course/the program includes X"
    /\b(we|the\s+(?:course|program|mentorship|offer|package))\s+(includes?|covers?|offers?|guarantees?)\b/i,
    // Refund / guarantee fabrication: "30-day guarantee", "money-back"
    /\b\d+[\s-]?day\s+(money[\s-]?back|refund|guarantee|trial)\b/i,
    /\bmoney[\s-]?back\s+guarantee\b/i,
    // Credential invention: "<name> has a <noun> background"
    /\bhas\s+(a|an)\s+\w+\s+(background|degree|certification|license)\b/i
  ];
  let r27SoftCount = 0;
  for (const pat of R27_SOFT_PATTERNS) {
    if (pat.test(reply)) r27SoftCount++;
  }
  // NOT added to softSignals — that record feeds into the rawScore sum,
  // and a legit citation of a verifiedDetails entry shouldn't unfairly
  // lower an otherwise-good message's score. R27's enforcement is at the
  // prompt level; these patterns just surface borderline claims via
  // Vercel logs for operator audit. End-of-Day Review (future) can grep
  // for this log prefix or we can persist to a dedicated table if/when
  // the review queue ships.
  if (r27SoftCount > 0) {
    console.warn(
      `[voice-quality-gate] R27 soft signal fired ${r27SoftCount}x on reply (possible third-party fabrication): "${reply.slice(0, 120)}"`
    );
  }

  // Under 200 chars
  if (reply.length <= 200) {
    softSignals.short_message = 1.0;
  } else if (reply.length <= 250) {
    softSignals.short_message = 0.5;
  } else {
    softSignals.short_message = 0;
  }

  // Contains Daniel vocab
  const words = lower.split(/\s+/);
  const hasVocab = words.some((w) =>
    DANIEL_VOCAB.has(w.replace(/[^a-z]/g, ''))
  );
  softSignals.has_daniel_vocab = hasVocab ? 1.0 : 0;

  // Sentence count (2 or fewer = good)
  const sentenceCount = reply
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0).length;
  if (sentenceCount <= 2) {
    softSignals.short_sentences = 1.0;
  } else if (sentenceCount <= 3) {
    softSignals.short_sentences = 0.5;
  } else {
    softSignals.short_sentences = 0;
  }

  // Starts with lowercase (Daniel's style)
  if (reply.length > 0 && reply[0] === reply[0].toLowerCase()) {
    softSignals.lowercase_start = 0.5;
  } else {
    softSignals.lowercase_start = 0;
  }

  // Uses approved emoji
  const approvedEmojis = ['💪🏿', '😂', '🔥', '💯', '❤'];
  const hasApprovedEmoji = approvedEmojis.some((e) => reply.includes(e));
  softSignals.approved_emoji = hasApprovedEmoji ? 0.5 : 0;

  // ── R22 SOFT SIGNAL: stall-acceptance detection ─────────────────
  // Daniel's R22 (timing objections must be pinned, not accepted)
  // policy. Detect AI replies that let the lead walk away with
  // zero commitment ("hit me up when ready", "I'm here when you
  // need", "reach out whenever", "take your time"). These phrases
  // mean the conversation is ending without a follow-up anchor and
  // — empirically — those leads don't come back.
  //
  // Scored as a soft penalty (-0.3) rather than a hard fail:
  //   - The exact wording sometimes appears legitimately AFTER a
  //     lead has actually committed to a follow-up time, in which
  //     case context (not pattern alone) determines validity.
  //   - We want to accumulate signal in production before
  //     escalating to hard-fail status. -0.3 is enough to push a
  //     borderline reply (~0.7 score) under the 0.7 pass threshold
  //     when combined with other soft losses, but not enough to
  //     unilaterally fail an otherwise-clean reply.
  //
  // If this flags too many false positives in production logs,
  // tighten the regex; if it's reliable, upgrade to hard-fail.
  const stallAcceptancePatterns: RegExp[] = [
    /\bhit\s+me\s+up\s+when(\s+you'?re|\s+u'?re)?\s+ready\b/i,
    /\blet\s+me\s+know\s+when(\s+you'?re|\s+u'?re)?\s+ready\b/i,
    /\b(i'?m|im)\s+here\s+when\s+you\s+need\b/i,
    /\breach\s+out\s+whenever\b/i,
    /\bhit\s+me\s+up\s+whenever\b/i,
    /\btake\s+your\s+time\s+bro\b/i,
    /\bno\s+rush\s+(bro|man)?,?\s+(hit|reach|let)/i,
    /\bjust\s+let\s+me\s+know\s+when\s+you'?re\s+ready\b/i,
    /\b(i'?m|im)\s+here\s+whenever\s+you'?re\s+ready\b/i
  ];
  const stallAcceptanceMatched = stallAcceptancePatterns.some((p) =>
    p.test(reply)
  );
  if (stallAcceptanceMatched) {
    // Negative value — subtracts from rawScore. Tracked under a
    // distinct key so analytics can count fires over time.
    softSignals.r22_stall_acceptance = -0.3;
  }

  // ── R28 SOFT SIGNAL: free-resources mentioned without a URL ─────
  // Daniel's R28 (downsell-then-free-resources, with URL inline)
  // policy. When the AI references "my channel", "my yt", "free
  // content", "videos on my page" etc. WITHOUT a URL in the same
  // reply, the lead is being told to go searching for the resource.
  // Empirically they don't — naming the channel without dropping
  // the link is the same as not sending the resource at all. The
  // R22 free-resources rule (don't ask permission) already says
  // "just send it"; this signal catches the variant where the AI
  // thinks it's sending the resource by namechecking the channel
  // but never includes the URL.
  //
  // Scored as a soft penalty (-0.3) so the gate doesn't false-fire
  // on legitimate mentions like "we'll have content on the channel
  // soon" — those are rare. If the production logs show this is
  // reliable, upgrade to hard-fail.
  const hasUrl = /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(reply);
  const channelMentionPatterns: RegExp[] = [
    /\bcheck\s+out\s+(my|the|our|some)\s+(channel|resources|free\s+content|videos|yt|youtube)\b/i,
    /\bgo\s+(check|look|see)\s+(out\s+)?(my|the|our)\s+(channel|yt|youtube|resources|videos)\b/i,
    /\bi\s+(have|got)\s+some\s+(free\s+)?(resources|videos|content)\s+(for\s+you|to\s+share)?\b/i,
    /\b(my|the|our)\s+(yt|youtube)\s+(channel\s+)?(has|got)\b/i,
    /\bon\s+(my|the|our)\s+(channel|yt|youtube|page)\b/i
  ];
  const channelMentioned = channelMentionPatterns.some((p) => p.test(reply));
  if (channelMentioned && !hasUrl) {
    softSignals.r28_free_resources_no_link = -0.3;
  }

  // ── Calculate final score ───────────────────────────────────────
  const maxScore = 4.0; // 1 + 1 + 1 + 0.5 + 0.5 (emoji is bonus, not required)
  const rawScore = Object.values(softSignals).reduce((a, b) => a + b, 0);
  // Clamp to [0, 1] — the R22 negative penalty can push rawScore
  // below 0 on otherwise-empty replies; a negative score is
  // meaningless to downstream consumers and breaks the >= 0.7
  // pass threshold semantics.
  const score = Math.max(0, Math.min(1.0, rawScore / maxScore));

  return {
    score,
    passed: hardFails.length === 0 && score >= 0.7,
    hardFails,
    softSignals
  };
}

// ---------------------------------------------------------------------------
// Multi-bubble group scorer
// ---------------------------------------------------------------------------
// Wraps scoreVoiceQuality per-bubble and adds two group-level checks that
// must evaluate the joined string rather than each bubble independently:
//
//   1. cta_acknowledgment_only_truncation — a legitimate 2-bubble split
//      like ["yo bro caught the story 💪🏿", "what got you into trading?"]
//      has bubble-0 that matches the ack-only pattern but the group has a
//      "?" and is long enough. Running per-bubble would false-fire.
//
//   2. cliffhanger / isUnkeptPromise — a cliffhanger in a non-final bubble
//      is fine when a follow-on bubble fulfils it. isUnkeptPromise is only
//      interesting CROSS-TURN (did the previous turn's last bubble stall
//      the conversation) — that check stays in ai-engine.ts using the
//      last bubble. Inside a single turn, mid-group cliffhangers are OK.
//
// Everything else (R19/R22/R24/R26/R27, CTA mechanism leak, banned phrases,
// em-dashes, emoji, length) is per-bubble: any bubble with a violation
// fails the whole group. Individual hardFails are prefixed with [bubble=N]
// so the retry directive can tell the LLM which bubble to fix.
//
// Legacy single-message callers (flag-off path) pass [reply] and see
// byte-identical behaviour — the concatenated-group check sees the same
// string the per-bubble check would have.

const CTA_ACKNOWLEDGMENT_ONLY_PATTERNS: RegExp[] = [
  /\bcaught\s+(the|your)\s+(story|post|content|ad|video|drop|ig|instagram|vid|yt|youtube|reel)\b/i,
  /\bsliding\s+through\b/i,
  /\bappreciate\s+you\s+(sliding|reaching|messaging|pulling\s+up)\b/i,
  /\bsaw\s+you\s+through\s+the\s+(content|post|story|video|ad|reel)\b/i,
  /\bcaught\s+your\s+(message|dm|post|comment)\b/i,
  /\bglad\s+you\s+(reached\s+out|slid\s+through|messaged)\b/i
];

/**
 * Returns a hardFail reason string if the joined group is a stalled
 * acknowledgment (short + no `?` + matches an opener pattern). Returns
 * null if the group is fine. Operates on the concatenated string so
 * multi-bubble splits don't false-fire.
 */
function checkCtaAckOnlyTruncation(joinedText: string): string | null {
  const trimmed = joinedText.trim();
  if (trimmed.length >= 80) return null;
  if (trimmed.includes('?')) return null;
  for (const pat of CTA_ACKNOWLEDGMENT_ONLY_PATTERNS) {
    if (pat.test(trimmed)) {
      return `cta_acknowledgment_only_truncation: matched "${pat.source}" — reply is a short campaign acknowledgment with no qualifying question; the conversation stalls. Every campaign-matched reply MUST end with a forward-moving question in the same "message" field.`;
    }
  }
  return null;
}

export interface GroupQualityResult {
  /** Worst (minimum) per-bubble score. */
  score: number;
  /** All bubbles passed individually AND group-level checks passed. */
  passed: boolean;
  /** All hard-fail reasons, prefixed with [bubble=N] for per-bubble issues. */
  hardFails: string[];
  /** Per-bubble soft signals, flattened. */
  softSignals: Record<string, number>;
  /** Per-bubble individual results — useful for tests / diagnostics. */
  perBubble: QualityResult[];
}

export function scoreVoiceQualityGroup(
  messages: string[],
  options?: VoiceQualityOptions
): GroupQualityResult {
  if (messages.length === 0) {
    return {
      score: 0,
      passed: false,
      hardFails: ['empty_group: messages array is empty'],
      softSignals: {},
      perBubble: []
    };
  }

  // Hard fails: per-bubble. A banned phrase anywhere fails the group.
  // Exception: cliffhanger_preamble ("I'll explain", "lemme break it
  // down", etc.) in a non-final bubble is fine when a follow-on bubble
  // fulfills the promise in the same turn — that's the whole point of
  // splitting. Suppress that specific failure when the bubble isn't
  // last. On the FINAL bubble, cliffhanger still fires (the turn would
  // genuinely stall).
  const perBubble: QualityResult[] = messages.map((bubble) =>
    scoreVoiceQuality(bubble, options)
  );
  const lastIndex = messages.length - 1;
  const hardFails: string[] = [];
  perBubble.forEach((r, i) => {
    for (const failure of r.hardFails) {
      if (i !== lastIndex && failure.startsWith('cliffhanger_preamble:')) {
        continue; // follow-on bubble fulfills this — legit split
      }
      hardFails.push(`[bubble=${i}] ${failure}`);
    }
  });

  // Group-level ack-only check on the concatenated string — catches the
  // "yo bro caught the story 💪🏿" stall without false-firing on legit
  // multi-bubble splits where bubble 1 carries the question.
  const joined = messages.join(' ');
  const ackFailure = checkCtaAckOnlyTruncation(joined);
  if (ackFailure) {
    hardFails.push(`[group] ${ackFailure}`);
  }

  // Voice quality score: evaluate the JOINED turn, NOT per-bubble.
  // Per-bubble scoring is too strict — a legitimate split like
  // ["yo bro caught the story 💪🏿", "what got you into trading?"] has
  // a pure-question bubble 1 with no Daniel vocab that scores below
  // the 0.7 threshold on its own, even though the full turn reads
  // like Daniel. Scoring the concatenation preserves single-message
  // semantics for flag-off accounts (joined one-element array is the
  // same string) and handles the multi-bubble case correctly.
  const joinedQuality = scoreVoiceQuality(joined, options);
  const softSignals = joinedQuality.softSignals;
  const score = joinedQuality.score;

  return {
    score,
    // Pass iff no hard fails AND the joined turn clears the soft-score
    // threshold. joinedQuality.passed already encodes both its own
    // hardFails-empty and score>=0.7, but we've pulled hardFails out
    // to per-bubble tagging so recompute the soft-only gate here.
    passed: hardFails.length === 0 && score >= 0.7,
    hardFails,
    softSignals,
    perBubble
  };
}
