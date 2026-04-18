import prisma from '@/lib/prisma';
import { buildDynamicSystemPrompt, getPromptVersion } from '@/lib/ai-prompts';
import type { LeadContext } from '@/lib/ai-prompts';
import { getCredentials } from '@/lib/credential-store';
import { retrieveFewShotExamples } from '@/lib/training-example-retriever';
import { scoreVoiceQuality, isUnkeptPromise } from '@/lib/voice-quality-gate';

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

export interface GenerateReplyResult {
  reply: string;
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
  let systemPrompt = await buildDynamicSystemPrompt(
    accountId,
    leadContext,
    fewShotBlock || undefined
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
      capitalVerificationPrompt: true
    }
  });
  const capitalThreshold = personaForGate?.minimumCapitalRequired ?? null;
  const capitalCustomPrompt = personaForGate?.capitalVerificationPrompt ?? null;

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

    // 5. Voice quality gate — relax length cap when this turn is
    // delivering a promise (it needs room to actually explain).
    const quality = scoreVoiceQuality(parsed.message, {
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
        capitalCustomPrompt
      );
      r24Blocked = r24LastResult.blocked;
    }

    if (quality.passed && !r24Blocked) {
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
      } else if (!quality.passed) {
        console.warn(
          `[ai-engine] Voice quality gate exhausted ${MAX_RETRIES + 1} attempts — sending best effort`
        );
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
      const suggestion = await prisma.aISuggestion.create({
        data: {
          conversationId: convoId,
          accountId,
          responseText: parsed.message,
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

  return {
    reply: parsed.message,
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
    suggestionId
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
  message: string;
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

function parseAIResponse(raw: string): ParsedAIResponse {
  const defaults: ParsedAIResponse = {
    format: 'text',
    message: raw,
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

    return {
      format: obj.format || 'text',
      message: obj.message || raw,
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
 * messaging? Detected via sub_stage + content patterns. Handoff phrases
 * are things like "team is gonna reach out", "let's gooo bro" wrap-ups,
 * "set up your call", "check your email for the confirmation" — the
 * kinds of lines that ONLY make sense once the lead is actually ready
 * to book. A verification question ("you got at least $X ready?") does
 * NOT match these patterns, so it correctly falls through the gate.
 */
function isRoutingToBookingHandoff(parsed: ParsedAIResponse): boolean {
  if (parsed.stage === 'BOOKING') {
    if (
      parsed.subStage === 'BOOKING_CONFIRM' ||
      parsed.subStage === 'BOOKING_LINK_DROP'
    ) {
      return true;
    }
  }
  const handoffPhrases =
    /\b(team\s+(is\s+)?(gonna|going\s+to|will)\s+(reach\s+out|get\s+in\s+touch|contact\s+you|set\s+(you\s+)?up|get\s+you\s+set|be\s+in\s+touch)|check\s+your\s+email\s+for\s+(the|your)\s+(call|confirmation|zoom|invite)|you'?re\s+all\s+set|locked\s+in\s+for|call\s+confirmation)\b/i;
  return handoffPhrases.test(parsed.message);
}

/**
 * Extract a dollar amount from a free-form lead reply. Handles
 * "$5k", "5,000", "$3,000.00", "around 500", "about $2000", "3500
 * give or take", bare-number strings, and the "5k"/"2.5k" shorthand.
 * Returns null when no number is present.
 */
function parseLeadAmountFromReply(text: string): number | null {
  // Match optional $, digits with thousands-commas OR plain digits,
  // optional decimal, optional k/K suffix. First hit wins.
  const m = text.match(/\$?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?([kK])?/);
  if (!m) return null;
  let amount = parseInt(m[1].replace(/,/g, ''), 10);
  if (!Number.isFinite(amount)) return null;
  if (m[2]) amount *= 1000; // "5k" → 5000, "2k" → 2000
  return amount;
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
function parseLeadCapitalAnswer(raw: string): ParsedLeadAnswer {
  const text = raw.trim();

  // 1. Non-numeric disqualifiers — handle first so "I got nothing" doesn't
  //    get amount-parsed into some weird accidental hit.
  if (
    /\b(not\s+much|not\s+a\s+lot|nothing\s+really|^nothing\b|\bbroke\b|don'?t\s+have\s+(any\s+)?(money|capital|anything|much)|can'?t\s+afford|no\s+money|i'?m\s+(a\s+|currently\s+a\s+)?student|still\s+in\s+school)\b/i.test(
      text
    )
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
  customPrompt: string | null
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

  const nextLead = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: 'LEAD',
      timestamp: { gt: verificationAskedAt.timestamp }
    },
    orderBy: { timestamp: 'asc' },
    select: { id: true, content: true }
  });
  if (!nextLead) {
    return {
      blocked: true,
      reason: 'asked_but_no_answer',
      parsedAmount: null,
      verificationAskedAt: verificationAskedAt.id,
      verificationConfirmedAt: null
    };
  }

  const classification = parseLeadCapitalAnswer(nextLead.content);
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
