import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { buildDynamicSystemPrompt, getPromptVersion } from '@/lib/ai-prompts';
import type { LeadContext } from '@/lib/ai-prompts';
import { getCredentials } from '@/lib/credential-store';
import { retrieveFewShotExamples } from '@/lib/training-example-retriever';
import {
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
}

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
  let systemPrompt = await buildDynamicSystemPrompt(
    accountId,
    leadContext,
    fewShotBlock || undefined,
    priorAIMessages
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
  const { provider, apiKey, model } = await resolveAIProvider(accountId);

  if (!apiKey) {
    throw new Error(
      'No AI provider configured. Please add your OpenAI or Anthropic API key in Settings → Integrations.'
    );
  }

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
  let systemPromptForLLM = systemPrompt;
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
    const rawResponse = await callLLM(
      provider,
      apiKey,
      model,
      systemPromptForLLM,
      messages
    );

    parsed = parseAIResponse(rawResponse);

    // 5. Voice quality gate — runs per-bubble via scoreVoiceQualityGroup.
    // For single-message responses (flag-off persona), parsed.messages is
    // [parsed.message] and the group wrapper degenerates to a single call
    // — byte-identical to the pre-multi-bubble behaviour. Multi-bubble
    // responses get per-bubble hardFails tagged [bubble=N] plus the
    // group-level cta_ack_only_truncation check on the joined string.
    const quality = scoreVoiceQualityGroup(parsed.messages, {
      relaxLengthLimit: !!unkeptPattern
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
    if (activeConversationId && !r24Blocked && !fixBBlocked) {
      fabricationResult = await shouldBlockForBookingFabrication({
        parsed,
        conversationId: activeConversationId,
        closerNames
      });
      fabricationBlocked = fabricationResult.blocked;
    }

    if (quality.passed && !r24Blocked && !fixBBlocked && !fabricationBlocked) {
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
          r24Directive = `The lead's stated capital (${stated}) is below the minimum threshold (${thresholdStr}). Do NOT route to booking. Your next reply MUST pivot to the script's downsell / funding-partner branch — acknowledge their capital situation empathetically (no judgment, no lecture), then present the alternative path their script provides (a lower-ticket course, a funding-partner option, or a free YouTube/resource redirect). Do NOT send booking-handoff messaging, do NOT suggest the Typeform / application form, do NOT say "the team will reach out". If your script doesn't have a downsell, send a soft-exit message that keeps the door open for when they're in a better financial position.`;
          break;
        }
        case 'answer_hedging':
          r24Directive = `The lead hedged on the capital question ("kinda", "working on it", "almost", etc.) without giving a concrete number. Do NOT route to booking. Ask a single follow-up that pins down a concrete dollar figure — for example "no stress, what's the number you're working with rn?". Do NOT send booking-handoff messaging until you have a concrete amount.`;
          break;
        case 'answer_ambiguous':
          r24Directive = `The lead's reply to the capital question didn't give a clear answer ("depends", "varies", "not sure", etc.). Do NOT route to booking. Ask a short clarifying question that gets a concrete dollar figure. Do NOT send booking-handoff messaging yet.`;
          break;
      }
      const r24Override = `\n\n===== CRITICAL R24 OVERRIDE =====\n${r24Directive}\n=====`;
      systemPromptForLLM = systemPrompt + r24Override;
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
      systemPromptForLLM = systemPrompt + fixBOverride;
      console.warn(
        `[ai-engine] Fix B gate BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fixBResult.reason} stage=${parsed.stage} sub=${parsed.subStage ?? 'null'}`
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
      systemPromptForLLM = systemPrompt + fabricationOverride;
      console.warn(
        `[ai-engine] Booking fabrication BLOCKED attempt ${attempt + 1}/${MAX_RETRIES + 1} for convo ${activeConversationId} — reason=${fabricationResult.reason} content="${parsed.message.slice(0, 120)}"`
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
        systemPromptForLLM = systemPrompt + ackOverride;
        console.warn(
          `[ai-engine] CTA acknowledgment-only truncation detected — forcing regen with override (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
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
      } else if (fixBBlocked) {
        // Fix B exhaustion — mirror the R24 escalation. The LLM has
        // repeatedly tried to advance despite the override directive,
        // so a human needs to pick up the conversation.
        console.error(
          `[ai-engine] Fix B gate EXHAUSTED ${MAX_RETRIES + 1} attempts — forcing escalate_to_human on convo ${activeConversationId}`
        );
        parsed.escalateToHuman = true;
      } else if (fabricationBlocked) {
        // Booking fabrication exhaustion — same escalation pattern.
        // If the LLM keeps claiming real-time booking state after
        // multiple override attempts, a human needs to handle it.
        console.error(
          `[ai-engine] Booking fabrication gate EXHAUSTED ${MAX_RETRIES + 1} attempts — forcing escalate_to_human on convo ${activeConversationId}`
        );
        parsed.escalateToHuman = true;
      } else if (!quality.passed) {
        // Voice quality gate exhausted. Normally we ship best-effort —
        // a low-scoring reply is still useful context for the operator
        // and the downstream dedup + empty guard catch the truly bad
        // cases. But if all retries returned empty / whitespace-only
        // content, best-effort means shipping nothing: escalate instead
        // so the empty-message guard in sendAIReply doesn't have to be
        // the ONLY defense (and so the operator sees the escalation
        // rather than a silent pause).
        const allBubblesEmpty =
          !Array.isArray(parsed.messages) ||
          parsed.messages.length === 0 ||
          parsed.messages.every(
            (b) => typeof b !== 'string' || b.trim().length === 0
          );
        if (allBubblesEmpty) {
          console.error(
            `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts AND final output is empty — forcing escalate_to_human on convo ${activeConversationId}`
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
          generatedDuringTrainingPhase: isOnboarding
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

async function resolveAIProvider(accountId: string): Promise<{
  provider: 'openai' | 'anthropic';
  apiKey: string | undefined;
  model: string;
}> {
  // Try per-account OpenAI
  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      // Default to gpt-4o-mini — ~16x cheaper than gpt-4o and the voice
      // quality gate + heavy prompt scaffolding absorb the capability
      // delta well enough. Accounts that want gpt-4o can set it explicitly
      // in their credential record.
      model: (openaiCreds.model as string) || 'gpt-4o-mini'
    };
  }

  // Try per-account Anthropic
  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
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
  const apiKey =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  const model =
    process.env.AI_MODEL ||
    (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini');

  return { provider: provider as 'openai' | 'anthropic', apiKey, model };
}

// ---------------------------------------------------------------------------
// Format Conversation History for LLM
// ---------------------------------------------------------------------------

function formatConversationForLLM(
  history: ConversationMessage[]
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return history.map((msg) => {
    // LEAD messages → user role, AI/HUMAN messages → assistant role
    if (msg.sender === 'LEAD') {
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

async function callLLM(
  provider: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  if (provider === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    const response = await client.chat.completions.create({
      model,
      temperature: 0.85,
      max_tokens: 1500,
      // Force OpenAI to emit a valid JSON object. The system prompt already
      // demands JSON, but stacked directive blocks sometimes steered the
      // model into plain text — this guarantees the response parses.
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: systemPrompt }, ...messages]
    });

    return response.choices[0]?.message?.content?.trim() || '';
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Anthropic requires messages to start with user role
    // If first message is assistant, prepend a system-generated user message
    let anthropicMessages = [...messages];
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

    const response = await client.messages.create({
      model,
      system: systemPrompt,
      temperature: 0.85,
      max_tokens: 1500,
      messages: anthropicMessages
    });

    const textBlock = response.content.find(
      (block: any) => block.type === 'text'
    );
    return (textBlock as any)?.text?.trim() || '';
  }
}

/**
 * Merge consecutive messages with the same role (required by Anthropic).
 */
function mergeConsecutiveRoles(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (messages.length === 0) return messages;

  const merged: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content += '\n' + msg.content;
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
    const messages: string[] = fromArray ?? [fromString];
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
  | 'answer_ambiguous'; // Lead's reply didn't parse ("depends", "varies")

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
  // Match optional $, integer portion (thousands-commas OR plain
  // digits), optional decimal portion, optional k/K suffix. Decimal
  // capture is necessary so "2.5k" → 2500 rather than 2000.
  const m = text.match(/\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?([kK])?/);
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
  const noCapital =
    /\b(not\s+much|not\s+a\s+lot|nothing\s+really|^nothing\b|\bbroke\b|don'?t\s+have\s+(any\s+)?(money|capital|anything|much)|can'?t\s+afford|no\s+money|i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school)\b/i;
  const jobless =
    /\b(jobless|job less|unemployed|no job|lost my job|between jobs|laid off|let go|no income|no work|out of work)\b/i;
  const desperation =
    /\b(only hope|last hope|last chance|desperate|nothing left)\b/i;
  const cantAffordBasics =
    /\b(can'?t eat|can'?t pay rent|can'?t pay bills|struggling to survive)\b/i;
  if (
    noCapital.test(text) ||
    jobless.test(text) ||
    desperation.test(text) ||
    cantAffordBasics.test(text)
  ) {
    return { kind: 'disqualifier', amount: 0 };
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
    return { kind: 'ambiguous', amount: null };
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

  return { kind: 'ambiguous', amount: null };
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
  // Strongest = amount (any number wins). Next = affirmative.
  // Next = disqualifier. Fallback = hedging / ambiguous from the
  // LATEST message (most recent intent).
  const classifications = mergedAnswers.map((m) => ({
    msg: m,
    cls: parseLeadCapitalAnswer(m.content)
  }));
  // Find the highest-priority classification across all messages.
  // amount → affirmative → disqualifier → hedging → ambiguous.
  const priority: Record<string, number> = {
    amount: 5,
    affirmative: 4,
    disqualifier: 3,
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

  switch (classification.kind) {
    case 'amount': {
      const amt = classification.amount!;
      if (amt >= threshold) {
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
        reason: 'answer_ambiguous',
        parsedAmount: null,
        verificationAskedAt: askedId,
        verificationConfirmedAt: null
      };
  }
}
