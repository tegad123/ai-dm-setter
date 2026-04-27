import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { buildDynamicSystemPrompt, getPromptVersion } from '@/lib/ai-prompts';
import type { LeadContext } from '@/lib/ai-prompts';
import { getCredentials } from '@/lib/credential-store';
import { retrieveFewShotExamples } from '@/lib/training-example-retriever';
import {
  containsCapitalQuestion,
  containsIncomeGoalQuestion,
  scoreVoiceQualityGroup,
  isUnkeptPromise
} from '@/lib/voice-quality-gate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMessage {
  id: string;
  sender: string; // 'LEAD' | 'AI' | 'HUMAN'
  content: string;
  timestamp: Date | string;
  isVoiceNote?: boolean;
  imageUrl?: string | null;
  hasImage?: boolean;
}

type LLMTextContentPart = {
  type: 'text';
  text: string;
};

type LLMImageContentPart = {
  type: 'image_url';
  image_url: {
    url: string;
    detail: 'low';
  };
};

type LLMContentPart = LLMTextContentPart | LLMImageContentPart;
type LLMMessageContent = string | LLMContentPart[];
type LLMMessage = {
  role: 'user' | 'assistant';
  content: LLMMessageContent;
};

/**
 * R24 capital-verification outcome for the current turn — exposed so
 * the webhook-processor can drive the `Lead.stage` update from the
 * gate result instead of blindly mapping conversation-stage names.
 *
 *  - `passed`: lead's stated amount meets or exceeds the threshold
 *    (or confirmed affirmative on a threshold-confirming Q).
 *  - `failed`: lead disqualified on capital (stated below threshold
 *    or hit a disqualifier phrase like "broke" / "jobless").
 *  - `hedging`: lead hedged without a concrete number — wait for it.
 *  - `ambiguous`: lead's reply didn't parse — wait for clarification.
 *  - `not_asked`: verification Q wasn't found in history (or asked
 *    but not yet answered) — not enough signal to classify.
 *  - `not_evaluated`: R24 wasn't evaluated this turn (no threshold
 *    configured, or this turn wasn't routing to booking handoff).
 */
export type CapitalOutcome =
  | 'passed'
  | 'failed'
  | 'hedging'
  | 'ambiguous'
  | 'not_asked'
  | 'not_evaluated';

export interface GenerateReplyResult {
  reply: string;
  /**
   * Multi-bubble output. Always a populated array — single-message
   * responses appear as `[reply]` (backward compat). When the persona
   * has multiBubbleEnabled=true AND the LLM emits messages[], this
   * contains 2-4 ordered bubbles that sendAIReply delivers as
   * separate platform sends.
   */
  messages: string[];
  format: 'text' | 'voice_note';
  stage: string;
  subStage: string | null;
  stageConfidence: number;
  sentimentScore: number;
  experiencePath: string | null;
  objectionDetected: string | null;
  stallType: string | null;
  affirmationDetected: boolean;
  followUpNumber: number | null;
  softExit: boolean;
  /** R20: AI has detected it's stuck in a loop or can't resolve — hand off to a human. */
  escalateToHuman: boolean;
  // Booking-stage extracted fields (Stage 7)
  leadTimezone: string | null;
  selectedSlotIso: string | null;
  leadEmail: string | null;
  suggestedTag: string;
  suggestedTags: string[];
  shouldVoiceNote: boolean;
  voiceNoteAction: { slot_id: string } | null;
  qualityScore: number;
  suggestedDelay: number;
  systemPromptVersion: string;
  // Closed-loop training
  suggestionId: string | null;
  /**
   * R24 gate outcome for the CURRENT turn. Used by the delivery layer
   * to set `Lead.stage` correctly — a `failed` outcome routes the lead
   * to UNQUALIFIED, `passed` unlocks QUALIFIED, everything else keeps
   * the lead's prior stage (reaching FINANCIAL_SCREENING without
   * passing should NOT promote to QUALIFIED).
   */
  capitalOutcome: CapitalOutcome;
  /**
   * Layer 2 safety net: the last LEAD message matched the distress
   * detector. When true, sendAIReply MUST abort the normal ship path
   * and route through the distress / supportive response flow
   * instead (flip aiActive=false, flag the conversation, notify the
   * operator, ship a dedicated non-sales message via Haiku). Layer 1
   * (webhook-processor pre-generation gate) normally catches this —
   * Layer 2 is the backstop for race conditions, retried webhooks, or
   * any future entry point that bypasses Layer 1.
   */
  distressDetected?: boolean;
  distressMatch?: string | null;
  distressLabel?: string | null;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Generate an AI reply for a conversation.
 *
 * @param accountId - The account ID (for persona + credential lookup)
 * @param conversationHistory - Full ordered message history
 * @param leadContext - Lead metadata for prompt personalization
 */
export async function generateReply(
  accountId: string,
  conversationHistory: ConversationMessage[],
  leadContext: LeadContext,
  scoringContext?: string
): Promise<GenerateReplyResult> {
  // 0. Extract the last lead message for few-shot retrieval
  const lastLeadMsg = [...conversationHistory]
    .reverse()
    .find((m) => m.sender === 'LEAD');

  // 0a. LAYER 2 SAFETY NET — distress detection on the last LEAD
  // message. Layer 1 (webhook-processor.ts pre-generation gate) is the
  // primary defense; this fires when Layer 1 was somehow bypassed
  // (retried webhook, race condition with a cron-fired ScheduledReply
  // that predates the lead's new message, or any future code path
  // that enters generateReply without going through processIncomingMessage).
  // On detection we short-circuit — no LLM call, no retry loop. Return
  // a sentinel result with `distressDetected: true` so sendAIReply
  // aborts normal delivery and routes through the supportive response
  // flow (identical to Layer 1's path). This wastes zero tokens and
  // guarantees a distress message can never receive a sales reply.
  if (lastLeadMsg) {
    try {
      const { detectDistress } = await import('@/lib/distress-detector');
      const distress = detectDistress(lastLeadMsg.content);
      if (distress.detected) {
        console.warn(
          `[ai-engine] LAYER 2 distress detected — aborting generation. label=${distress.label} match="${distress.match}"`
        );
        return {
          reply: '',
          messages: [],
          format: 'text',
          stage: '',
          subStage: null,
          stageConfidence: 0,
          sentimentScore: 0,
          experiencePath: null,
          objectionDetected: null,
          stallType: null,
          affirmationDetected: false,
          followUpNumber: null,
          softExit: false,
          escalateToHuman: true,
          leadTimezone: null,
          selectedSlotIso: null,
          leadEmail: null,
          suggestedTag: '',
          suggestedTags: [],
          shouldVoiceNote: false,
          voiceNoteAction: null,
          qualityScore: 0,
          suggestedDelay: 0,
          systemPromptVersion: 'distress-layer2',
          suggestionId: null,
          capitalOutcome: 'not_evaluated',
          distressDetected: true,
          distressMatch: distress.match,
          distressLabel: distress.label
        };
      }
    } catch (err) {
      // Detection errors must NEVER block normal generation. The Layer 1
      // gate in webhook-processor.ts already caught anything critical
      // at the entry point. Log loudly and continue.
      console.error(
        '[ai-engine] Layer 2 distress detector threw (non-fatal, continuing):',
        err
      );
    }
  }

  // 0b. Retrieve few-shot examples from training data (non-fatal)
  //     Uses metadata-filtered 3-tier retrieval when context is available.
  let fewShotBlock: string | null = null;
  let detectedIntent: string | undefined;
  if (lastLeadMsg) {
    try {
      // Classify intent for metadata-aware retrieval (non-fatal)
      try {
        const { classifyContentIntent } = await import(
          '@/lib/content-intent-classifier'
        );
        const intentResult = await classifyContentIntent(
          accountId,
          lastLeadMsg.content,
          conversationHistory
            .slice(-5)
            .map((m) => `${m.sender}: ${m.content}`)
            .join('\n')
        );
        if (intentResult?.intent) {
          detectedIntent = intentResult.intent;
        }
      } catch {
        // Intent classification is optional — continue without it
      }

      fewShotBlock = await retrieveFewShotExamples({
        accountId,
        currentLeadMessage: lastLeadMsg.content,
        leadStage: leadContext.status,
        leadExperience: leadContext.experience,
        detectedIntent,
        conversationHistory: conversationHistory.slice(-5).map((m) => m.content)
      });
    } catch (err) {
      console.error('[ai-engine] Few-shot retrieval failed (non-fatal):', err);
    }
  }

  // 1. Build the dynamic system prompt with few-shot examples
  // Prior AI-side messages drive the "links already sent" context
  // block so the LLM doesn't resend the same URL when the lead asks
  // for "another video". Pass full history (no slice) — dedup + most-
  // recent-wins selection happens inside buildDynamicSystemPrompt.
  const priorAIMessages = conversationHistory
    .filter((m) => m.sender === 'AI')
    .map((m) => ({ content: m.content, timestamp: m.timestamp }));
  // Souljah J 2026-04-25 — Fix 3 + Fix 4 inputs.
  const priorHumanMessages = conversationHistory
    .filter((m) => m.sender === 'HUMAN')
    .map((m) => ({ content: m.content, timestamp: m.timestamp }));
  const conversationCurrency: 'GBP' | 'USD' = conversationHistory.some(
    (m) => m.sender === 'LEAD' && m.content.includes('£')
  )
    ? 'GBP'
    : 'USD';
  // Rodrigo Moran 2026-04-26 — when conversation has gotten long enough
  // for the LLM to start losing facts buried in the middle, extract a
  // tight bullet block of established facts from LEAD-side messages and
  // prepend it to the prompt. Threshold of 20 total messages is empirical
  // — short conversations don't need it (the chat history is already
  // small enough for the model to track), and long ones empirically
  // exhibit re-asks past that mark.
  const ESTABLISHED_FACTS_MIN_MESSAGES = 20;
  let establishedFactsBlock: string | null = null;
  if (conversationHistory.length >= ESTABLISHED_FACTS_MIN_MESSAGES) {
    try {
      const { extractEstablishedFacts, buildEstablishedFactsBlock } =
        await import('@/lib/conversation-facts');
      const leadMessagesContent = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .map((m) => ({ content: m.content }));
      const facts = extractEstablishedFacts(leadMessagesContent);
      establishedFactsBlock = buildEstablishedFactsBlock(
        facts,
        leadContext.leadName ?? null
      );
    } catch (err) {
      console.error(
        '[ai-engine] established-facts extraction failed (non-fatal):',
        err
      );
    }
  }
  let systemPrompt = await buildDynamicSystemPrompt(
    accountId,
    leadContext,
    fewShotBlock || undefined,
    priorAIMessages,
    priorHumanMessages,
    conversationCurrency,
    establishedFactsBlock
  );

  // 1b. Append scoring intelligence if available
  if (scoringContext) {
    systemPrompt += '\n\n' + scoringContext;
  }

  // 1c. Promise-tracking: if the last AI turn was an unkept promise
  // (e.g., "My G! I'll explain" with nothing that followed), the LLM
  // must deliver on that promise this turn before advancing the funnel.
  // This fires regardless of voice note availability — it's about
  // conversational continuity, not voice notes specifically.
  const lastAiMsg = [...conversationHistory]
    .reverse()
    .find((m) => m.sender === 'AI');
  const unkeptPattern = lastAiMsg ? isUnkeptPromise(lastAiMsg.content) : null;
  if (unkeptPattern) {
    const promiseText = lastAiMsg!.content.trim();
    // Find the last lead message BEFORE that promise — it's what the
    // explanation is supposed to address.
    const promiseIdx = conversationHistory.findIndex((m) => m === lastAiMsg);
    const priorLeadMsg =
      promiseIdx > 0
        ? [...conversationHistory.slice(0, promiseIdx)]
            .reverse()
            .find((m) => m.sender === 'LEAD')
        : null;
    const priorLeadText = priorLeadMsg?.content?.trim() || '';
    systemPrompt += `\n\n## PROMISE-KEEPING (CRITICAL — READ CAREFULLY)
Your previous message to the lead was: "${promiseText}"
${priorLeadText ? `It was in response to the lead saying: "${priorLeadText.slice(0, 300)}"` : ''}

That message promised follow-up content but did not deliver it. The lead is now waiting and expecting you to explain or show what you said you would. Your next message MUST:

1. Deliver substantive content that fulfills the promise. Actually explain. Actually show. Actually tell them what you said you would.
2. Do NOT open with another qualifying question before delivering. The lead already said they're ready to hear you — don't make them wait again.
3. Do NOT repeat the same preamble ("I'll explain", "lemme explain", "let me show you"). Just deliver the content directly.
4. You CAN follow the explanation with a short forward-moving question to continue the conversation, but only AFTER the substance is there.
5. Keep your established voice: casual texting style, short sentences, no corporate tone.

**LENGTH CONSTRAINT:** Total message MUST be under 450 characters. That's about 2-4 short text-message sentences, not a paragraph. Don't lecture. Pick ONE key point and hit it, then ask the next question. If you can't fit the full explanation in 450 chars, give the high-level gist — they'll ask for more if they want it.

This rule overrides stage progression — even if the funnel says you should be asking a Discovery question next, deliver the promised explanation FIRST, then ask the next question in the SAME message.`;
    console.log(
      `[ai-engine] Promise-tracking triggered: last AI turn "${promiseText}" — injecting delivery directive`
    );
  }

  // ── FINAL OUTPUT FORMAT REMINDER ──────────────────────────────
  // Stacked directive blocks (pre_qualified_context, promise-keeping,
  // voice-notes-disabled) sometimes confuse the LLM into replying with
  // plain text instead of the required JSON. This trailer lands as the
  // LAST thing the model reads before generating, which carries more
  // recency weight than instructions buried hundreds of lines up.
  systemPrompt += `\n\n## OUTPUT FORMAT — NON-NEGOTIABLE (READ LAST)
Your entire response MUST be a single valid JSON object matching the RESPONSE FORMAT schema at the top of this system prompt. No prose. No markdown. No code fences.

At minimum, your JSON must include these fields with valid values:
- "format": "text" (or "voice_note" if enabled)
- "message": the actual reply you want sent to the lead, written in Daniel's voice (lowercase opener, casual)
- "stage": one of OPENING | SITUATION_DISCOVERY | GOAL_EMOTIONAL_WHY | URGENCY | SOFT_PITCH_COMMITMENT | FINANCIAL_SCREENING | BOOKING — whichever stage you are ACTUALLY in right now based on the conversation
- "stage_confidence": a number 0.0–1.0

If you catch yourself writing plain text, stop and rewrite as JSON. The entire pipeline breaks when stage is missing — downstream systems rely on it to track funnel progression.`;

  // 2. Resolve AI provider credentials (per-account BYOK → env fallback)
  const { provider, apiKey, model, fallback } =
    await resolveAIProvider(accountId);

  if (!apiKey) {
    throw new Error(
      'No AI provider configured. Please add your OpenAI or Anthropic API key in Settings → Integrations.'
    );
  }

  // Accumulate usage + final modelUsed across voice-gate retries. The
  // last successful callLLM sets modelUsed — which is the shipped model.
  // usageTotal is the sum of input/output/cache tokens across EVERY
  // attempt so cost tracking reflects the full generation cost.
  let modelUsedFinal: string = model;
  let usageTotal: LLMUsage = { ...EMPTY_USAGE };

  // 3. Format conversation history for the LLM
  const messages = formatConversationForLLM(conversationHistory);

  // Resolve the active conversationId once — reused by the R24 gate
  // below to look up prior AI messages in this same thread. We use
  // the last history message that has an id (persisted rows do; the
  // live just-incoming message may not yet).
  const lastHistoryMsgWithId = [...conversationHistory]
    .reverse()
    .find((m) => m.id);
  let activeConversationId: string | null = null;
  if (lastHistoryMsgWithId?.id) {
    const msgRow = await prisma.message.findUnique({
      where: { id: lastHistoryMsgWithId.id },
      select: { conversationId: true }
    });
    activeConversationId = msgRow?.conversationId || null;
  }

  // R24 — capital verification gate data. We fetch the persona's
  // threshold + optional custom phrasing ONCE, reuse inside the retry
  // loop. When the threshold is null, the gate is disabled entirely
  // (backward compatible for accounts that haven't configured it).
  const personaForGate = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true },
    select: {
      minimumCapitalRequired: true,
      capitalVerificationPrompt: true,
      closerName: true,
      // Fix B uses closer names to catch "call with Anthony" / "chat
      // with {closerName}" phrases at any stage.
      promptConfig: true
    }
  });
  const capitalThreshold = personaForGate?.minimumCapitalRequired ?? null;
  const capitalCustomPrompt = personaForGate?.capitalVerificationPrompt ?? null;
  // Harvest closer names from both the legacy closerName field and the
  // newer promptConfig.callHandoff.closerName. Lowercased for case-
  // insensitive regex construction inside detectBookingAdvancement.
  const closerNames: string[] = [];
  if (personaForGate?.closerName) closerNames.push(personaForGate.closerName);
  const handoffCfg =
    (personaForGate?.promptConfig as { callHandoff?: { closerName?: string } })
      ?.callHandoff ?? null;
  if (
    handoffCfg?.closerName &&
    handoffCfg.closerName !== personaForGate?.closerName
  ) {
    closerNames.push(handoffCfg.closerName);
  }

  // 4. Call the LLM with quality gate (retry up to 2x on voice fails
  //    AND/OR R24 capital-verification-gate fails). systemPromptForLLM
  //    is a mutable copy so we can append an override directive when
  //    R24 blocks — the next attempt sees the extra instruction.
  const MAX_RETRIES = 2;
  let parsed: ParsedAIResponse | null = null;
  let qualityGateAttempts = 0;
  let finalQualityScore: number | null = null;
  let qualityGatePassedFirstAttempt = false;

  // UNQUALIFIED post-exit guard (Kelvin Kelvot 2026-04-24 incident).
  // When lead.stage is already UNQUALIFIED, the AI shouldn't continue
  // qualifying — the conversation has concluded. Valid follow-ups are
  // narrow: repeat the downsell pitch if the lead re-engaged, send the
  // free-resource YouTube link, or soft-exit. Without this block the
  // LLM drifts back into trading-strategy questions and keeps the
  // conversation going like nothing happened.
  const unqualifiedGuard =
    leadContext.status === 'UNQUALIFIED'
      ? `\n\n===== POST-UNQUALIFIED CONVERSATION GUARD =====\nThis lead has already been marked UNQUALIFIED (insufficient capital confirmed earlier in the thread). The sales conversation is effectively over. Your ONLY valid next actions are:\n  (a) Repeat the downsell pitch (lower-ticket course / funding partner) if the lead is re-engaging on that.\n  (b) Send the free-resource YouTube link per the script if they ask for help.\n  (c) Soft-exit with dignity — "when you're in a better spot hit me up" style.\nDo NOT ask trading strategy questions. Do NOT give market advice. Do NOT continue qualification (no Goal/Why, Urgency, Soft Pitch, Financial). Do NOT invite them to book a call. Do NOT send the Typeform / application link. The qualification flow is DONE. A short, warm, non-coaching reply is the correct output.\n=====`
      : '';
  // baseSystemPrompt always carries the unqualified guard when relevant.
  // Retry-loop override assignments below use this as their base so the
  // guard doesn't get stripped when a more-specific override (R24, Fix B,
  // fabrication, ack-truncation, link-promise, markdown) fires.
  const priorAIMessagesForPacing = conversationHistory.filter(
    (m) => m.sender === 'AI'
  );
  const priorAIQuestions = extractLastAIQuestions(
    priorAIMessagesForPacing.map((m) => m.content),
    3
  );
  const incomeGoalAsked = priorAIMessagesForPacing.some((m) =>
    containsIncomeGoalQuestion(m.content)
  );
  const capitalQuestionAsked = conversationHistory.some(
    (m) =>
      (m.sender === 'AI' || m.sender === 'HUMAN') &&
      containsCapitalQuestion(m.content)
  );
  const capitalVerificationSatisfied =
    hasCapitalVerificationQuestionAndAnswer(conversationHistory);
  const botDetectionCount = conversationHistory.filter(
    (m) => m.sender === 'LEAD' && isBotDetectionQuestion(m.content)
  ).length;
  const botDetectionDirective =
    botDetectionCount >= 2
      ? `\n\n===== BOT-DETECTION PATTERN BREAK =====\nThe lead has asked if you are automated twice. Your response pattern has become detectable. Change your approach immediately — respond with something unexpected and personal, then advance to the call pitch. Do not ask another discovery question. If the capital gate is still unmet, the only acceptable advancement question is the capital question; do not ask another trading / setup / strategy question first.\n=====`
      : '';
  const lastLeadHadImage = Boolean(
    lastLeadMsg?.hasImage || lastLeadMsg?.imageUrl
  );
  const baseSystemPrompt =
    systemPrompt + unqualifiedGuard + botDetectionDirective;
  let systemPromptForLLM = baseSystemPrompt;
  let r24GateEverForcedRegen = false;
  let r24LastResult: R24GateResult = {
    blocked: false,
    reason: 'confirmed_affirmative',
    parsedAmount: null,
    verificationAskedAt: null,
    verificationConfirmedAt: null
  };
  let r24WasEvaluatedThisTurn = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    qualityGateAttempts = attempt + 1;
    const callResult = await callLLM(
      provider,
      apiKey,
      model,
      systemPromptForLLM,
      messages,
      fallback
    );
    modelUsedFinal = callResult.modelUsed;
    usageTotal = addUsage(usageTotal, callResult.usage);

    parsed = parseAIResponse(callResult.text);

    // 5. Voice quality gate — runs per-bubble via scoreVoiceQualityGroup.
    // For single-message responses (flag-off persona), parsed.messages is
    // [parsed.message] and the group wrapper degenerates to a single call
    // — byte-identical to the pre-multi-bubble behaviour. Multi-bubble
    // responses get per-bubble hardFails tagged [bubble=N] plus the
    // group-level cta_ack_only_truncation check on the joined string.
    //
    // conversationMessageCount + leadStage power the new
    // premature_soft_exit_warm_lead signal (soft -0.4). R24 hasn't run
    // yet for this iteration, so we use the LAST iteration's outcome
    // as capitalOutcome — good enough to gate the signal, since the
    // current-iteration R24 only matters for the PROMOTION step.
    const quality = scoreVoiceQualityGroup(parsed.messages, {
      relaxLengthLimit: !!unkeptPattern,
      conversationMessageCount: conversationHistory.length,
      leadStage: leadContext.status || undefined,
      capitalOutcome:
        r24LastResult.reason === 'answer_below_threshold'
          ? 'failed'
          : undefined,
      // Souljah J 2026-04-25 — feed the previous AI bubble in so the
      // gate can fire repeated_question (soft -0.4) and
      // repeated_call_pitch (hardFail) when the LLM forgets the lead's
      // interjection between turns. Falls back to null when this is
      // the first AI turn.
      previousAIMessage: lastAiMsg?.content ?? null,
      aiMessageCount:
        priorAIMessagesForPacing.length + (parsed.messages?.length || 1),
      currentStage: parsed.stage || null,
      incomeGoalAsked,
      capitalQuestionAsked,
      capitalVerificationRequired:
        typeof capitalThreshold === 'number' && capitalThreshold > 0,
      capitalVerificationSatisfied,
      previousAIQuestions: priorAIQuestions,
      previousLeadMessage: lastLeadMsg?.content ?? null,
      previousLeadHadImage: lastLeadHadImage,
      leadEmail: leadContext.booking?.leadEmail ?? null,
      // Rodrigo Moran 2026-04-26 — count prior capital-verification
      // questions in the AI history so the gate hard-fails a repeat
      // ask. Local pattern set kept inside conversation-facts to
      // avoid duplicating the regexes here.
      priorCapitalQuestionAskCount: priorAIMessages.filter((m) => {
        const t = m.content || '';
        return (
          /\byou got at least \$\d/i.test(t) ||
          /\byou have at least \$\d/i.test(t) ||
          /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i.test(
            t
          ) ||
          /\bcapital ready\b/i.test(t) ||
          /\bjust to confirm.*\$\d/i.test(t) ||
          /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i.test(
            t
          ) ||
          /\bwhat('s| is) your (budget|capital|starting (amount|capital|budget))\b/i.test(
            t
          ) ||
          /\bwhat are you working with\b/i.test(t) ||
          /\bon the (capital|money|budget) side\b/i.test(t)
        );
      }).length,
      // Rodrigo Moran 2026-04-26 — count prior "real quick" usage so
      // overuse triggers the soft penalty when the LLM keeps
      // reaching for the same transition phrase.
      priorRealQuickPhraseCount: priorAIMessages.filter((m) =>
        /\breal\s+quick\b/i.test(m.content || '')
      ).length,
      // Rodrigo Moran 2026-04-26 spec rule 3 — if the lead has
      // already signaled they have no capital (student / broke /
      // unemployed / "I got nothing"), the AI must NOT ask the
      // threshold question on top of it.
      leadImplicitlySignaledNoCapital: conversationHistory.some((m) => {
        if (m.sender !== 'LEAD') return false;
        const t = m.content || '';
        return (
          /\b(broke|nothing\s+(really|man|bro)?|no\s+money|don'?t\s+have\s+(any\s+)?(money|capital|anything|much))\b/i.test(
            t
          ) ||
          /\b(i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school|in\s+(college|university|highschool|high\s+school))\b/i.test(
            t
          ) ||
          /\b(jobless|unemployed|no\s+job|lost\s+my\s+job|between\s+jobs|laid\s+off|no\s+income|no\s+work|out\s+of\s+work)\b/i.test(
            t
          ) ||
          /\b(can'?t\s+(eat|pay\s+rent|pay\s+bills|afford))\b/i.test(t) ||
          /\b(i\s+(have|got)\s+nothing|got\s+nothing\s+(right\s+now|rn|atm|man|bro))\b/i.test(
            t
          )
        );
      }),
      // Omar Moore 2026-04-27 — count of trailing pure-question AI
      // turns (ends in `?` AND doesn't acknowledge any specific
      // lead-side detail) PLUS the extracted recent lead details
      // for the gate to test the current reply against. The
      // detector module is the single source of truth for both
      // the detail patterns and the pure-question definition.
      ...(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
        const det =
          require('@/lib/conversation-detail-extractor') as typeof import('@/lib/conversation-detail-extractor');
        const recentLead = conversationHistory
          .filter((m) => m.sender === 'LEAD')
          .slice(-2)
          .map((m) => ({ content: m.content }));
        const recentLeadDetails = det.extractRecentLeadDetails(recentLead);
        const recentAi = priorAIMessages.slice(-6);
        const priorConsecutivePureQuestionCount =
          det.countConsecutivePureQuestions(recentAi, recentLeadDetails);
        return {
          priorConsecutivePureQuestionCount,
          recentLeadDetails
        };
      })()
    });
    finalQualityScore = quality.score;

    // 5b. R24 CAPITAL VERIFICATION GATE. Runs only when (a) the active
    //     account has a threshold configured, (b) we resolved a
    //     conversationId, and (c) this reply is routing the lead into
    //     booking-handoff messaging ("team is gonna reach out", "let's
    //     gooo bro" wrap-up, BOOKING_CONFIRM sub-stage, etc.). When
    //     those conditions are met, look in the conversation history
    //     for a prior AI verification question + an affirmative lead
    //     reply. If either is missing, BLOCK this response and retry
    //     with a synthetic override directive appended to the system
    //     prompt.
    let r24Blocked = false;
    if (
      activeConversationId &&
      typeof capitalThreshold === 'number' &&
      capitalThreshold > 0 &&
      isRoutingToBookingHandoff(parsed)
    ) {
      r24WasEvaluatedThisTurn = true;
      r24LastResult = await checkR24Verification(
        activeConversationId,
        capitalThreshold,
        capitalCustomPrompt,
        // Pass the current-turn LEAD message as a timing-defensive
        // override — if it happens to be saved microseconds after
        // the gate's own DB snapshot, the override guarantees the
        // answer-to-the-Q still gets classified. See checkR24
        // Verification doc for the specifics.
        lastLeadMsg
          ? { content: lastLeadMsg.content, timestamp: lastLeadMsg.timestamp }
          : undefined
      );
      r24Blocked = r24LastResult.blocked;
    }

    // 5c. FIX B — broader capital-advancement gate. Independent of R24's
    //     `isRoutingToBookingHandoff` trigger; fires on ANY response
    //     that attempts to advance the lead (by stage OR content) when
    //     the capital question hasn't been verified yet. Catches LLM
    //     outputs that mislabel their stage (e.g., reported OPENING
    //     with "hop on a quick chat with Anthony" in the message),
    //     which is the Nez Futurez 2026-04-20 failure mode. Creates a
    //     BookingRoutingAudit row on every block so ops has a 48h
    //     diagnostic log. Skipped if R24 already blocked this turn —
    //     one block directive at a time to avoid conflicting overrides.
    let fixBBlocked = false;
    let fixBResult: CapitalVerificationBlockResult | null = null;
    if (
      !r24Blocked &&
      activeConversationId &&
      typeof capitalThreshold === 'number' &&
      capitalThreshold > 0
    ) {
      fixBResult = await shouldBlockForCapitalVerification({
        parsed,
        conversationId: activeConversationId,
        capitalThreshold,
        capitalCustomPrompt,
        closerNames,
        currentTurnLeadMsg: lastLeadMsg
          ? { content: lastLeadMsg.content, timestamp: lastLeadMsg.timestamp }
          : undefined
      });
      fixBBlocked = fixBResult.blocked;
    }

    // 5c-ii. FUNDING-PARTNER GEOGRAPHY GATE. R24 blocks booking
    // attempts, but a model can still pitch "funding partner" as a
    // downsell/alternative without using booking-handoff language.
    // For non-US/CA leads, that option is invalid, so block any generated
    // funding-partner pitch before it reaches the lead.
    let restrictedFundingBlocked = false;
    let restrictedFundingCountry: string | null = null;
    if (!r24Blocked && !fixBBlocked && mentionsFundingPartnerRoute(parsed)) {
      const recentLeadMessages = conversationHistory
        .filter((m) => m.sender === 'LEAD')
        .slice(-10)
        .map((m) => m.content);
      const geo = detectRestrictedGeography(
        leadContext.geography,
        recentLeadMessages
      );
      if (geo.restricted) {
        restrictedFundingBlocked = true;
        restrictedFundingCountry = geo.country;
      }
    }

    // 5d. BOOKING FABRICATION GATE (Rufaro 2026-04-18 fix).
    //     Independent of R24/Fix B. Fires whenever the AI's reply
    //     claims real-time booking state (anthony-is-ready, zoom-link-
    //     incoming, you're-all-set) AND the conversation has no actual
    //     scheduledCallAt / bookingId. Skips entirely when a real
    //     booking exists — the AI CAN reference a call that's
    //     actually scheduled. This is a pure content detector, so it
    //     runs even when R24/Fix B didn't block.
    let fabricationBlocked = false;
    let fabricationResult: BookingFabricationBlockResult | null = null;
    if (
      activeConversationId &&
      !r24Blocked &&
      !fixBBlocked &&
      !restrictedFundingBlocked
    ) {
      fabricationResult = await shouldBlockForBookingFabrication({
        parsed,
        conversationId: activeConversationId,
        closerNames
      });
      fabricationBlocked = fabricationResult.blocked;
    }

    const unnecessarySchedulingQuestionFailed =
      quality.softSignals.unnecessary_scheduling_question !== undefined;
    const logisticsBeforeQualificationFailed =
      quality.softSignals.logistics_before_qualification !== undefined;

    if (
      quality.passed &&
      !unnecessarySchedulingQuestionFailed &&
      !logisticsBeforeQualificationFailed &&
      !r24Blocked &&
      !fixBBlocked &&
      !restrictedFundingBlocked &&
      !fabricationBlocked
    ) {
      if (attempt === 0) qualityGatePassedFirstAttempt = true;
      if (attempt > 0) {
        console.log(
          `[ai-engine] Quality + R24 passed on retry ${attempt} (score: ${quality.score.toFixed(2)})`
        );
      }
      break;
    }

    // R24 regeneration path — the override directive is REASON-
    // specific. "Never asked" → ask the question. "Below threshold" →
    // pivot to the downsell branch. "Ambiguous" → ask clarifying Q.
    // Voice-quality failures retry without mutation; R24 needs this
    // extra nudge because the LLM doesn't otherwise know which
    // corrective path to take.
    if (r24Blocked) {
      r24GateEverForcedRegen = true;
      const thresholdStr = `$${capitalThreshold!.toLocaleString('en-US')}`;
      let r24Directive = '';
      switch (r24LastResult.reason) {
        case 'never_asked':
          r24Directive = `Your previous reply tried to route the lead into booking-handoff messaging (team reaching out, call confirmation, etc.) BUT this conversation has not yet asked the capital verification question. You MUST regenerate. Your next reply must ask the lead about their capital — either the threshold-confirming form ("you got at least ${thresholdStr} in capital ready to start?") or the open-ended form ("how much do you have set aside?") whichever fits your voice. Do NOT send any booking-handoff language until the lead confirms an amount.`;
          break;
        case 'asked_but_no_answer':
          r24Directive = `You already asked the capital verification question, but the lead hasn't answered yet. Do NOT route to booking-handoff. Wait for their answer, or send a short nudge to re-ask. Do NOT advance until they state an amount.`;
          break;
        case 'answer_below_threshold': {
          const stated =
            r24LastResult.parsedAmount !== null
              ? `$${r24LastResult.parsedAmount.toLocaleString('en-US')}`
              : 'an amount below the threshold';
          let baseDirective = `The lead's stated capital (${stated}) is below the minimum threshold (${thresholdStr}). Your ONLY valid next action is the DOWNSELL PITCH. Do NOT ask more trading questions. Do NOT ask what they're working on. Do NOT give market / strategy advice. Do NOT route to booking. Do NOT send the Typeform / application form. Do NOT say "the team will reach out". Do NOT re-ask the capital question.\n\nFire the script's Step 9 "Not Qualified" branch NOW: acknowledge their situation in one short line (no judgment, no lecture), then present the lower-ticket course / downsell from the script ("my $497 Session Liquidity Model course breaks it down — same strategy, you learn on your own pace while you build capital" style). Wait for their answer to the downsell before any further routing. If your script has no downsell, send a soft-exit message that keeps the door open. Continuing the qualification dialogue after a confirmed capital miss is the exact failure mode this rule exists to prevent.`;

          // GEOGRAPHY GATE — funding-partner programs only onboard
          // US/CA leads. When the lead is elsewhere, strip the
          // funding-partner option from the downsell menu so the AI
          // doesn't pitch a path the lead can't actually take.
          const recentLeadMessages = conversationHistory
            .filter((m) => m.sender === 'LEAD')
            .slice(-10)
            .map((m) => m.content);
          const geo = detectRestrictedGeography(
            leadContext.geography,
            recentLeadMessages
          );
          if (geo.restricted) {
            baseDirective += `\n\nGEOGRAPHY GATE: The lead is based in ${geo.country}. Funding-partner programs (FTMO-style funded accounts, broker prop programs) are only available to leads in the US and Canada. DO NOT route this lead to the funding-partner branch under any circumstances. The only options you may offer here are: (1) the $497 course downsell, or (2) a free YouTube / resource redirect. Do not explain how prop firms work. Do not mention funded accounts, challenges, or third-party capital as an option.`;
            console.warn(
              `[ai-engine] R24 geography gate: restricted country "${geo.country}" detected for conv ${activeConversationId} — funding-partner path blocked`
            );
          }

          r24Directive = baseDirective;
          break;
        }
        case 'answer_hedging':
          r24Directive = `The lead hedged on the capital question ("kinda", "working on it", "almost", etc.) without giving a concrete number. Do NOT route to booking. Ask a single follow-up that pins down a concrete dollar figure — for example "no stress, what's the number you're working with rn?". Do NOT send booking-handoff messaging until you have a concrete amount.`;
          break;
        case 'answer_ambiguous':
          r24Directive = `The lead's reply to the capital question didn't give a clear answer ("depends", "varies", "not sure", etc.). Do NOT route to booking. Ask a short clarifying question that gets a concrete dollar figure. Do NOT send booking-handoff messaging yet.`;
          break;
        case 'answer_prop_firm_only':
          r24Directive = `The lead mentioned a prop firm, funded account, or challenge (FTMO / Apex / Topstep / etc.) but did NOT state personal capital they have set aside. Firm capital is NOT personal capital — the lead accessing a $100k challenge account means the FIRM put up that money, not the lead. Do NOT route to booking. Ask specifically about PERSONAL capital: something like "respect bro, prop firms are solid. but what I'm asking is what YOU'VE got set aside for your own education and trading — not the firm's money. you got ${thresholdStr} ready on your end?". Make the distinction clear and wait for a concrete answer.`;
          break;
      }
      const r24Override = `\n\n===== CRITICAL R24 OVERRIDE =====\n${r24Directive}\n=====`;
      systemPromptForLLM = baseSystemPrompt + r24Override;
      console.warn(
        `[ai-engine] R24 gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${r24LastResult.reason} parsedAmount=${r24LastResult.parsedAmount ?? 'null'}`
      );
    }

    // FIX B regeneration path — fires when R24 didn't trigger but the
    // content-level advancement gate did. Writes a dedicated audit row
    // so operators can distinguish R24 blocks from Fix B blocks in the
    // 48h diagnostic review. Injects an override that's almost
    // identical to R24's `never_asked` directive — the LLM still needs
    // to ask the capital question, just via a different upstream path.
    if (fixBBlocked && fixBResult) {
      const thresholdStr = `$${capitalThreshold!.toLocaleString('en-US')}`;
      try {
        await prisma.bookingRoutingAudit.create({
          data: {
            conversationId: activeConversationId!,
            accountId,
            personaMinimumCapital: capitalThreshold,
            routingAllowed: false,
            regenerationForced: true,
            blockReason: fixBResult.reason,
            aiStageReported: parsed.stage || null,
            aiSubStageReported: parsed.subStage || null,
            contentPreview: parsed.message.slice(0, 200)
          }
        });
      } catch (auditErr) {
        console.error(
          '[ai-engine] Fix B BookingRoutingAudit write failed (non-fatal):',
          auditErr
        );
      }
      const fixBDirective = `Your previous reply attempted to advance this conversation toward a call pitch, booking, or resource handoff — but the lead has NOT yet confirmed they have at least ${thresholdStr} in capital available to start. You MUST regenerate. Your next reply MUST ask the capital verification question before pitching the call, application, or any next step. Use the threshold-confirming form ("you got at least ${thresholdStr} in capital ready to start?") or the open-ended form ("how much do you have set aside?") — whichever fits your voice. Do NOT pitch the call or drop any link until the lead confirms an amount. This was detected at LLM stage=${parsed.stage || 'unknown'}, sub_stage=${parsed.subStage ?? 'null'} — so your internal stage labeling is not enough: you must actually ask the question before any advancement language.`;
      const fixBOverride = `\n\n===== CRITICAL CAPITAL-VERIFICATION OVERRIDE (Fix B) =====\n${fixBDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + fixBOverride;
      console.warn(
        `[ai-engine] Fix B gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fixBResult.reason} stage=${parsed.stage} sub=${parsed.subStage ?? 'null'}`
      );
    }

    if (restrictedFundingBlocked) {
      const geoLabel = restrictedFundingCountry || 'a non-US/Canada country';
      const restrictedFundingDirective = `The lead is based in ${geoLabel}. Funding-partner / funded-account routes are only available to leads in the US and Canada. Your previous reply mentioned a funding partner, funded account, prop firm, challenge, or third-party capital option. You MUST regenerate without that route.\n\nCorrect path: if the lead is below the capital threshold, route directly to the downsell. If they decline the downsell, send the free resource if one is available. Do NOT explain how prop firms work. Do NOT mention funded accounts, challenges, funding partner, or third-party capital as an option.`;
      const restrictedFundingOverride = `\n\n===== FUNDING-PARTNER GEOGRAPHY OVERRIDE =====\n${restrictedFundingDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + restrictedFundingOverride;
      console.warn(
        `[ai-engine] Funding-partner geography gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — country=${geoLabel}`
      );
    }

    // BOOKING FABRICATION regeneration path. Logged to
    // BookingRoutingAudit so the 48h diagnostic review can filter on
    // `blockReason='booking_state_fabrication'`. Directive is direct:
    // don't claim real-time booking state, route the lead to the
    // booking link instead.
    if (fabricationBlocked && fabricationResult) {
      try {
        await prisma.bookingRoutingAudit.create({
          data: {
            conversationId: activeConversationId!,
            accountId,
            personaMinimumCapital: capitalThreshold,
            routingAllowed: false,
            regenerationForced: true,
            blockReason: 'booking_state_fabrication',
            aiStageReported: parsed.stage || null,
            aiSubStageReported: parsed.subStage || null,
            contentPreview: parsed.message.slice(0, 200)
          }
        });
      } catch (auditErr) {
        console.error(
          '[ai-engine] Booking-fabrication BookingRoutingAudit write failed (non-fatal):',
          auditErr
        );
      }
      const fabricationDirective = `CRITICAL: You claimed a call or meeting is happening or about to happen, but NO call has been booked in the system. There is no zoom link being sent. No one is standing by on a call. The system does NOT auto-book calls.\n\nYour reply must ONLY instruct the lead to use the booking link to schedule a time themselves. Do NOT claim:\n- Anyone is about to join a call or is on the call\n- A zoom link is being sent or is on the way\n- A calendar invite is coming through or in their email\n- The lead is "all set" or "locked in"\n\nCorrect framing: "the team handles scheduling on their end, they'll reach out with the call details" OR "go ahead and grab a time that works for you with the link above, you'll get a confirmation when you book".`;
      const fabricationOverride = `\n\n===== CRITICAL BOOKING-FABRICATION OVERRIDE =====\n${fabricationDirective}\n=====`;
      systemPromptForLLM = baseSystemPrompt + fabricationOverride;
      console.warn(
        `[ai-engine] Booking fabrication BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fabricationResult.reason} content="${parsed.message.slice(0, 120)}"`
      );
    }

    if (unnecessarySchedulingQuestionFailed) {
      const schedulingOverride = `\n\n===== CALL ACCEPTANCE TYPEFORM OVERRIDE =====\nLead agreed to the call. Send the Typeform / booking link now, do not ask about scheduling. The Typeform handles scheduling. Use the real Typeform or booking URL from the script's Available Links & URLs section; do not invent a URL or use a placeholder.\n=====`;
      systemPromptForLLM = baseSystemPrompt + schedulingOverride;
      console.warn(
        `[ai-engine] Unnecessary scheduling question detected after call acceptance — forcing Typeform link drop (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (logisticsBeforeQualificationFailed) {
      const logisticsOverride = `\n\n===== LOGISTICS BEFORE QUALIFICATION OVERRIDE =====\nDo not collect scheduling details before capital is verified. Ask the capital question first: "real quick, what's your capital situation like for the markets right now?" Do NOT ask for timezone, location, day, or time on this turn.\n=====`;
      systemPromptForLLM = baseSystemPrompt + logisticsOverride;
      console.warn(
        `[ai-engine] Logistics question before capital verification detected — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    // Log voice-quality failures (existing behaviour, unchanged).
    if (!quality.passed) {
      console.warn(
        `[ai-engine] Voice quality FAIL attempt ${attempt + 1}/${MAX_RETRIES + 1}:`,
        {
          score: quality.score.toFixed(2),
          hardFails: quality.hardFails,
          message: parsed.message.slice(0, 100)
        }
      );

      try {
        await prisma.voiceQualityFailure.create({
          data: {
            accountId,
            message: parsed.message,
            score: quality.score,
            hardFails: quality.hardFails as unknown as object,
            attempt: attempt + 1,
            leadMessage: lastLeadMsg?.content?.slice(0, 500) || null
          }
        });
      } catch {
        // Table might not exist yet — that's fine
      }

      // CTA-acknowledgment-only truncation directive injection. When the
      // voice gate fires `cta_acknowledgment_only_truncation`, just
      // retrying the same prompt tends to produce the same truncated
      // reply — the model has already decided the acknowledgment-only
      // shape. Append an explicit override so the next attempt knows
      // the specific correction required: put the whole multi-line
      // reply in the single "message" field AND include a qualifying
      // question. This mirrors the R24 directive-injection pattern.
      // Group scorer prefixes failures with "[bubble=N] " or "[group] "
      // depending on scope, so match on the reason token via .includes()
      // instead of .startsWith() now.
      const ackTruncationFailed = quality.hardFails.some((f) =>
        f.includes('cta_acknowledgment_only_truncation:')
      );
      if (ackTruncationFailed) {
        const ackOverride = `\n\n===== ACKNOWLEDGMENT-ONLY TRUNCATION OVERRIDE =====\nYour previous response was just an acknowledgment — it did not include a qualifying question, so the lead has nothing to respond to and the conversation stalls. You MUST regenerate. Your next "message" field MUST contain BOTH the acknowledgment AND a forward-moving qualifying question in the SAME single "message" string. Multi-line is fine — use line breaks between acknowledgment, any URL, and the question. Do NOT write "Message 1 / Message 2 / Message 3" — the schema is one "message" field; if you only put the acknowledgment there, that is literally all the lead sees.\n=====`;
        systemPromptForLLM = baseSystemPrompt + ackOverride;
        console.warn(
          `[ai-engine] CTA acknowledgment-only truncation detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Link-promise-without-URL directive (Shishir 2026-04-20).
      // The LLM announced a link send but didn't include the URL.
      // Same class of failure as ack-truncation: natural regen
      // tends to reproduce the same mistake. Inject an explicit
      // override telling the model to INCLUDE the URL from the
      // script's Available Links section.
      // Course-payment placeholder leak directive (George 2026-04-08
      // incident). When the LLM emits "[COURSE PAYMENT LINK]" /
      // "[WHOP LINK]" / "[CHECKOUT LINK]" / similar, the gate
      // hard-fails. Generic regen tends to either re-emit the
      // placeholder OR generate a fake-looking URL. Override gives
      // the LLM the EXACT Whop checkout URL to paste verbatim.
      //
      // URL pulled from the persona's freeValueLink config when
      // present (operator-controlled), falls back to the daetradez
      // production URL surfaced in the spec. We don't want to
      // hardcode account-specific URLs in the engine, so the lookup
      // happens above in the persona-load path; here we just inject
      // whichever resolved.
      const courseLinkLeaked = quality.hardFails.some((f) =>
        f.includes('course_link_placeholder_leaked:')
      );
      if (courseLinkLeaked) {
        // Pull the persona-configured course / payment URL. Schema
        // doesn't have a dedicated field yet — for now, we use the
        // operator-provided fallback baked into the directive. The
        // operator can override via the script's Available Links
        // section, which is already in the prompt above.
        const COURSE_URL_FALLBACK =
          'https://whop.com/checkout/17xvsu5mtr2luz7SrD-UXYx-Rx1U-Q8lg-IBn57oRarBX6/';
        const courseLinkOverride = `\n\n===== COURSE / PAYMENT LINK PLACEHOLDER LEAK =====\nYour previous reply contained a literal placeholder like "[COURSE PAYMENT LINK]" / "[WHOP LINK]" / "[CHECKOUT LINK]" / "[PAYMENT LINK]" instead of the actual URL. The lead would have seen the raw brackets in their messaging app, not a clickable link.\n\nOn this regen:\n  1. Use the EXACT course / payment URL from the script's "Available Links & URLs" section above. If the script lists one, paste it verbatim.\n  2. If no course URL is listed in the script, the production fallback for this account is:\n       ${COURSE_URL_FALLBACK}\n     Use that exact URL — do not modify it.\n  3. NEVER ship square-bracketed placeholders like [LINK], [URL], [COURSE LINK], [PAYMENT LINK], [WHOP LINK], [CHECKOUT LINK], [BOOKING LINK]. They render literally to the lead.\n  4. The URL is the delivery; the framing words around it are optional. Drop the URL inline or on its own line.\n=====`;
        systemPromptForLLM = baseSystemPrompt + courseLinkOverride;
        console.warn(
          `[ai-engine] Course/payment link placeholder leak detected — forcing regen with real URL (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const linkPromiseFailed = quality.hardFails.some((f) =>
        f.includes('link_promise_without_url:')
      );
      if (linkPromiseFailed) {
        const linkOverride = `\n\n===== LINK-PROMISE-WITHOUT-URL OVERRIDE =====\nYour previous reply announced sending a link ("I'll send you the link" / "here's the link" / "sending you the link" / etc.) but did NOT include the actual URL. The lead is now waiting with nothing to click. You MUST regenerate. Your next reply MUST include the EXACT URL from the script's "Available Links & URLs" section inline with your message. Do NOT say you'll send a link and then fail to include it. The URL IS the delivery — the words around it are just framing. Put the URL on its own line or inline: "here's the link: <URL>" / "grab a time that works for you: <URL>" / "<URL> fill it out and lmk when done". The URL must be a real https:// link from the script, not a placeholder like [LINK] or [BOOKING LINK].\n=====`;
        systemPromptForLLM = baseSystemPrompt + linkOverride;
        console.warn(
          `[ai-engine] Link promise without URL detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Repeated-call-pitch directive (Souljah J 2026-04-25). Fires
      // when the previous AI bubble AND this one BOTH contain a call-
      // pitch phrase. Natural regen tends to repeat the same pitch
      // — model momentum from the script. Override forces it to
      // acknowledge the lead's interim response BEFORE pitching.
      const repeatedCallPitchFailed = quality.hardFails.some((f) =>
        f.includes('repeated_call_pitch:')
      );
      if (repeatedCallPitchFailed) {
        const repeatedPitchOverride = `\n\n===== REPEATED CALL PITCH OVERRIDE =====\nYou already pitched the call on the previous turn. The lead responded — but they did not give a clear yes or no. Pitching the call again on this turn reads as desperate and trains the lead to ghost. You MUST regenerate WITHOUT pitching the call again. Instead:\n  1. Acknowledge SPECIFICALLY what the lead just said in their last message — answer their question if they asked one, address their stall if they stalled, react to their content if they shared something.\n  2. THEN move the conversation forward with a relevant follow-up question OR a brief value drop. Do NOT immediately pitch the call again.\n  3. Only re-pitch the call once the lead has given a clear yes/no on the prior pitch — not on this turn.\nForbidden phrases on this regen: "hop on a call", "hop on a chat", "call with [name]", "quick call", "quick chat", "jump on a call", "get on a call", "15-min call". Save the call-pitch language for a turn AFTER the lead has clearly responded.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedPitchOverride;
        console.warn(
          `[ai-engine] Repeated call pitch detected — forcing regen without pitch (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Repeated-capital-question directive (Rodrigo Moran 2026-04-26).
      // The LLM tried to ask the capital threshold question a second
      // time, having already asked once earlier in the conversation.
      // Natural regen tends to reproduce the same shape — model
      // momentum from the script's qualification flow. Override forces
      // it to advance the conversation differently.
      const repeatedCapitalQFailed = quality.hardFails.some((f) =>
        f.includes('repeated_capital_question:')
      );
      if (repeatedCapitalQFailed) {
        const repeatedCapitalOverride = `\n\n===== REPEATED CAPITAL QUESTION OVERRIDE =====\nYou ALREADY asked the lead about capital earlier in this conversation. The lead either answered or sidestepped it. Asking AGAIN makes the bot read as stuck in a loop (a real lead literally said "I think your bot is stuck doing a loop" on this exact failure). You MUST regenerate WITHOUT asking the capital question again.\n\nWhat to do instead:\n  1. If the lead's prior answer was a clear amount (≥ threshold), reference it: "since you got [amount] ready, let's get you locked in with [closer]…"\n  2. If the prior answer was a clear DECLINE / "not yet" / "after my [event]", route to the timing-aware branch: acknowledge the constraint and pivot to either a downsell, the YouTube channel, or scheduling the call after the stated event.\n  3. If the prior answer was AMBIGUOUS, do not re-ask the same threshold question. Instead, shift to a different qualifying question (urgency, timeline, motivation) or move toward booking with the closer.\n\nForbidden patterns on this regen: any "do you have at least \\$X", "you got \\$X ready", "how much do you have / set aside / saved", "what are you working with", "capital ready", "just to confirm…\\$".\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedCapitalOverride;
        console.warn(
          `[ai-engine] Repeated capital question detected — forcing regen with no-re-ask directive (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Capital-after-implicit-no directive (Rodrigo Moran 2026-04-26).
      // Lead has already signaled "no money" without a number. The
      // LLM tried to ask the threshold question anyway. Override
      // tells it to treat that signal as the answer and route to
      // the downsell branch.
      const capitalAfterImplicitNoFailed = quality.hardFails.some((f) =>
        f.includes('capital_q_after_implicit_no:')
      );
      if (capitalAfterImplicitNoFailed) {
        const directive = `\n\n===== CAPITAL Q AFTER IMPLICIT NO =====\nThe lead has ALREADY told you they have no money in this conversation — "I'm a student", "no job", "broke", "I got nothing", or similar. That IS their capital answer. Asking the threshold question on top of it ignores them and reads as the bot not paying attention.\n\nWhat to do instead on this regen:\n  • Acknowledge what they said briefly + with empathy ("damn ok bro, gotchu" / "ah I hear you fr").\n  • Pivot to the script's downsell / lower-tier option (the $497 course / funding-partner option / YouTube channel as appropriate).\n  • Do NOT ask "do you have at least $X" or "what's your capital situation" or "how much you working with" or any variant. Capital was answered.\nForbidden phrases on this regen: "do you have at least", "you got at least", "at least \\$1k", "capital ready", "what's your capital situation", "how much you working with", "set aside for".\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Capital question after implicit-no detected — forcing regen to downsell branch (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // "or nah?" question tail directive — the LLM keeps using
      // "or nah?" as a yes/no question construction. Override tells
      // it to phrase open-ended.
      const orNahFailed = quality.hardFails.some((f) =>
        f.includes('or_nah_question_tail:')
      );
      if (orNahFailed) {
        const directive = `\n\n===== "OR NAH?" QUESTION TAIL OVERRIDE =====\nDo not end questions with "or nah?". That construction primes a yes/no answer and reads as scripted. Use OPEN-ENDED phrasing on the regen — let the lead disclose freely instead of forcing them to pick yes/no. Examples:\n  WRONG: "do you have at least \\$1k or nah?"\n  RIGHT: "what's your capital situation like right now?"\n  WRONG: "you serious about this or nah?"\n  RIGHT: "how serious are you about getting this dialed in?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] "or nah?" question tail detected — forcing regen with open-ended phrasing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Incomplete response directive (Brian Dycey 2026-04-27). The
      // gate fired the soft signal incomplete_response_no_followup
      // (no question, no URL, < 15 words, on a stage that needs
      // advancement). Score-only — pushes the reply under 0.7 — but
      // we layer a directive on the regen telling the LLM that an
      // acknowledgment alone stalls the conversation.
      const incompleteResponseFlagged =
        typeof quality.softSignals?.incomplete_response_no_followup ===
        'number';
      if (incompleteResponseFlagged) {
        const stageForDirective =
          parsed.stage || (leadContext.status as string | undefined) || 'this';
        const directive = `\n\n===== INCOMPLETE RESPONSE — NO FOLLOW-UP =====\nYour previous reply acknowledged the lead but didn't advance the conversation — no question, no URL drop, no next step. On a ${stageForDirective}-stage turn that stalls the conversation. The lead has nothing to respond to and is now waiting.\n\nOn this regen, your reply MUST include EXACTLY ONE of:\n  1. A specific qualifying question that moves to the next stage of the script (urgency, capital, timeline, motivation — whichever fits the stage).\n  2. A direct call-pitch / link drop (only if the script has reached that step).\nAcknowledgment phrases ("gotchu bro", "that makes sense", "bet bro", "love that") are FINE as the OPENER of the reply, but the reply cannot END on one. Append a forward-moving question on the same turn.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Incomplete response (no follow-up) detected — forcing regen with question requirement (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Ignored personal question directive (Omar Moore 2026-04-27).
      // Lead asked a personal question ("hbu", "what about you",
      // "what's your favorite prop") and the AI's reply has no
      // first-person content — clearest bot tell there is. Override
      // forces the LLM to answer first.
      const ignoredPersonalQ =
        typeof quality.softSignals?.ignored_personal_question === 'number';
      if (ignoredPersonalQ) {
        const leadMsg = lastLeadMsg?.content?.slice(0, 200) ?? '';
        const directive = `\n\n===== IGNORED PERSONAL QUESTION =====\nThe lead just asked YOU a personal question: "${leadMsg}". You ignored it and pivoted to your next script question — that's the clearest bot signal possible. A real human never does this.\n\nOn this regen, your reply MUST:\n  1. Answer the lead's personal question in 1-2 short sentences from Daniel's perspective. Use first-person language ("I've", "my", "I"). Be specific and real, not vague.\n  2. THEN ask your next question naturally.\nDo NOT open with the next script question. Do NOT deflect with phrases like "I stay away from the prop-firm weeds tbh" or "I don't really get into that" — those read as dodges. Give a real, brief answer.\n\nExamples:\n  Lead: "Hbu" → AI: "been at it for a few years bro, lost a lot before it actually clicked fr. what do you do for work rn?"\n  Lead: "what's your favorite prop firm?" → AI: "i go for the ones with clean rules and no surprise scaling — consistency over hype. you been happy with alpha so far?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Ignored personal question detected — forcing regen with first-person answer (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Scripted question sequence directive (Omar Moore 2026-04-27).
      // Three+ pure-question turns in a row with no specific
      // acknowledgment. Override tells the LLM to reference a
      // specific detail the lead shared before asking the next thing.
      const scriptedSequence =
        typeof quality.softSignals?.scripted_question_sequence === 'number';
      if (scriptedSequence) {
        const leadMsg = lastLeadMsg?.content?.slice(0, 300) ?? '';
        const directive = `\n\n===== SCRIPTED QUESTION SEQUENCE =====\nYou have asked multiple qualification questions in a row without acknowledging any of the specific details the lead shared. After 3 in a row this pattern becomes detectable as a script.\n\nOn this regen, your reply MUST reference at least ONE specific detail from the lead's last message: "${leadMsg}". That means:\n  • If they named a prop firm (Alpha, TopStep, Lucid, FTMO, Apex, etc.), use the name.\n  • If they named an instrument (ES, NQ, gold, EURUSD, etc.), reference it.\n  • If they named a strategy (AMD, ORB, ICT, SMC, FVG, supply/demand, etc.), reference it.\n  • If they shared a personal experience (blew an account, getting married, day job, faith, family), reference it.\n\nOnly THEN ask your next question. "love that bro" / "big moves" / "that's solid" alone DO NOT count — the gate also flags those as generic acknowledgments. The acknowledgment must include a specific token from what they said.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Scripted question sequence detected — forcing regen with specific-detail acknowledgment (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Generic acknowledgment directive (Omar Moore 2026-04-27).
      // The reply was JUST "love that bro" or similar with no follow-
      // up content. Tell the LLM the acknowledgment-only path is
      // banned and to either acknowledge specifically + ask, or skip
      // the empty filler and go straight to the next question.
      const genericAck =
        typeof quality.softSignals?.generic_acknowledgment === 'number';
      if (genericAck) {
        const directive = `\n\n===== GENERIC ACKNOWLEDGMENT ONLY =====\nYour reply is just an empty acknowledgment ("love that bro", "big moves", "that's solid", "bet bro") with no content after it. The lead has nothing to respond to.\n\nOn this regen, either:\n  • DROP the generic phrase and open with something specific to what they shared, OR\n  • Keep the acknowledgment but append a forward-moving question or a value drop on the same turn.\nGeneric praise alone never ships. A reply that's pure filler is a stall.\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Generic acknowledgment-only detected — forcing regen with content (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // "real quick tho" banned-phrase directive. Hard-fail from the
      // BANNED_PHRASES list — the LLM keeps reaching for this as a
      // transition. Override tells it to find another bridge or just
      // ask the question without a transition phrase.
      const realQuickThoFailed = quality.hardFails.some((f) =>
        f.includes('"real quick tho"')
      );
      if (realQuickThoFailed) {
        const directive = `\n\n===== "REAL QUICK THO" BANNED =====\n"real quick tho" has become a bot tell — used before nearly every qualifying question. Banned. Find a different transition, or just ask the question directly.\nWRONG: "real quick tho, what's your capital situation?"\nRIGHT: "what's your capital situation like right now?"\nRIGHT: "yo bro one thing — what's your capital situation right now?"\n=====`;
        systemPromptForLLM = baseSystemPrompt + directive;
        console.warn(
          `[ai-engine] Banned "real quick tho" detected — forcing regen with different transition (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Image-limitation persona leak directive. If the model says
      // "can't see images" it breaks the human setter illusion. Force
      // the next attempt to answer like a normal person whose image
      // failed to load on their phone.
      const imageLimitationFailed = quality.hardFails.some((f) =>
        f.includes('image_limitation_exposed:')
      );
      if (imageLimitationFailed) {
        const imageLimitationOverride = `\n\n===== IMAGE PERSONA OVERRIDE =====\nDo not mention any inability to see images. Respond as a human whose image didn't load on their phone. Use natural wording like "yo the image isn't loading on my end, can you describe what you're seeing?" or "something's not coming through on my end bro, what was it?" Keep the human persona intact and keep the conversation moving.\n=====`;
        systemPromptForLLM = baseSystemPrompt + imageLimitationOverride;
        console.warn(
          `[ai-engine] Image limitation phrase detected — forcing regen with human image-load framing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      // Markdown-in-single-bubble directive (daetradez 2026-04-24).
      // The LLM emitted a numbered list with **bold** headers in one
      // big bubble instead of using the messages[] array to split
      // each point into its own short bubble. Natural regen without
      // this override tends to reproduce the same shape — the model
      // defaults to markdown on "how does X work" questions.
      const markdownFailed = quality.hardFails.some((f) =>
        f.includes('markdown_in_single_bubble:')
      );
      if (markdownFailed) {
        const markdownOverride = `\n\n===== NO MARKDOWN — USE MESSAGES ARRAY =====\nYour previous reply used markdown formatting (numbered list with **bold** headers, or multiple **bold** markers, or ## headers). Messaging apps do NOT render markdown — the lead literally sees "1. **Choose a program** — ..." with the asterisks. You MUST regenerate with NO markdown characters at all: no **, no ##, no numbered lists with bold headers, no bullet stars.\n\nInstead, split the content across separate bubbles via the messages[] array. Each bubble is its own short casual message — 1-2 sentences max, no markdown, no list formatting. Example:\n  messages: [\n    "funding convo's a whole other thing bro",\n    "not my lane to walk through prop firm rules — too much changes",\n    "the funded account flow we use gets broken down on the call with Anthony"\n  ]\nKeep each bubble punchy, casual, lowercase. Natural texting cadence — not a numbered how-to guide. If the answer genuinely needs structure, use 2-4 short bubbles, never a formatted list in one message.\n=====`;
        systemPromptForLLM = baseSystemPrompt + markdownOverride;
        console.warn(
          `[ai-engine] Markdown-in-single-bubble detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const incomeGoalOverdueFailed = quality.hardFails.some((f) =>
        f.includes('income_goal_overdue:')
      );
      if (incomeGoalOverdueFailed) {
        const incomeGoalOverride = `\n\n===== QUALIFICATION PACE OVERRIDE — INCOME GOAL =====\nYou have reached the income-goal deadline. Ask about the lead's income goal NOW. Do not ask another trading setup, chart, strategy, or "what's the main thing" discovery question first. Keep it natural and short, but the next reply must ask what they want to be making.\n=====`;
        systemPromptForLLM = baseSystemPrompt + incomeGoalOverride;
        console.warn(
          `[ai-engine] Income goal overdue — forcing regen with income-goal question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const qualificationStalledFailed = quality.hardFails.some((f) =>
        f.includes('qualification_stalled:')
      );
      if (qualificationStalledFailed) {
        const stalledOverride = `\n\n===== QUALIFICATION STALLED OVERRIDE =====\nYou have been in discovery for too long. Ask the capital question NOW. Do not ask any more trading questions first.\n=====`;
        systemPromptForLLM = baseSystemPrompt + stalledOverride;
        console.warn(
          `[ai-engine] Qualification stalled — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const callPitchBeforeCapitalFailed = quality.hardFails.some((f) =>
        f.includes('call_pitch_before_capital_verification:')
      );
      if (callPitchBeforeCapitalFailed) {
        const callBeforeCapitalOverride = `\n\n===== CALL PITCH BEFORE CAPITAL OVERRIDE =====\nYou have not asked the capital question yet. Do NOT propose the call. Ask first: "real quick, what's your capital situation like for the markets right now?" Do NOT pitch the call or mention scheduling on this turn.\n=====`;
        systemPromptForLLM = baseSystemPrompt + callBeforeCapitalOverride;
        console.warn(
          `[ai-engine] Call pitch before capital verification detected — forcing capital question (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repetitiveQuestionFailed =
        quality.softSignals.repetitive_question_pattern !== undefined;
      if (repetitiveQuestionFailed) {
        const repetitiveQuestionOverride = `\n\n===== REPETITIVE QUESTION PATTERN OVERRIDE =====\nYour last 3 questions were too similar. Ask something genuinely different or advance to the next script step instead of asking another variation of the same question.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repetitiveQuestionOverride;
        console.warn(
          `[ai-engine] Repetitive question pattern detected — forcing regen with script advancement (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const repeatedEmailFailed =
        quality.softSignals.repeated_email_request !== undefined;
      if (repeatedEmailFailed) {
        const repeatedEmailOverride = `\n\n===== REPEATED EMAIL REQUEST OVERRIDE =====\nLead email is already collected: ${leadContext.booking?.leadEmail}. Do not ask for their email again. Continue the booking/script step using the email already in context.\n=====`;
        systemPromptForLLM = baseSystemPrompt + repeatedEmailOverride;
        console.warn(
          `[ai-engine] Repeated email request detected — forcing regen without asking email again (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }

      const fabricatedImageObservationFailed = quality.hardFails.some((f) =>
        f.includes('fabricated_image_observation:')
      );
      if (fabricatedImageObservationFailed) {
        const imageObservationOverride = `\n\n===== IMAGE OBSERVATION FABRICATION OVERRIDE =====\nDo not claim you saw, noticed, checked, or looked at stats, flow, numbers, or chart details from the image. Respond as a human whose image didn't load clearly on their phone, then ask the lead to describe what they sent or what they want you to look at.\n=====`;
        systemPromptForLLM = baseSystemPrompt + imageObservationOverride;
        console.warn(
          `[ai-engine] Fabricated image observation detected — forcing regen with image-not-loading framing (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
        );
      }
    }

    if (attempt === MAX_RETRIES) {
      if (r24Blocked) {
        console.error(
          `[ai-engine] R24 gate EXHAUSTED ${MAX_RETRIES + 1} attempts — forcing escalate_to_human on convo ${activeConversationId}`
        );
        // Final attempt still blocked. Don't ship a bad booking routing.
        // Flip escalate_to_human so a human teammate picks it up; the
        // webhook-processor will pause aiActive + create a notification.
        parsed.escalateToHuman = true;
      } else if (restrictedFundingBlocked) {
        console.error(
          `[ai-engine] Funding-partner geography gate EXHAUSTED ${MAX_RETRIES + 1} attempts — replacing unsafe funding pitch with human handoff for convo ${activeConversationId}`
        );
        parsed.message =
          "i don't wanna point you into the wrong route here bro. lemme have the team double-check the right next step for where you're based.";
        parsed.messages = [parsed.message];
        parsed.stage = 'SOFT_EXIT';
        parsed.softExit = false;
        parsed.escalateToHuman = true;
      } else if (fixBBlocked || fabricationBlocked) {
        // Fix B / booking-fabrication exhaustion — soft-fail policy
        // (2026-04-20 policy change). Shipping d2a03e8's hard-escalate
        // created too many cold pauses on conversations where the LLM
        // was being overly cautious or where the gate pattern tripped
        // on legitimate content. New behavior: ship the last
        // best-effort response AS-IS, keep aiActive=true, log an
        // audit row with a dedicated reason. The dashboard Action
        // Required surfaces the row as an amber "unverified_sent"
        // item so the operator reviews during their daily check
        // without the lead getting ghosted mid-conversation.
        //
        // R24 (pre-Fix-A/B behavior) and distress detection retain
        // their hard-escalation behavior — they catch stricter
        // classes of failure (capital-below-threshold booking
        // attempts, suicidal language) where silent best-effort is
        // not acceptable.
        const which = fixBBlocked ? 'Fix B' : 'booking fabrication';
        console.warn(
          `[ai-engine] ${which} gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort (no escalate), logging audit row for dashboard review`
        );
        try {
          await prisma.bookingRoutingAudit.create({
            data: {
              conversationId: activeConversationId!,
              accountId,
              personaMinimumCapital: capitalThreshold,
              routingAllowed: false,
              regenerationForced: true,
              blockReason: 'gate_exhausted_sent_best_effort',
              aiStageReported: parsed.stage || null,
              aiSubStageReported: parsed.subStage || null,
              contentPreview: parsed.message.slice(0, 200)
            }
          });
        } catch (auditErr) {
          console.error(
            '[ai-engine] gate_exhausted_sent_best_effort audit write failed (non-fatal):',
            auditErr
          );
        }
      } else if (unnecessarySchedulingQuestionFailed) {
        console.error(
          `[ai-engine] Unnecessary scheduling question gate exhausted ${MAX_RETRIES + 1} attempts — forcing escalate_to_human on convo ${activeConversationId}`
        );
        parsed.escalateToHuman = true;
      } else if (logisticsBeforeQualificationFailed) {
        console.error(
          `[ai-engine] Logistics-before-qualification gate exhausted ${MAX_RETRIES + 1} attempts — forcing escalate_to_human on convo ${activeConversationId}`
        );
        parsed.escalateToHuman = true;
      } else if (!quality.passed) {
        // Voice quality gate exhausted. Most voice-quality failures are
        // "soft" — low score from missing emoji, one long sentence,
        // minor voice drift. Best-effort ship for those is fine.
        //
        // But some voice-quality hard fails produce output that's
        // objectively UNSHIPPABLE regardless of the rest of the
        // message:
        //   - bracketed_placeholder_leaked: literal "[BOOKING LINK]"
        //     reaches the lead, who can't click it — Steven Petty
        //     2026-04-20 incident.
        //   - link_promise_without_url: "I'll send you the link" with
        //     no URL anywhere — the ship has nothing to deliver.
        //   - empty output: nothing to send at all.
        //
        // For these unshippable classes, escalate to human instead of
        // best-effort shipping. The operator review workflow is a
        // better fallback than shipping a broken message to the lead.
        const allBubblesEmpty =
          !Array.isArray(parsed.messages) ||
          parsed.messages.length === 0 ||
          parsed.messages.every(
            (b) => typeof b !== 'string' || b.trim().length === 0
          );
        const hasUnshippableFailure = quality.hardFails.some(
          (f) =>
            f.includes('bracketed_placeholder_leaked:') ||
            f.includes('link_promise_without_url:') ||
            f.includes('markdown_in_single_bubble:') ||
            f.includes('call_pitch_before_capital_verification:')
        );
        if (allBubblesEmpty) {
          console.error(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts AND final output is empty — forcing escalate_to_human on convo ${activeConversationId}`
          );
          parsed.escalateToHuman = true;
        } else if (hasUnshippableFailure) {
          console.error(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts with UNSHIPPABLE hard fail — forcing escalate_to_human on convo ${activeConversationId}. hardFails=${JSON.stringify(quality.hardFails)}`
          );
          parsed.escalateToHuman = true;
        } else {
          console.warn(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort`
          );
        }
      }
    }
  }

  // R24 audit log — one row per qualifying attempt. Written only when
  // the gate actually ran (i.e. the reply was routing to booking-handoff
  // AND a threshold was configured). Makes R24 compliance queryable via
  // a single WHERE routingAllowed=false query.
  if (
    r24WasEvaluatedThisTurn &&
    activeConversationId &&
    typeof capitalThreshold === 'number'
  ) {
    try {
      await prisma.bookingRoutingAudit.create({
        data: {
          conversationId: activeConversationId,
          accountId,
          personaMinimumCapital: capitalThreshold,
          verificationAskedAtMessageId: r24LastResult.verificationAskedAt,
          verificationConfirmedAtMessageId:
            r24LastResult.verificationConfirmedAt,
          routingAllowed: !r24LastResult.blocked,
          regenerationForced: r24GateEverForcedRegen
        }
      });
    } catch (err) {
      console.error('[ai-engine] R24 audit write failed (non-fatal):', err);
    }
  }

  if (!parsed) {
    throw new Error('Failed to generate AI response');
  }

  // 6. Get response delay from the account (global setting, set on Scripts page).
  // voiceNotesEnabled still lives on the persona for now.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { responseDelayMin: true, responseDelayMax: true }
  });
  const persona =
    (await prisma.aIPersona.findFirst({
      where: { accountId, isActive: true },
      orderBy: { updatedAt: 'desc' },
      select: { voiceNotesEnabled: true }
    })) ??
    (await prisma.aIPersona.findFirst({
      where: { accountId },
      orderBy: { updatedAt: 'desc' },
      select: { voiceNotesEnabled: true }
    }));

  const delayMin = account?.responseDelayMin ?? 300;
  const delayMax = account?.responseDelayMax ?? 600;
  const { humanResponseDelay } = await import('@/lib/delay-utils');
  const suggestedDelay = humanResponseDelay(delayMin, delayMax);

  const shouldVoiceNote =
    parsed.format === 'voice_note' && (persona?.voiceNotesEnabled ?? false);

  // 7. Get prompt version for tracking
  const systemPromptVersion = await getPromptVersion(accountId);

  // 8. Create AISuggestion record for closed-loop training (non-fatal)
  let suggestionId: string | null = null;
  try {
    // Check account's current training phase for snapshot
    const accountRow = await prisma.account.findUnique({
      where: { id: accountId },
      select: { trainingPhase: true }
    });
    const isOnboarding = accountRow?.trainingPhase === 'ONBOARDING';

    // Resolve the conversationId from the last lead message in history
    // (passed via leadContext, but we need the actual convo ID — the caller
    // must provide it; we extract from the conversation history context)
    const lastMsg = [...conversationHistory].reverse().find((m) => m.id);
    let convoId: string | null = null;
    if (lastMsg?.id) {
      const msgRow = await prisma.message.findUnique({
        where: { id: lastMsg.id },
        select: { conversationId: true }
      });
      convoId = msgRow?.conversationId || null;
    }

    if (convoId) {
      // Multi-bubble: persist the full array on messageBubbles so override
      // detection can Jaccard-compare the human's takeover against the
      // joined group. responseText still carries messages[0] for
      // back-compat with any legacy consumer that reads it directly.
      const suggestion = await prisma.aISuggestion.create({
        data: {
          conversationId: convoId,
          accountId,
          responseText: parsed.message,
          messageBubbles:
            parsed.messages.length > 1
              ? (parsed.messages as Prisma.InputJsonValue)
              : undefined,
          bubbleCount: parsed.messages.length,
          retrievalTier: null, // TODO: pipe from retriever in future
          qualityGateAttempts,
          qualityGateScore: finalQualityScore,
          qualityGatePassedFirstAttempt,
          intentClassification: detectedIntent || null,
          intentConfidence: null, // TODO: pipe from classifier in future
          leadStageSnapshot: leadContext.status || null,
          leadTypeSnapshot: leadContext.experience || null,
          generatedDuringTrainingPhase: isOnboarding,
          modelUsed: modelUsedFinal,
          inputTokens: usageTotal.inputTokens,
          outputTokens: usageTotal.outputTokens,
          cacheReadTokens: usageTotal.cacheReadTokens,
          cacheCreationTokens: usageTotal.cacheCreationTokens
        }
      });
      suggestionId = suggestion.id;
    }
  } catch (err) {
    console.error('[ai-engine] AISuggestion write failed (non-fatal):', err);
  }

  // Derive the R24 capital-verification outcome for this turn. The
  // webhook-processor consumes this to drive Lead.stage — a FAILED
  // outcome must route the lead to UNQUALIFIED rather than QUALIFIED,
  // and a non-passing outcome must not promote past QUALIFYING.
  // If R24 wasn't evaluated (no threshold configured, or this turn
  // wasn't routing to booking handoff) we emit `not_evaluated` — the
  // consumer treats that as "no signal" and falls back to the
  // stage-name mapping.
  let capitalOutcome: CapitalOutcome;
  if (!r24WasEvaluatedThisTurn) {
    capitalOutcome = 'not_evaluated';
  } else {
    switch (r24LastResult.reason) {
      case 'confirmed_amount':
      case 'confirmed_affirmative':
        capitalOutcome = 'passed';
        break;
      case 'answer_below_threshold':
        capitalOutcome = 'failed';
        break;
      case 'answer_hedging':
        capitalOutcome = 'hedging';
        break;
      case 'answer_ambiguous':
      case 'answer_prop_firm_only':
        // Prop-firm-only is an ambiguous-class outcome for the
        // downstream `capitalOutcome` consumer (lead.stage mapping).
        // The directive-specific handling lives in the R24 override
        // switch above; the lead.stage side just needs "not passed".
        capitalOutcome = 'ambiguous';
        break;
      case 'never_asked':
      case 'asked_but_no_answer':
        capitalOutcome = 'not_asked';
        break;
      default:
        capitalOutcome = 'not_asked';
    }
  }

  return {
    reply: parsed.message,
    messages: parsed.messages,
    format: parsed.format as 'text' | 'voice_note',
    stage: parsed.stage,
    subStage: parsed.subStage,
    stageConfidence: parsed.stageConfidence,
    sentimentScore: parsed.sentimentScore,
    experiencePath: parsed.experiencePath,
    objectionDetected: parsed.objectionDetected,
    stallType: parsed.stallType,
    affirmationDetected: parsed.affirmationDetected,
    followUpNumber: parsed.followUpNumber,
    softExit: parsed.softExit,
    escalateToHuman: parsed.escalateToHuman,
    leadTimezone: parsed.leadTimezone,
    selectedSlotIso: parsed.selectedSlotIso,
    leadEmail: parsed.leadEmail,
    suggestedTag: parsed.suggestedTag,
    suggestedTags: parsed.suggestedTags,
    shouldVoiceNote,
    voiceNoteAction: parsed.voiceNoteAction,
    qualityScore: Math.round(parsed.stageConfidence * 100),
    suggestedDelay,
    systemPromptVersion,
    suggestionId,
    capitalOutcome
  };
}

// ---------------------------------------------------------------------------
// Provider Resolution (per-account BYOK with env fallback)
// ---------------------------------------------------------------------------

const SONNET_46_MODEL = 'claude-sonnet-4-6';
// Default main-generation model for all OpenAI-routed accounts. GPT-5.4
// mini: accepts temp=0.85 + JSON response_format, requires
// max_completion_tokens (handled in callOpenAI). Swapped from
// gpt-4o-mini 2026-04-24 after the Sonnet 4.6 watch.
const OPENAI_DEFAULT_MODEL = 'gpt-5.4-mini';

async function resolveAIProvider(accountId: string): Promise<{
  provider: 'openai' | 'anthropic';
  apiKey: string | undefined;
  model: string;
  /** OpenAI creds used by the Anthropic fallback path (and only then). */
  fallback?: { apiKey: string; model: string };
}> {
  // Read the account-level routing flag. `aiProvider='anthropic'` flips
  // main generation onto Claude Sonnet 4.6 without removing the OpenAI
  // key — the key stays available as the fallback when Anthropic errors.
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { aiProvider: true }
  });

  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  const openaiKey =
    (openaiCreds?.apiKey as string | undefined) ?? process.env.OPENAI_API_KEY;
  const openaiModel =
    (openaiCreds?.model as string | undefined) || OPENAI_DEFAULT_MODEL;

  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  const anthropicKey =
    (anthropicCreds?.apiKey as string | undefined) ??
    process.env.ANTHROPIC_API_KEY;

  if (account?.aiProvider === 'anthropic') {
    const fallback =
      openaiKey !== undefined
        ? { apiKey: openaiKey, model: openaiModel }
        : undefined;
    return {
      provider: 'anthropic',
      apiKey: anthropicKey,
      model: (anthropicCreds?.model as string) || SONNET_46_MODEL,
      fallback
    };
  }

  // Default path: current credential-based resolution.
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      model: openaiModel
    };
  }

  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: (anthropicCreds.model as string) || 'claude-sonnet-4-20250514'
    };
  }

  // Fallback to env vars
  const envProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = envProvider === 'anthropic' ? 'anthropic' : 'openai';
  const apiKey = provider === 'anthropic' ? anthropicKey : openaiKey;
  const model =
    process.env.AI_MODEL ||
    (provider === 'anthropic'
      ? 'claude-sonnet-4-20250514'
      : OPENAI_DEFAULT_MODEL);

  return { provider: provider as 'openai' | 'anthropic', apiKey, model };
}

// ---------------------------------------------------------------------------
// Format Conversation History for LLM
// ---------------------------------------------------------------------------

function extractQuestionsFromText(text: string): string[] {
  if (!text) return [];
  const questions: string[] = [];
  const matches = text.match(/[^?!.\n]*\?/g) || [];
  for (const match of matches) {
    const question = match.trim().replace(/\?+$/, '').trim();
    if (question.length > 0) questions.push(question);
  }
  return questions;
}

function extractLastAIQuestions(aiMessages: string[], limit: number): string[] {
  const questions: string[] = [];
  for (let i = aiMessages.length - 1; i >= 0 && questions.length < limit; i--) {
    const messageQuestions = extractQuestionsFromText(aiMessages[i]);
    for (
      let j = messageQuestions.length - 1;
      j >= 0 && questions.length < limit;
      j--
    ) {
      questions.unshift(messageQuestions[j]);
    }
  }
  return questions;
}

function isBotDetectionQuestion(text: string): boolean {
  return /\b(are\s+you\s+(a\s+)?(bot|robot|ai|automated|auto[-\s]?reply|programmed)|is\s+this\s+(a\s+)?(bot|robot|ai|automated|auto[-\s]?reply|programmed)|is\s+(this|that)\s+(automated|programmed|a\s+bot|a\s+robot|ai)|auto[-\s]?reply|programmed\s+(response|reply)|am\s+i\s+talking\s+to\s+(a\s+)?(bot|robot|ai)|real\s+person)\b/i.test(
    text
  );
}

function hasCapitalVerificationQuestionAndAnswer(
  history: ConversationMessage[]
): boolean {
  let capitalQuestionSeen = false;

  for (const msg of history) {
    if (
      (msg.sender === 'AI' || msg.sender === 'HUMAN') &&
      containsCapitalQuestion(msg.content)
    ) {
      capitalQuestionSeen = true;
      continue;
    }

    if (
      capitalQuestionSeen &&
      msg.sender === 'LEAD' &&
      msg.content.trim().length > 0
    ) {
      return true;
    }
  }

  return false;
}

function formatConversationForLLM(
  history: ConversationMessage[]
): LLMMessage[] {
  return history.map((msg) => {
    // LEAD messages → user role, AI/HUMAN messages → assistant role
    if (msg.sender === 'LEAD') {
      if (msg.imageUrl) {
        const text =
          msg.content && !['[Image]', '[Chart shared]'].includes(msg.content)
            ? msg.content
            : 'The lead sent this image without any text message.';
        return {
          role: 'user' as const,
          content: [
            {
              type: 'image_url' as const,
              image_url: {
                url: msg.imageUrl,
                detail: 'low' as const
              }
            },
            {
              type: 'text' as const,
              text
            }
          ]
        };
      }
      return { role: 'user' as const, content: msg.content };
    }
    // Both AI and HUMAN messages are "our side" of the conversation
    const prefix = msg.sender === 'HUMAN' ? '[Human team member] ' : '';
    return { role: 'assistant' as const, content: prefix + msg.content };
  });
}

// ---------------------------------------------------------------------------
// LLM Call (OpenAI or Anthropic)
// ---------------------------------------------------------------------------

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface LLMCallResult {
  text: string;
  /** Final model that produced the text. On fallback, the fallback model. */
  modelUsed: string;
  usage: LLMUsage;
}

const EMPTY_USAGE: LLMUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0
};

const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini';
const OPENAI_FALLBACK_MARKER = 'gpt-4o-mini-fallback';

async function callLLM(
  provider: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[],
  /** Fallback credentials used when the Anthropic path throws. */
  fallback?: { apiKey: string; model: string }
): Promise<LLMCallResult> {
  if (provider === 'anthropic') {
    try {
      return await callAnthropic(apiKey, model, systemPrompt, messages);
    } catch (err) {
      // Fallback: swap to OpenAI so the conversation keeps moving. We
      // mark modelUsed with a dedicated suffix so dashboard + analytics
      // can flag accounts seeing high fallback rates without guessing.
      console.error(
        `[ai-engine] Anthropic call failed (${model}), falling back to ${OPENAI_FALLBACK_MODEL}:`,
        err instanceof Error ? err.message : err
      );
      if (!fallback?.apiKey) {
        // No OpenAI creds available — re-throw so the upstream retry
        // loop can handle it. Better than silent empty-reply ship.
        throw err;
      }
      const res = await callOpenAI(
        fallback.apiKey,
        fallback.model,
        systemPrompt,
        messages
      );
      return { ...res, modelUsed: OPENAI_FALLBACK_MARKER };
    }
  }
  return callOpenAI(apiKey, model, systemPrompt, messages);
}

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[]
): Promise<LLMCallResult> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  // GPT-5 family rejects `max_tokens` — must use `max_completion_tokens`.
  // gpt-4o-mini (the fallback) also accepts `max_completion_tokens`, so
  // we route via it universally to keep one call shape regardless of
  // which OpenAI model ends up here.
  const response = await client.chat.completions.create({
    model,
    temperature: 0.85,
    max_completion_tokens: 1500,
    // Force OpenAI to emit a valid JSON object. The system prompt already
    // demands JSON, but stacked directive blocks sometimes steered the
    // model into plain text — this guarantees the response parses.
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system' as const, content: systemPrompt },
      ...messages
    ] as any
  });

  // OpenAI caches long prompts (>1024 tokens) automatically — no
  // request-side cache_control needed. `prompt_tokens_details.cached_tokens`
  // exposes the hit count when caching is active. We map it onto the
  // Anthropic-shaped LLMUsage so AISuggestion's cost columns stay
  // uniform across providers.
  const details = response.usage as {
    prompt_tokens_details?: { cached_tokens?: number };
  };
  const cached = details?.prompt_tokens_details?.cached_tokens ?? 0;

  return {
    text: response.choices[0]?.message?.content?.trim() || '',
    modelUsed: model,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheCreationTokens: 0
    }
  };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: LLMMessage[]
): Promise<LLMCallResult> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  // Anthropic requires messages to start with user role
  let anthropicMessages: LLMMessage[] = [...messages];
  if (
    anthropicMessages.length > 0 &&
    anthropicMessages[0].role === 'assistant'
  ) {
    anthropicMessages = [
      {
        role: 'user' as const,
        content: '[Conversation started by our team]'
      },
      ...anthropicMessages
    ];
  }

  // Anthropic also requires alternating roles — merge consecutive same-role messages
  anthropicMessages = mergeConsecutiveRoles(anthropicMessages);
  const anthropicPayloadMessages = anthropicMessages.map((message) => ({
    role: message.role,
    content: toAnthropicContent(message.content)
  }));

  // Prompt caching: the ~60K-token system prompt is stable across turns
  // in a conversation (persona + script + rules only change on script
  // edits). Marking it with ephemeral cache_control halves input cost
  // on every turn after the first — cache TTL is 5min, which covers
  // any normal multi-turn chat window.
  const response = await client.messages.create({
    model,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ],
    temperature: 0.85,
    max_tokens: 1500,
    messages: anthropicPayloadMessages as any
  });

  const textBlock = response.content.find(
    (block: { type: string }) => block.type === 'text'
  );
  const text = (
    textBlock && 'text' in textBlock ? (textBlock.text as string) : ''
  ).trim();

  // Usage shape varies slightly across SDK versions — defensive reads.
  const u = response.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  return {
    text,
    modelUsed: model,
    usage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheReadTokens: u?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u?.cache_creation_input_tokens ?? 0
    }
  };
}

/**
 * Accumulate per-call usage into a running total across voice-gate
 * retries. The suggestion row stores the totals so cost tracking
 * reflects every generation that went into producing the shipped text.
 */
function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens
  };
}

type AnthropicContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      source: {
        type: 'url';
        url: string;
      };
    };

function contentToParts(content: LLMMessageContent): LLMContentPart[] {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return content;
}

function mergeMessageContent(
  first: LLMMessageContent,
  second: LLMMessageContent
): LLMMessageContent {
  if (typeof first === 'string' && typeof second === 'string') {
    return `${first}\n${second}`;
  }
  return [
    ...contentToParts(first),
    { type: 'text', text: '\n' },
    ...contentToParts(second)
  ];
}

function toAnthropicContent(
  content: LLMMessageContent
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return {
      type: 'image',
      source: {
        type: 'url',
        url: part.image_url.url
      }
    };
  });
}

/**
 * Merge consecutive messages with the same role (required by Anthropic).
 */
function mergeConsecutiveRoles(messages: LLMMessage[]): LLMMessage[] {
  if (messages.length === 0) return messages;

  const merged: LLMMessage[] = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content = mergeMessageContent(last.content, msg.content);
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Parse AI Response (structured JSON)
// ---------------------------------------------------------------------------

interface ParsedAIResponse {
  format: string;
  /**
   * First bubble of the group. Backward-compat field — all existing
   * downstream consumers can keep reading `.message`. When the LLM
   * emits messages[], this equals messages[0].
   */
  message: string;
  /**
   * Always populated array of 1-4 bubble strings. Single-message
   * responses appear as `[message]`. Multi-bubble responses contain
   * the full ordered array. Downstream delivery iterates over this.
   */
  messages: string[];
  stage: string;
  subStage: string | null;
  stageConfidence: number;
  sentimentScore: number;
  experiencePath: string | null;
  objectionDetected: string | null;
  stallType: string | null;
  affirmationDetected: boolean;
  followUpNumber: number | null;
  softExit: boolean;
  escalateToHuman: boolean;
  leadTimezone: string | null;
  selectedSlotIso: string | null;
  leadEmail: string | null;
  suggestedTag: string;
  suggestedTags: string[];
  voiceNoteAction: { slot_id: string } | null;
}

// Multi-bubble constants — enforced at parse time regardless of
// whether the persona's multiBubbleEnabled flag is on. LLM-side
// guardrails in the prompt also mention these, but parse-side
// validation is the source of truth.
const MAX_BUBBLES_PER_GROUP = 4;
const MIN_BUBBLE_CHARS = 2;

/**
 * Normalise the bubble array extracted from the LLM JSON. Filters
 * empty / too-short entries, coerces non-strings to strings, caps at
 * MAX_BUBBLES_PER_GROUP with a soft-warn on overflow. Returns null
 * when the input doesn't parse as a usable array — caller falls back
 * to the single-message path.
 */
function normaliseBubbles(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const strings = raw
    .map((x) => (typeof x === 'string' ? x : String(x ?? '')))
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_BUBBLE_CHARS);
  if (strings.length === 0) return null;
  if (raw.length > MAX_BUBBLES_PER_GROUP) {
    console.warn(
      `[ai-engine] LLM emitted ${raw.length} bubbles; capping at ${MAX_BUBBLES_PER_GROUP} and dropping the remainder`
    );
  }
  return strings.slice(0, MAX_BUBBLES_PER_GROUP);
}

function parseAIResponse(raw: string): ParsedAIResponse {
  const defaults: ParsedAIResponse = {
    format: 'text',
    message: raw,
    messages: [raw],
    stage: '',
    subStage: null,
    stageConfidence: 0.5,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: null,
    affirmationDetected: false,
    followUpNumber: null,
    softExit: false,
    escalateToHuman: false,
    leadTimezone: null,
    selectedSlotIso: null,
    leadEmail: null,
    suggestedTag: '',
    suggestedTags: [],
    voiceNoteAction: null
  };

  try {
    let jsonStr = raw;

    // Strip markdown code fences if present
    const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const obj = JSON.parse(jsonStr);

    // Pick bubbles from either messages[] (multi-bubble persona) or
    // wrap message (single-message). Both paths end with a populated
    // `messages: string[]` — downstream never has to branch on format.
    const fromArray = normaliseBubbles(obj.messages);
    const fromString =
      typeof obj.message === 'string' && obj.message.trim().length > 0
        ? obj.message
        : raw;

    // Auto-split fallback (daetradez 2026-04-24): even with the
    // strengthened multi-bubble prompt block, gpt-5.4-mini (and the
    // other gpt-5.x minis in testing) frequently ignore the messages[]
    // instruction and emit thoughts joined by \n\n in a single
    // "message" field — e.g. "damn bro, that's a real grind\n\ngotchu
    // though, if you got 2k set aside you're in a decent spot\n\nhow
    // soon are you tryna make the jump?". Splitting on double-newline
    // here guarantees the delivery pipeline ships each thought as its
    // own bubble regardless of whether the LLM obeyed the schema.
    // Cap at MAX_BUBBLES_PER_GROUP so a runaway output doesn't ship
    // eight bubbles. Only activates when the LLM did NOT provide a
    // messages[] array — when it did, we trust its boundaries.
    let messages: string[];
    if (fromArray !== null) {
      messages = fromArray;
    } else {
      const split: string[] = fromString
        .split(/\n{2,}/)
        .map((s: string) => s.trim())
        .filter((s: string) => s.length >= MIN_BUBBLE_CHARS);
      if (split.length >= 2) {
        messages = split.slice(0, MAX_BUBBLES_PER_GROUP);
        if (split.length > MAX_BUBBLES_PER_GROUP) {
          console.warn(
            `[ai-engine] parseAIResponse auto-split produced ${split.length} bubbles; capping at ${MAX_BUBBLES_PER_GROUP}`
          );
        }
      } else {
        messages = [fromString];
      }
    }
    const message = messages[0] ?? fromString;

    // Observability for the 2026-04-19 empty-message incident: if the
    // LLM emitted JSON with no usable text anywhere, loudly log the
    // raw payload (first 500 chars) so we can root-cause whether the
    // model is returning {}/null or formatting the reply outside the
    // expected fields. The retry loop's MAX_RETRIES-empty branch and
    // sendAIReply's hard gate both backstop this — this is purely a
    // diagnostic breadcrumb.
    const allEmpty = messages.every(
      (m) => typeof m !== 'string' || m.trim().length === 0
    );
    if (allEmpty) {
      console.warn(
        `[ai-engine] parseAIResponse produced empty messages[] — downstream will escalate. Raw first 500 chars: ${raw.slice(0, 500)}`
      );
    }

    return {
      format: obj.format || 'text',
      message,
      messages,
      stage: obj.stage || '',
      subStage: obj.sub_stage || null,
      stageConfidence:
        typeof obj.stage_confidence === 'number'
          ? Math.max(0, Math.min(1, obj.stage_confidence))
          : 0.5,
      sentimentScore:
        typeof obj.sentiment_score === 'number'
          ? Math.max(-1, Math.min(1, obj.sentiment_score))
          : 0,
      experiencePath: obj.experience_path || null,
      objectionDetected: obj.objection_detected || null,
      stallType: obj.stall_type || null,
      affirmationDetected: obj.affirmation_detected === true,
      followUpNumber:
        typeof obj.follow_up_number === 'number' ? obj.follow_up_number : null,
      softExit: obj.soft_exit === true,
      escalateToHuman: obj.escalate_to_human === true,
      leadTimezone:
        typeof obj.lead_timezone === 'string' && obj.lead_timezone.trim()
          ? obj.lead_timezone.trim()
          : null,
      selectedSlotIso:
        typeof obj.selected_slot_iso === 'string' &&
        obj.selected_slot_iso.trim()
          ? obj.selected_slot_iso.trim()
          : null,
      leadEmail:
        typeof obj.lead_email === 'string' && obj.lead_email.trim()
          ? obj.lead_email.trim()
          : null,
      suggestedTag: obj.suggested_tag || '',
      suggestedTags: Array.isArray(obj.suggested_tags)
        ? obj.suggested_tags
        : [],
      voiceNoteAction: obj.voice_note_action || null
    };
  } catch {
    console.warn(
      '[ai-engine] JSON parse failed — LLM returned plain text instead of JSON. Falling back to defaults. First 200 chars:',
      raw.slice(0, 200)
    );
    // If JSON parsing fails, treat the whole response as a plain text message
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// R24 — Capital verification gate helpers
// ---------------------------------------------------------------------------
// These back the code-level enforcement layer documented at the top of
// the retry loop. The prompt-only R24 (in ai-prompts.ts master template)
// was not reliably followed in production because the script's concrete
// flow outranks abstract rules at decision points. This gate catches
// bad routings post-generation and forces regeneration. See the policy
// note at the top of ai-prompts.ts for the general principle.

/**
 * Discriminated reason for why the R24 gate made its decision. The
 * caller uses this to pick the right override directive on regen:
 * "ask the question" vs "pivot to downsell — lead is below threshold"
 * vs "ask clarifying question". `confirmed_*` reasons mean the gate
 * passed; everything else means blocked.
 */
type R24Reason =
  | 'confirmed_amount' // Lead stated a concrete amount >= threshold
  | 'confirmed_affirmative' // Lead said "yeah" to a threshold-confirming Q (legacy path)
  | 'never_asked' // No verification Q found in conversation history
  | 'asked_but_no_answer' // Q found, no subsequent LEAD reply yet
  | 'answer_below_threshold' // Lead stated amount < threshold OR said "not much" / "broke"
  | 'answer_hedging' // Lead hedged ("kinda", "working on it") without a number
  | 'answer_ambiguous' // Lead's reply didn't parse ("depends", "varies")
  | 'answer_prop_firm_only'; // Lead mentioned a prop firm but no personal capital

interface R24GateResult {
  /** True = block this response, force regen with override directive. */
  blocked: boolean;
  /** Fine-grained reason — drives which override directive the caller injects. */
  reason: R24Reason;
  /** Concrete amount parsed from the lead's reply (if any). */
  parsedAmount: number | null;
  /** Message.id of the AI message that asked the verification question. */
  verificationAskedAt: string | null;
  /** Message.id of the LEAD message that confirmed. */
  verificationConfirmedAt: string | null;
}

/**
 * Heuristic: does this LLM response route the lead into booking-handoff
 * messaging? Widened (Fix A, 2026-04-20) after the Nez Futurez incident
 * where `stage='BOOKING'` with `sub_stage=null` bypassed the gate. Fires
 * on ANY of these conditions — one match is enough:
 *
 *   1. `stage === 'BOOKING'` — regardless of sub_stage. If the LLM self-
 *      reports BOOKING, treat it as attempted routing, full stop.
 *   2. `stage === 'SOFT_PITCH_COMMITMENT'` AND the reply contains a URL.
 *      A URL drop at soft-pitch stage IS a booking attempt even when the
 *      LLM didn't promote itself to BOOKING.
 *   3. Reply content matches any handoff / call-pitch phrase — catches
 *      "hop on a quick chat with Anthony" at ANY stage including the
 *      early-qualification ones the LLM sometimes mislabels. A
 *      verification question ("you got at least $X ready?") does NOT
 *      match these patterns so it correctly falls through the gate.
 */
export function isRoutingToBookingHandoff(parsed: ParsedAIResponse): boolean {
  // Rule 1: BOOKING stage at any sub_stage.
  if (parsed.stage === 'BOOKING') {
    return true;
  }
  // Rule 2: SOFT_PITCH_COMMITMENT + any URL in the reply body.
  // Look at the JOINED group text so a multi-bubble turn where the URL
  // is in bubble 1 and the pitch is in bubble 0 gets caught as a unit.
  const joinedReply =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  const hasUrl = /\bhttps?:\/\/\S+|\bwww\.\S+/i.test(joinedReply);
  if (parsed.stage === 'SOFT_PITCH_COMMITMENT' && hasUrl) {
    return true;
  }
  // Rule 3: phrase-match handoff / call-pitch language regardless of
  // reported stage. Widened phrase list — catches Nez's "send you the
  // link to apply" at 01:48 plus the soft-pitch "hop on a quick chat
  // with Anthony" pattern that doesn't name-check the closer in the
  // existing patterns.
  const handoffPhrases =
    /\b(team\s+(is\s+)?(gonna|going\s+to|will)\s+(reach\s+out|get\s+in\s+touch|contact\s+you|set\s+(you\s+)?up|get\s+you\s+set|be\s+in\s+touch)|check\s+your\s+email\s+for\s+(the|your)\s+(call|confirmation|zoom|invite)|you'?re\s+all\s+set|locked\s+in\s+for|call\s+confirmation|send(ing)?\s+you\s+(the|a)\s+link\s+(to|for)\s+(apply|book|grab|schedule)|here'?s\s+the\s+link|hop\s+on\s+a\s+(quick\s+)?(call|chat)|get\s+you\s+(all\s+)?set\s+up|link\s+to\s+(book|apply|grab|schedule)|gonna\s+send\s+you\s+the\s+link|fill\s+(it\s+|everything\s+)?out\s+and\s+(lmk|let\s+me\s+know)|ready\s+to\s+scale\s+up.*call|break\s+everything\s+down\s+for\s+you)\b/i;
  return handoffPhrases.test(joinedReply);
}

/**
 * Fix B — content-level advancement detection, independent of what the
 * LLM self-reports for `stage`. An implicit "let me get you on a call
 * with Anthony" pitched at stage=SITUATION_DISCOVERY is still an
 * advancement attempt and must hit the capital gate. Wider net than
 * `isRoutingToBookingHandoff` so it catches LLM outputs that mislabel
 * their stage.
 *
 * Fires on any of:
 *   - Reported stage in the advancement set (BOOKING,
 *     SOFT_PITCH_COMMITMENT, FINANCIAL_SCREENING)
 *   - Content matches a pitch / handoff / book-the-call phrase
 *
 * Returns false for verification questions ("you got at least $X?")
 * and for normal qualification Q&A.
 */
export function detectBookingAdvancement(
  parsed: ParsedAIResponse,
  closerNames: string[] = []
): boolean {
  const stage = (parsed.stage || '').toUpperCase();
  if (
    stage === 'BOOKING' ||
    stage === 'SOFT_PITCH_COMMITMENT' ||
    stage === 'FINANCIAL_SCREENING'
  ) {
    return true;
  }
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  // Content phrase list — tuned to Daniel's script patterns.
  // Includes "right hand man" / closer-name mentions because the AI
  // frequently pitches the call by name-checking the closer.
  const advancementPhrases: RegExp[] = [
    /\bhop\s+on\s+a\s+(quick\s+)?(call|chat)\b/i,
    /\bget\s+you\s+on\s+a\s+(quick\s+)?(call|chat)\b/i,
    /\bsend(ing)?\s+you\s+the\s+link\b/i,
    /\blink\s+to\s+(apply|book|grab|schedule)\b/i,
    /\bfill\s+(it\s+|everything\s+)?out\b/i,
    /\bset\s+(it\s+|you\s+)?up\s+with\b/i,
    /\bbreak\s+everything\s+down\s+for\s+you\b/i,
    /\bright\s+hand\s+man\b/i,
    /\bready\s+to\s+(scale|level)\s+up\b/i,
    /\bgonna\s+send\s+you\s+the\s+link\b/i,
    /\bhere'?s\s+the\s+link\b/i,
    /\b(you'?re\s+)?all\s+set\b/i
  ];
  if (advancementPhrases.some((p) => p.test(joined))) return true;
  // Closer-name mentions combined with call-arrangement language.
  // Fires when the LLM says "chat with {closerName}" or similar at
  // ANY stage — Daniel's AI has pitched "Anthony" at OPENING before.
  for (const name of closerNames) {
    if (!name || name.trim().length < 2) continue;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(
      `\\b(call|chat|hop\\s+on.*|set\\s+(it|you)\\s+up|link.*apply|link.*book|get\\s+you\\s+set).*${escaped}|${escaped}.*\\b(call|chat|reach\\s+out|gonna\\s+contact|get\\s+in\\s+touch)\\b`,
      'i'
    );
    if (pat.test(joined)) return true;
  }
  return false;
}

interface CapitalVerificationBlockResult {
  blocked: boolean;
  reason:
    | 'no_threshold_configured'
    | 'already_verified'
    | 'verified_in_history'
    | 'not_advancing'
    | 'capital_not_verified_before_advancement';
}

/**
 * Fix B — advancement-gate. Independent of R24's `isRoutingToBooking
 * Handoff` trigger: fires on ANY AI response that attempts to advance
 * the lead toward booking, regardless of how the LLM labeled its
 * stage. Skips when:
 *   - No capital threshold configured on the persona
 *   - A prior BookingRoutingAudit already recorded routingAllowed=true
 *     for this conversation (the lead was verified once, we don't
 *     re-gate every subsequent advancement attempt)
 *   - The capital question has been asked AND the lead's answer maps
 *     to `confirmed_amount` / `confirmed_affirmative` per the existing
 *     R24 classifier
 * Blocks when the response advances toward booking AND none of the
 * skip conditions apply. Caller is expected to inject a directive and
 * regenerate, identical in shape to R24's `never_asked` flow.
 */
async function shouldBlockForCapitalVerification(params: {
  parsed: ParsedAIResponse;
  conversationId: string;
  capitalThreshold: number | null;
  capitalCustomPrompt: string | null;
  closerNames?: string[];
  currentTurnLeadMsg?: { content: string; timestamp: Date | string };
}): Promise<CapitalVerificationBlockResult> {
  const {
    parsed,
    conversationId,
    capitalThreshold,
    capitalCustomPrompt,
    currentTurnLeadMsg
  } = params;
  if (typeof capitalThreshold !== 'number' || capitalThreshold <= 0) {
    return { blocked: false, reason: 'no_threshold_configured' };
  }
  // Short-circuit 1: prior routingAllowed=true audit for this convo
  // means the lead has passed R24 at least once. Don't re-gate further
  // advancement attempts (Daniel's script may pitch twice, confirm
  // email, etc. — we don't want to spam-block the follow-up turns).
  const prior = await prisma.bookingRoutingAudit.findFirst({
    where: { conversationId, routingAllowed: true },
    select: { id: true }
  });
  if (prior) {
    return { blocked: false, reason: 'already_verified' };
  }
  // Short-circuit 2: run the existing R24 classifier against history.
  // If the lead has stated an adequate amount or affirmed the
  // threshold-Q, treat as verified even without a prior audit row.
  // Pass the current-turn LEAD message so the classifier sees it
  // regardless of DB-snapshot timing.
  const r24 = await checkR24Verification(
    conversationId,
    capitalThreshold,
    capitalCustomPrompt,
    currentTurnLeadMsg
  );
  if (
    !r24.blocked &&
    (r24.reason === 'confirmed_amount' ||
      r24.reason === 'confirmed_affirmative')
  ) {
    return { blocked: false, reason: 'verified_in_history' };
  }
  // Check the current response for advancement. If yes → block.
  if (detectBookingAdvancement(parsed, params.closerNames ?? [])) {
    return { blocked: true, reason: 'capital_not_verified_before_advancement' };
  }
  return { blocked: false, reason: 'not_advancing' };
}

// ---------------------------------------------------------------------------
// Booking-state fabrication detector
// ---------------------------------------------------------------------------
// Daniel's system does NOT auto-book calls. The booking flow is: AI drops
// the script's booking link → lead clicks it → books themselves → team
// handles the actual call externally. There is no "anthony is on the call
// shortly" mechanism, no real-time zoom link dispatch, no automatic
// calendar-invite send.
//
// Incident driving this gate: Rufaro (daetradez, 2026-04-18) — AI said
// "anthony will be on the call with you shortly. check your email for
// the confirmation and the zoom link." Pure fabrication. R19 (never
// fabricate completed actions) was live at the prompt level but the LLM
// ignored it. This gate is the code-level enforcement.
//
// Fires when: response matches a fabrication pattern AND the conversation
// has no real scheduledCallAt + no real bookingId. Skips entirely when a
// real booking exists — the AI CAN reference a call that's actually
// scheduled.
// ---------------------------------------------------------------------------

const BOOKING_FABRICATION_PATTERNS: RegExp[] = [
  // "anthony will be on the call shortly" / "X is going to be on..."
  // and closer-name variants. Replaced `{{closerName}}` in the original
  // spec with an any-name pattern — we check both "anthony" and the
  // persona's configured closer names via caller.
  /\b(anthony|your\s+closer|the\s+closer|my\s+partner|our\s+closer)\s+(will\s+be|is\s+going\s+to\s+be|is)\s+(on\s+the\s+call|in\s+the\s+call|ready|waiting|standing\s+by|available)\s*(shortly|soon|now|with\s+you|momentarily|for\s+you)?\b/i,
  /\b(check\s+your\s+(email|inbox)|keep\s+an\s+eye\s+on\s+(your\s+)?email)\s+(for|to\s+see)\s+(the|your|a)?\s*(confirmation|zoom|link|invite|call\s+details)/i,
  /\byou'?re\s+all\s+set\s+for\s+(the|your|our)\s+(call|meeting|chat)\b/i,
  /\b(calendar|zoom|meeting|google\s+meet)\s+(invite|link|confirmation)\s+(is|has\s+been|will\s+be)?\s*(on\s+the\s+way|sent|coming|being\s+sent|in\s+your\s+inbox)/i,
  /\b(I'?ll|let\s+me|lemme|gonna|going\s+to)\s+(send|get|grab|share|drop)\s+(you\s+)?(the|that|your|a)\s*(zoom|meeting|call)\s+(link|invite|url)\b/i,
  /\bjump\s+on\s+(the\s+call|a\s+call|it)\s+(now|right\s+now|real\s+quick)\b/i,
  /\b(booked|locked)\s+(you\s+)?in\s+(for|with)\b/i,
  /\bexpect\s+(the\s+)?(zoom|meeting|calendar|confirmation)\s+(link|invite)\s+(shortly|soon|any\s+minute)/i
];

export function matchesBookingFabrication(
  reply: string,
  closerNames: string[] = []
): boolean {
  if (BOOKING_FABRICATION_PATTERNS.some((p) => p.test(reply))) return true;
  // Closer-name-specific patterns: "{closerName} will be on the call",
  // "{closerName} is ready now", etc. Run dynamically for each
  // configured closer name the persona has.
  for (const name of closerNames) {
    if (!name || name.trim().length < 2) continue;
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp(
      `\\b${escaped}\\s+(will\\s+be|is\\s+going\\s+to\\s+be|is)\\s+(on\\s+the\\s+call|in\\s+the\\s+call|ready|waiting|standing\\s+by|available)`,
      'i'
    );
    if (pat.test(reply)) return true;
  }
  return false;
}

interface BookingFabricationBlockResult {
  blocked: boolean;
  reason: 'no_real_booking' | 'real_booking_exists' | 'no_fabrication';
}

/**
 * Fix (2026-04-20) — fabrication gate. Runs on every AI response.
 * Mirrors the shape of shouldBlockForCapitalVerification.
 *
 * Blocks when:
 *   1. The reply claims real-time booking state (matches a pattern)
 *   2. The conversation has NO actual scheduledCallAt set
 *   3. The conversation has NO bookingId from a calendar integration
 *
 * Skips (returns blocked=false) when:
 *   - No fabrication pattern matched → no risk
 *   - A real booking/scheduled call exists → the AI can legitimately
 *     reference it
 */
async function shouldBlockForBookingFabrication(params: {
  parsed: ParsedAIResponse;
  conversationId: string;
  closerNames?: string[];
}): Promise<BookingFabricationBlockResult> {
  const { parsed, conversationId, closerNames = [] } = params;
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  if (!matchesBookingFabrication(joined, closerNames)) {
    return { blocked: false, reason: 'no_fabrication' };
  }
  // Fabrication pattern matched — check for a real booking.
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { scheduledCallAt: true, bookingId: true }
  });
  if (!conv) {
    // Defensive: treat as no-booking-exists if we can't read the row.
    return { blocked: true, reason: 'no_real_booking' };
  }
  if (conv.scheduledCallAt || conv.bookingId) {
    return { blocked: false, reason: 'real_booking_exists' };
  }
  return { blocked: true, reason: 'no_real_booking' };
}

/**
 * Extract a dollar amount from a free-form lead reply. Handles
 * "$5k", "5,000", "$3,000.00", "around 500", "about $2000", "3500
 * give or take", bare-number strings, and the "5k"/"2.5k" shorthand.
 * Returns null when no number is present.
 *
 * Bug fix (Tahir Khan false-positive, 2026-04-20): the previous regex
 * non-captured the decimal part, so "2.5k" parsed as 2000 instead of
 * 2500 (the `.5` was dropped before the k-multiplier). Now we capture
 * the decimal and use parseFloat → multiplying by 1000 for the k
 * suffix produces 2500. All existing test cases still pass.
 */
function parseLeadAmountFromReply(text: string): number | null {
  // Match optional $/£, integer portion (thousands-commas OR plain
  // digits), optional decimal portion, optional k/K suffix. Decimal
  // capture is necessary so "2.5k" → 2500 rather than 2000.
  // £ is matched here (not just $) so "£1,000" / "£800" amounts also
  // parse — Fix 3 (Souljah J 2026-04-25). Currency conversion is
  // applied at the threshold-comparison layer, not here.
  const m = text.match(/[$£]?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([kK])?/);
  if (!m) return null;
  const intPart = m[1].replace(/,/g, '');
  const decPart = m[2] ?? '';
  let amount = parseFloat(intPart + decPart);
  if (!Number.isFinite(amount)) return null;
  if (m[3]) amount *= 1000; // "5k" → 5000, "2.5k" → 2500
  // Round to nearest whole dollar — we compare against integer
  // thresholds, and the lead means "about $2,500" either way.
  return Math.round(amount);
}

/**
 * Classify a lead's reply to a capital question into one of five
 * kinds. Order matters: disqualifiers ("broke", "no money", "I'm a
 * student") take precedence over amount parsing, so "I got nothing, bro"
 * classifies as disqualifier even if a stray number could be extracted.
 * Hedging without a number comes next. Amount parsing fires if none
 * of the above matched. Then affirmative (for back-compat with the
 * legacy "you got at least $X?" Q). Anything else → ambiguous.
 */
interface ParsedLeadAnswer {
  kind: 'amount' | 'disqualifier' | 'hedging' | 'affirmative' | 'ambiguous';
  amount: number | null;
  /**
   * Optional fine-grained reason — lets callers pick a more specific
   * override directive when regenerating. Set for the prop-firm
   * edge case so the directive can ask for PERSONAL capital
   * specifically rather than a generic clarifier.
   */
  reason?:
    | 'prop_firm_mentioned_no_personal_capital_stated'
    | 'no_pattern_matched'
    | 'generic';
}

// Prop-firm phrase list. Lead responses that reference a prop firm but
// don't clearly state personal capital need a clarifying follow-up
// because firm capital !== personal capital — the $1k-$100k the lead
// "has" via an FTMO / Apex / Topstep challenge is the FIRM's money.
// See Tahir 2026-04-20 incident.
const PROP_FIRM_PATTERN =
  /\b(prop\s+firm|funded\s+account|funded\s+trader|ftmo|apex|topstep|the5ers|my\s+funded|firm'?s?\s+capital|firm\s+account|prop\s+challenge|challenge\s+account|funded\s+challenge|evaluation\s+account|\$k?\s*challenge|10k\s+challenge|25k\s+challenge|50k\s+challenge|100k\s+challenge|200k\s+challenge)\b/i;

// Personal-capital indicators: when these appear alongside a prop-firm
// mention, the number in the message is more likely tied to personal
// savings than firm capital ("Yeah I got 4k plus my prop firm" → 4k
// is personal). Without these, prop-firm + number classifies as
// ambiguous with the prop-firm reason.
const PERSONAL_CAPITAL_INDICATOR =
  /\b(i\s+(have|got|saved|put|set)|i'?ve\s+(got|saved|put|set)|my\s+(savings|personal|own|capital|money|side))\b/i;
const PLUS_PHRASE =
  /\b(plus|also|on\s+top\s+of|besides|separate\s+from|aside\s+from|in\s+addition\s+to|as\s+well\s+as)\b/i;

// ─── Geography gate ────────────────────────────────────────────
// Funding-partner (FTMO-style funded account) programs only accept
// leads in the US and Canada. When the lead mentions living anywhere
// else, the R24 downsell path must skip the funding-partner option
// and go straight to the $497 course or YouTube redirect. The gate
// has two sources of truth, in priority order:
//   1. `leadContext.geography` — explicit enrichment (if populated)
//   2. Message-text detection against the two regex below

// US/CA positive signal — matches when lead states they're in a
// compatible jurisdiction. Wins over a restricted-country match if
// both appear (e.g., "I'm in the US now, originally from Lebanon").
const US_CA_GEO_INDICATOR =
  /\b(united\s+states|u\.s\.a?\.?|\busa\b|\bus\b(?!\s+(trading|strategy|prop|broker))|america|american|new\s+york|california|texas|florida|canada|canadian|toronto|vancouver|montreal|ontario|quebec|alberta)\b/i;

// Restricted-country list. Not exhaustive — covers the common
// jurisdictions US funding-partner programs won't onboard. When
// matched (and US/CA is NOT), route to downsell/YouTube, NEVER
// funding partner.
const RESTRICTED_COUNTRY_PATTERN =
  /\b(lebanon|lebanese|nigeria|nigerian|zimbabwe|philippines|filipino|pilipinas|manila|cebu|davao|luzon|mindanao|pakistan|pakistani|\bindia\b|indian|bangladesh|bangladeshi|egypt|egyptian|kenya|kenyan|ghana|ghanaian|cameroon|cameroonian|south\s+africa|south\s+african|zambia|uganda|tanzania|morocco|moroccan|iran|iranian|iraq|iraqi|syria|syrian|yemen|yemeni|sudan|sudanese|afghanistan|afghan|belarus|belarusian|russia|russian|venezuela|venezuelan|cuba|cuban|north\s+korea|myanmar|burmese|vietnam|vietnamese|cambodia|laos|mongolia|kazakhstan|uzbekistan|ethiopia|ethiopian|somalia|libya|algeria|algerian|tunisia|brazil|brazilian|argentina|argentine|colombia|colombian|peru|peruvian|chile|chilean|uruguay|ecuador|uk|britain|british|england|english|scotland|scottish|ireland|irish|germany|german|france|french|spain|spanish|italy|italian|portugal|portuguese|netherlands|dutch|belgium|belgian|sweden|swedish|norway|norwegian|finland|finnish|denmark|danish|poland|polish|czech|slovakia|hungary|hungarian|romania|romanian|bulgaria|bulgarian|greece|greek|turkey|turkish|ukraine|ukrainian|australia|australian|new\s+zealand|japan|japanese|south\s+korea|korean|china|chinese|hong\s+kong|taiwan|taiwanese|singapore|singaporean|malaysia|malaysian|indonesia|indonesian|thailand|thai|east\s+african\s+time|nairobi|kampala|dar\s+es\s+salaam|addis\s+ababa)\b/i;

const EAST_AFRICA_TIME_ABBR_PATTERN = /\bEAT\b/;

const FUNDING_PARTNER_ROUTE_PATTERN =
  /\b(funding\s+partner|funded[-\s]+account|funded[-\s]+trader|funding\s+(route|option|program|path)|prop\s+firm|prop[-\s]+firm|prop\s+challenge|challenge\s+account|funded\s+challenge|third[-\s]+party\s+capital|firm\s+capital|ftmo|apex|topstep|the\s*5ers|my\s+forex\s+funds)\b/i;

function mentionsFundingPartnerRoute(parsed: ParsedAIResponse): boolean {
  const joined =
    Array.isArray(parsed.messages) && parsed.messages.length > 0
      ? parsed.messages.join(' ')
      : parsed.message;
  return FUNDING_PARTNER_ROUTE_PATTERN.test(joined);
}

/**
 * Return whether the lead should be blocked from the funding-partner
 * branch based on geography. Caller (R24 retry-loop) appends an
 * addendum to the downsell directive when restricted.
 *
 *   restricted=true  → DO NOT offer funding partner, only $497 / YT
 *   restricted=false → current behavior (eligible or unknown)
 */
export function detectRestrictedGeography(
  leadCountry: string | null | undefined,
  recentLeadMessages: string[]
): { country: string | null; restricted: boolean } {
  // Primary: explicit enrichment. US/USA/Canada/CA are the only
  // allowed strings; any other value is treated as restricted.
  const enriched = (leadCountry || '').trim();
  if (enriched.length > 0) {
    const lower = enriched.toLowerCase();
    if (
      /^(us|usa|u\.s\.a?\.?|united\s+states|america|canada|ca|canadian)$/i.test(
        lower
      )
    ) {
      return { country: enriched, restricted: false };
    }
    return { country: enriched, restricted: true };
  }

  // Secondary: message-text detection. US/CA mention wins if both
  // appear. Only the lead's OWN messages are scanned (AI messages
  // may mention countries in examples / follow-ups without being
  // diagnostic of the lead's actual location).
  const joined = recentLeadMessages.join('\n');
  const usCaMatch = joined.match(US_CA_GEO_INDICATOR);
  if (usCaMatch) {
    return { country: usCaMatch[0], restricted: false };
  }
  const restrictedMatch = joined.match(RESTRICTED_COUNTRY_PATTERN);
  if (restrictedMatch) {
    return { country: restrictedMatch[0], restricted: true };
  }
  const eastAfricaTimeMatch = joined.match(EAST_AFRICA_TIME_ABBR_PATTERN);
  if (eastAfricaTimeMatch) {
    return { country: eastAfricaTimeMatch[0], restricted: true };
  }

  // Unknown → don't restrict. Keeps current behavior for leads
  // whose location hasn't been stated in-chat or enriched. Safer
  // than defaulting to "restricted" which would block US/CA leads
  // who just haven't mentioned it yet.
  return { country: null, restricted: false };
}

export function parseLeadCapitalAnswer(raw: string): ParsedLeadAnswer {
  const text = raw.trim();

  // 1. Non-numeric disqualifiers — handle first so "I got nothing" doesn't
  //    get amount-parsed into some weird accidental hit. Split across
  //    themed groups so each signal type is self-documenting:
  //      (a) "low capital" baseline ("broke", "no money", "student")
  //      (b) "no job / no income" employment disqualifiers
  //      (c) "desperation / last hope" language — trader-of-last-resort
  //          framing is a strong R24 stop even without an explicit number
  //      (d) "can't pay basics" financial distress
  //      (e) "capital access" issues — lead has money but can't route
  //          it (business failing, sanctions, bank blocks, geopolitics).
  //          Distinct from (a) because they might technically have the
  //          amount but it's unreachable; treat as disqualifier anyway
  //          because funding-partner + prop-firm paths all require the
  //          capital to actually be usable.
  const noCapital =
    /\b(not\s+much|not\s+a\s+lot|nothing\s+really|^nothing\b|\bbroke\b|don'?t\s+have\s+(any\s+)?(money|capital|anything|much)|can'?t\s+afford|no\s+money|i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school)\b/i;
  const jobless =
    /\b(jobless|job less|unemployed|no job|lost my job|between jobs|laid off|let go|no income|no work|out of work)\b/i;
  const desperation =
    /\b(only hope|last hope|last chance|desperate|nothing left)\b/i;
  const cantAffordBasics =
    /\b(can'?t eat|can'?t pay rent|can'?t pay bills|struggling to survive)\b/i;
  const capitalAccessIssue =
    /\b(can'?t\s+fund\s+(my\s+|the\s+)?account|business\s+(is\s+)?(failing|failed|going\s+under|closing\s+down)|my\s+business\s+(is\s+)?(failing|failed|down|going\s+under|closing)|geopolitical\s+(restrictions?|issues?)|can'?t\s+transfer\s+(money|funds|anything)|under\s+sanctions?|sanctioned\s+(country|region)|economic\s+sanctions?|bank\s+(blocks?|blocked\s+me|won'?t\s+let\s+me)|my\s+country\s+(is\s+)?sanctioned|payment\s+(blocked|restricted|frozen))\b/i;
  // (f) "Need time to raise / working on it" — explicit present-tense
  // "I don't have it now, will need to build it up". Selorm Benjamin
  // Workey 2026-04-24: "Honestly, I've lost so much in this few days
  // and I will need sometime to raise that fund bro" — the old parser
  // hit the default fallback and returned `ambiguous no_pattern_matched`,
  // which kept the lead out of the disqualifier path. These phrases
  // are unambiguously "not right now" — route to downsell, don't ask
  // a clarifying question.
  const needTimeToRaise =
    /\b(need\s+(some\s+)?time\s+to\s+(raise|save|get|build(\s+up)?|come\s+up\s+with)|will\s+(need|have)\s+to\s+(raise|save|build(\s+up)?)|need\s+to\s+(raise|save|build(\s+up)?)\s+(that|the|some|enough|more|up\s+the)?\s*(fund(s)?|capital|money|amount|cash)|working\s+on\s+(raising|saving|getting|building(\s+up)?)\s+(it|the|that|the\s+capital|the\s+money|the\s+funds?)|don'?t\s+have\s+(it|that|the\s+money|the\s+capital)\s+(right\s+)?now\s+but|gotta\s+(save|raise|build)\s+(up\s+)?(first|the\s+(money|capital|funds?)))\b/i;
  // (f2) "I don't have it" and "1000usd is huge money here" forms.
  // Ptr Alvin 2026-04-26: "here 1000usd it's a huge money" after
  // saying he did not have it got amount-parsed as 1000 and incorrectly
  // passed. A threshold number framed as huge/unreachable is a capital
  // miss unless the same message clearly says they have it ready.
  const lacksReferencedAmount =
    /\b(i\s+)?(don'?t|do\s+not|doesn'?t|can'?t|cannot)\s+(have|afford|get|do|manage)\s+(it|that|this|the\s+(money|capital|funds?|amount)|\$?\d)\b/i;
  const amountIsHugeHere =
    /\b\d{3,6}\s*(usd|dollars?|\$)?\s*(is|it'?s|is\s+a|it'?s\s+a)?\s*(huge|big|large|a\s+lot\s+of)\s+money\b/i;
  const clearlyHasCapitalReady =
    /\b(i\s+(have|got|saved|have\s+saved)|i'?ve\s+(got|saved)|ready\s+with|set\s+aside)\b/i;
  // (g) "Lost what I had" — trader just lost their capital in recent
  // trading. Distinct from noCapital which covers "never had any" /
  // current broke state. This catches "I've lost so much in this few
  // days", "blew up my account", etc.
  const lostCapital =
    /\b(lost\s+(so\s+much|a\s+lot|everything|it\s+all|my\s+money|my\s+capital|all\s+my\s+(money|capital|funds|savings?))|blew\s+up\s+(my|the)\s+account|wiped\s+(out\s+)?(my|the)\s+account|account'?s?\s+(been\s+)?blown|drained\s+my\s+account)\b/i;
  if (
    noCapital.test(text) ||
    jobless.test(text) ||
    desperation.test(text) ||
    cantAffordBasics.test(text) ||
    capitalAccessIssue.test(text) ||
    needTimeToRaise.test(text) ||
    lacksReferencedAmount.test(text) ||
    (amountIsHugeHere.test(text) && !clearlyHasCapitalReady.test(text)) ||
    lostCapital.test(text)
  ) {
    return { kind: 'disqualifier', amount: 0 };
  }

  // 1b. PROP-FIRM GUARD (Tahir Khan 2026-04-20).
  //     Lead says "I'm on FTMO 100k challenge" — the number refers to
  //     the FIRM's capital, not personal. Without this check the amount
  //     parser below would happily accept 100000 and R24 would pass.
  //     Only tolerate the number when a personal-capital indicator or
  //     "plus X" phrase is present alongside the prop-firm mention
  //     (e.g. "I got 4k plus my prop firm" → 4k IS personal).
  if (PROP_FIRM_PATTERN.test(text)) {
    const hasPersonalIndicator =
      PERSONAL_CAPITAL_INDICATOR.test(text) || PLUS_PHRASE.test(text);
    if (!hasPersonalIndicator) {
      return {
        kind: 'ambiguous',
        amount: null,
        reason: 'prop_firm_mentioned_no_personal_capital_stated'
      };
    }
    // else: personal-capital language is present → fall through to
    // amount parse; the number is (likely) personal not firm-tied.
  }

  // 2. Amount (numeric parse). Even if the lead also says "kinda" or
  //    includes hedging words, a concrete number beats the hedge —
  //    we'll compare it to threshold later.
  const parsed = parseLeadAmountFromReply(text);
  if (parsed !== null) {
    return { kind: 'amount', amount: parsed };
  }

  // 3. Hedging without a concrete number.
  if (
    /\b(kinda|almost|about\s+half|working\s+on|save\s+up|not\s+yet|close\s+to|nearly|getting\s+there|not\s+quite|less\s+than|under|below|only|i\s+can\s+get\s+it|soon|in\s+a\s+bit)\b/i.test(
      text
    )
  ) {
    return { kind: 'hedging', amount: null };
  }

  // 4. Ambiguous — can't tell. Don't pass the gate.
  if (
    /\b(depends|varies|some|a\s+bit|not\s+sure|dunno|idk|i'?ll\s+let\s+you\s+know|it'?s\s+complicated|maybe)\b/i.test(
      text
    )
  ) {
    return { kind: 'ambiguous', amount: null, reason: 'generic' };
  }

  // 5. Legacy affirmative ("yeah" / "got it" / "for sure") with no
  //    number — back-compat with the threshold-confirming Q. The caller
  //    accepts this as a confirmation.
  if (
    /^(yes|yeah|yup|yep|confirmed|got\s+it|for\s+sure|i\s+do|sure|absolutely|definitely|100%|yea|ready|hell\s+yeah|let'?s\s+go)\b/i.test(
      text
    )
  ) {
    return { kind: 'affirmative', amount: null };
  }

  // Default fallback — nothing matched any category. Treat as
  // ambiguous so the gate asks a clarifying question rather than
  // silently passing. The reason tag lets the directive layer
  // distinguish "lead said something unparseable" from the other
  // explicit-ambiguous cases above.
  return { kind: 'ambiguous', amount: null, reason: 'no_pattern_matched' };
}

/**
 * Returns 'GBP' if any lead message in the conversation contains the
 * £ symbol (the lead has been talking in pounds), else 'USD'. Used by
 * the R24 gate to convert £ amounts to a USD-equivalent comparison
 * against the persona's USD-stored threshold.
 *
 * Source priority: explicit candidate texts (mergedAnswers) first, then
 * a DB scan of LEAD messages on this conversation. Defaults to USD when
 * no £ is found anywhere — matches the historical behaviour for every
 * non-GBP account.
 */
export async function detectConversationCurrency(
  conversationId: string,
  candidateTexts: string[] = []
): Promise<'GBP' | 'USD'> {
  for (const t of candidateTexts) {
    if (t && t.includes('£')) return 'GBP';
  }
  const leadMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'LEAD' },
    select: { content: true }
  });
  for (const m of leadMsgs) {
    if (m.content.includes('£')) return 'GBP';
  }
  return 'USD';
}

/**
 * Look through the conversation's AI messages for a prior capital
 * verification question (threshold-confirming OR open-ended), then
 * check the next LEAD reply. Return a structured reason so the caller
 * can pick the right regen directive ("pivot to downsell", "ask
 * clarifying Q", "just ask the verification question").
 */
async function checkR24Verification(
  conversationId: string,
  threshold: number,
  customPrompt: string | null,
  currentTurnLeadMsg?: { content: string; timestamp: Date | string }
): Promise<R24GateResult> {
  const aiMsgs = await prisma.message.findMany({
    where: { conversationId, sender: 'AI' },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true, timestamp: true }
  });

  const thresholdNoFormat = threshold.toString();
  const thresholdFormatted = threshold.toLocaleString('en-US');
  const patterns: RegExp[] = [
    // Threshold-confirming shapes (from legacy default R24 phrasing)
    /\byou got at least \$\d/i,
    /\byou have at least \$\d/i,
    /\bat least \$\d+[,\d]*\s*(in\s+capital|capital|ready|to\s+start)/i,
    /\bcapital ready\b/i,
    /\bready to start with \$/i,
    /\bjust to confirm.*\$/i,
    // Exact-threshold matches (with or without thousands comma)
    new RegExp(`\\$${thresholdNoFormat}\\b`, 'i'),
    new RegExp(`\\$${thresholdFormatted.replace(/,/g, '\\,')}`, 'i'),
    // Open-ended shapes (Daniel's new flow and similar). These pick up
    // questions like "how much do you have set aside for the markets
    // and your education in USD", "what's your budget for this",
    // "what are you working with on the capital side", etc.
    /\bhow much (do you |have you )?(got|have|set aside|saved|working with|to start|to invest|to put (in|aside))\b/i,
    /\bwhat('s| is) your (budget|capital|starting (amount|capital|budget))\b/i,
    /\bset aside\b.*\b(for|toward|for (the |this )?markets?|for (your |the )?(education|trading))/i,
    /\bhow much (are you )?(working with|looking to (invest|start with|put (in|aside)))\b/i,
    /\bwhat are you working with\b/i,
    /\bon the (capital|money|budget) side\b/i
  ];
  if (customPrompt && customPrompt.trim().length >= 15) {
    const snippet = customPrompt.trim().slice(0, 30);
    const escaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push(new RegExp(escaped, 'i'));
  }

  let verificationAskedAt: { id: string; timestamp: Date } | null = null;
  for (const msg of aiMsgs) {
    if (patterns.some((p) => p.test(msg.content))) {
      verificationAskedAt = { id: msg.id, timestamp: msg.timestamp };
      break;
    }
  }

  if (!verificationAskedAt) {
    return {
      blocked: true,
      reason: 'never_asked',
      parsedAmount: null,
      verificationAskedAt: null,
      verificationConfirmedAt: null
    };
  }

  // Collect ALL LEAD messages after the verification Q, not just the
  // first. Two reasons:
  //   1. Tahir-class false-positive: lead sends "kinda" then
  //      immediately "actually I have 5k" — the earlier message
  //      classifies as hedging, but the later one is the real
  //      answer. Taking only `findFirst` misclassifies these as
  //      hedging when the actual answer is a number.
  //   2. Current-turn belt-and-suspenders: if the caller passed
  //      `currentTurnLeadMsg` explicitly (from conversationHistory),
  //      use it even if it's newer than the DB-queried set — rules
  //      out any webhook-timing race where the current turn's LEAD
  //      message was saved microseconds after checkR24Verification
  //      snapshot'd its Message query.
  const laterLeadMsgs = await prisma.message.findMany({
    where: {
      conversationId,
      sender: 'LEAD',
      timestamp: { gt: verificationAskedAt.timestamp }
    },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true, timestamp: true }
  });
  // Merge in the current-turn override if it sits after the Q AND is
  // not already in the DB result (dedupe by content + timestamp).
  const mergedAnswers: Array<{
    id: string | null;
    content: string;
    timestamp: Date;
  }> = laterLeadMsgs.map((m) => ({
    id: m.id,
    content: m.content,
    timestamp: m.timestamp
  }));
  if (currentTurnLeadMsg) {
    const overrideTs =
      currentTurnLeadMsg.timestamp instanceof Date
        ? currentTurnLeadMsg.timestamp
        : new Date(currentTurnLeadMsg.timestamp);
    const afterQ =
      overrideTs.getTime() > verificationAskedAt.timestamp.getTime();
    const alreadyInSet = mergedAnswers.some(
      (m) =>
        m.content === currentTurnLeadMsg.content &&
        Math.abs(m.timestamp.getTime() - overrideTs.getTime()) < 2000
    );
    if (afterQ && !alreadyInSet) {
      mergedAnswers.push({
        id: null,
        content: currentTurnLeadMsg.content,
        timestamp: overrideTs
      });
    }
  }
  mergedAnswers.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (mergedAnswers.length === 0) {
    return {
      blocked: true,
      reason: 'asked_but_no_answer',
      parsedAmount: null,
      verificationAskedAt: verificationAskedAt.id,
      verificationConfirmedAt: null
    };
  }
  // Classify each candidate answer; prefer the STRONGEST signal.
  // amount (concrete number) wins everything. When both an affirmative
  // AND a disqualifier appear in the same burst — classic "Yes /
  // actually No / I don't have it right now" pattern (Kelvin Kelvot
  // 2026-04-24 incident) — the DISQUALIFIER wins. Leads reflex-type
  // "yes" then correct themselves; the correction is the truth, and
  // routing a lead with no money to the booking handoff is far costlier
  // than asking a second clarifying question. If only one signal is
  // present, its own priority governs as usual.
  const classifications = mergedAnswers.map((m) => ({
    msg: m,
    cls: parseLeadCapitalAnswer(m.content)
  }));
  // amount > disqualifier > affirmative > hedging > ambiguous.
  const priority: Record<string, number> = {
    amount: 5,
    disqualifier: 4,
    affirmative: 3,
    hedging: 2,
    ambiguous: 1
  };
  let best = classifications[classifications.length - 1]; // default: latest
  for (const c of classifications) {
    if (priority[c.cls.kind] > priority[best.cls.kind]) {
      best = c;
    } else if (
      priority[c.cls.kind] === priority[best.cls.kind] &&
      c.msg.timestamp.getTime() > best.msg.timestamp.getTime()
    ) {
      // Tie → prefer the later message (most recent intent).
      best = c;
    }
  }
  const classification = best.cls;
  const nextLead = { id: best.msg.id, content: best.msg.content };
  const askedId = verificationAskedAt.id;

  // ── Currency detection (Souljah J 2026-04-25) ──────────────────
  // Threshold is stored in USD on the persona row. When the lead has
  // been speaking in GBP throughout the conversation, comparing a £
  // amount directly against the USD threshold mis-classifies real
  // qualifiers — "I have £1,000" is ~$1,250, which clears a $1,000
  // gate, but a literal `1000 >= 1000` USD compare without unit
  // awareness happens to also pass at the threshold-equal edge and
  // FAILS for amounts like "£800" (~$1,000) that should pass. Detect
  // £ in the lead's actual answer + any earlier LEAD message in this
  // convo. If GBP, compare `amt * 1.25 >= threshold` (1.25 USD per
  // GBP, conservative round number — the gate is meant to catch
  // clear under-funders, not split hairs at the boundary). USD or
  // unknown → unchanged behaviour.
  const conversationCurrency = await detectConversationCurrency(
    conversationId,
    mergedAnswers.map((m) => m.content)
  );
  const usdEquivalent = (gbp: number) => gbp * 1.25;
  switch (classification.kind) {
    case 'amount': {
      const amt = classification.amount!;
      const compareAmt =
        conversationCurrency === 'GBP' ? usdEquivalent(amt) : amt;
      if (compareAmt >= threshold) {
        return {
          blocked: false,
          reason: 'confirmed_amount',
          parsedAmount: amt,
          verificationAskedAt: askedId,
          verificationConfirmedAt: nextLead.id
        };
      }
      return {
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: amt,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      };
    }
    case 'affirmative':
      return {
        blocked: false,
        reason: 'confirmed_affirmative',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: nextLead.id
      };
    case 'disqualifier':
      return {
        blocked: true,
        reason: 'answer_below_threshold',
        parsedAmount: 0,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      };
    case 'hedging':
      return {
        blocked: true,
        reason: 'answer_hedging',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      };
    case 'ambiguous':
    default:
      return {
        blocked: true,
        reason:
          classification.reason ===
          'prop_firm_mentioned_no_personal_capital_stated'
            ? 'answer_prop_firm_only'
            : 'answer_ambiguous',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      };
  }
}
