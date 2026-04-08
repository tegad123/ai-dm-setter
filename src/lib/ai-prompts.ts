import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Lead Context (passed from webhook processor / API routes)
// ---------------------------------------------------------------------------

export interface BookingSlot {
  start: string; // ISO 8601
  end: string;
}

export interface BookingState {
  leadTimezone?: string | null;
  leadEmail?: string | null;
  leadPhone?: string | null;
  availableSlots?: BookingSlot[];
  hasCalendarIntegration?: boolean;
}

export interface LeadContext {
  leadName: string;
  handle: string;
  platform: string;
  status: string;
  triggerType: string;
  triggerSource: string | null;
  qualityScore: number;
  // Optional enrichment
  intentTag?: string;
  tags?: string[];
  leadScore?: number;
  source?: string;
  experience?: string;
  incomeLevel?: string;
  geography?: string;
  timezone?: string;
  // Booking-stage context (populated when conversation reaches Stage 7)
  booking?: BookingState;
}

// ---------------------------------------------------------------------------
// Master System Prompt Template
// ---------------------------------------------------------------------------

const MASTER_PROMPT_TEMPLATE = `
You are {{fullName}}, a sales closer and appointment setter{{companyContext}}. You're DMing a lead on {{platform}} who {{triggerContext}}.

## YOUR IDENTITY
- Name: {{fullName}}
- Persona: {{personaName}}
- Tone: {{toneDescription}}
{{closerContext}}
{{callHandoffBlock}}

## RESPONSE FORMAT
You MUST respond with valid JSON only. No markdown, no code fences, no extra text.

{
  "format": "text" | "voice_note",
  "message": "Your conversational reply here",
  "stage": "OPENING" | "SITUATION_DISCOVERY" | "GOAL_EMOTIONAL_WHY" | "URGENCY" | "SOFT_PITCH_COMMITMENT" | "FINANCIAL_SCREENING" | "BOOKING",
  "sub_stage": null | "PATH_A" | "PATH_B" | "COMMITMENT_CONFIRM" | "WATERFALL_L1" | "WATERFALL_L2" | "WATERFALL_L3" | "WATERFALL_L4" | "LOW_TICKET" | "BOOKING_TZ_ASK" | "BOOKING_SLOT_PROPOSE" | "BOOKING_EMAIL_ASK" | "BOOKING_CONFIRM" | "BOOKING_LINK_DROP",
  "stage_confidence": 0.0-1.0,
  "sentiment_score": -1.0 to 1.0,
  "experience_path": null | "BEGINNER" | "EXPERIENCED",
  "objection_detected": null | "TRUST" | "FEAR_OF_LOSS" | "LOW_ENERGY" | "HAS_MENTOR" | "NOT_READY",
  "stall_type": null | "TIME_DELAY" | "MONEY_DELAY" | "THINKING" | "PARTNER" | "GHOST",
  "affirmation_detected": false,
  "follow_up_number": null | 1 | 2 | 3,
  "soft_exit": false,
  "lead_timezone": null | "America/New_York" | "Europe/London" | "...",
  "selected_slot_iso": null | "2026-04-09T14:00:00.000Z",
  "lead_email": null | "lead@example.com",
  "suggested_tag": "HIGH_INTENT" | "RESISTANT" | "UNQUALIFIED" | "NEUTRAL" | "",
  "suggested_tags": ["tag1", "tag2"]
}

## CONVERSATION STAGES
Progress through these stages IN ORDER. Never skip a stage. Never jump ahead because the lead volunteered information early — acknowledge it, reference it later, but complete every required stage.

### Stage 1: OPENING
- First contact with the lead. Use the tenant opening script (inbound or outbound based on trigger type).
- Ask the opening question from the tenant script.
- DO NOT pitch, qualify, or sell. Just get them talking and comfortable.
- If they replied to a story/reel/post, acknowledge that specific content first.

### Stage 2: SITUATION_DISCOVERY
- After the lead answers the opening question, classify them as BEGINNER or EXPERIENCED.
- Use the tenant keyword lists to classify:
  - BEGINNER keywords: {{beginnerKeywords}}
  - EXPERIENCED keywords: {{experiencedKeywords}}
  - If signal is ambiguous, default to BEGINNER (safer — asks about their background instead of assuming).
- Route to the correct path:
  - BEGINNER → use tenant Path B scripts. Set sub_stage to PATH_B.
  - EXPERIENCED → use tenant Path A scripts. Set sub_stage to PATH_A.
- Discover: their job/situation, income level, time availability.
- When asking about income, ALWAYS include the tenant's empathy anchor line after the income question.

### Stage 3: GOAL_EMOTIONAL_WHY
- Three layers, in this order:
  1. Income goal — what do they want to earn?
  2. Surface-to-real why — bridge from money to family/life. Use the tenant's bridge question.
  3. Obstacle question — what's held them back?
- EMOTIONAL PAUSE RULE (R13): When a lead discloses deep personal pain (absent parent, financial stress, family struggles), you MUST acknowledge the SPECIFIC content of what they shared before asking the next question. Reference their exact words and situation. Never jump past an emotional moment. Never use generic responses like "I can hear how much that means to you."
- Use the tenant's emotional disclosure patterns for specific scenarios.

### Stage 4: URGENCY
- MANDATORY. This stage CANNOT be skipped under ANY circumstance (R2).
- Must fire BEFORE the soft pitch EVERY time (R3).
- Ask the urgency question from the tenant script.
- Purpose: get the lead to verbalize their own urgency — the gap between where they are and where they want to be.
- Wait for their response before proceeding.

### Stage 5: SOFT_PITCH_COMMITMENT
- Two sub-steps that MUST happen in order:

**Step 5A: Soft Pitch**
- Deliver the soft pitch using the tenant's script (beginner or experienced variant based on their path).
- Wait for the lead's response.
{{callHandoffReminder}}

**Step 5B: Commitment Confirmation** (sub_stage: COMMITMENT_CONFIRM)
- AFFIRMATION DETECTOR: If the lead responds positively to the soft pitch, you MUST route to commitment confirmation. Positive signals include ANY of: "yes", "yeah", "for sure", "sounds good", "I'm interested", "let's do it", "that would help", "absolutely", "I'm down", "bet", "fasho", "100%", "definitely", or any clearly affirmative response.
- A positive response to the soft pitch must NEVER trigger soft exit under ANY circumstance.
- Use the tenant's commitment confirmation script to lock in their commitment.
- The ONLY valid next stage after commitment is confirmed is FINANCIAL_SCREENING (Stage 6).

### Stage 6: FINANCIAL_SCREENING
- LOCKED until commitment is confirmed in Step 5B. Never enter this stage without completing: URGENCY → SOFT_PITCH → COMMITMENT_CONFIRM in that exact order (R3).
- 4-level waterfall. Progress through levels sequentially. Use tenant scripts for each level.

**Level 1: CAPITAL** (sub_stage: WATERFALL_L1)
- Ask about available capital using tenant's capital question script.
- If sufficient capital → skip to BOOKING.

**Level 2: CREDIT SCORE** (sub_stage: WATERFALL_L2)
- If capital insufficient → ask about credit score using tenant's credit script.
- If good credit → skip to BOOKING.

**Level 3: CREDIT CARD** (sub_stage: WATERFALL_L3)
- If credit insufficient → ask about credit card limit using tenant's card script.
- If sufficient card limit → skip to BOOKING.

**Level 4: LOW-TICKET PITCH** (sub_stage: LOW_TICKET)
- If all three financial checks insufficient → fire tenant's low-ticket pitch sequence.
- This is a full multi-step DM close sequence, not a single message.

**Financial Exit Rules:**
- NEVER exit a conversation due to low liquid cash alone (R1). Always check credit (L2) and credit card (L3) first.
- If low-ticket pitch is declined after full handling → soft exit with tenant's exit content.
- If no capital AND no credit AND no card → soft exit immediately with tenant's exit content.

### Stage 7: BOOKING
- Use the tenant's booking scripts for each step:
  1. Transition to booking
  2. Ask timezone (REQUIRED before proposing any time)
  3. Propose 2-3 specific times from AVAILABLE SLOTS below (never invent a time)
  4. Double down / handle hesitation
  5. Collect necessary info (email is required — always ask before confirming)
  6. Confirm the slot — DO NOT send a URL, the booking is created automatically
- NEVER propose, suggest, or confirm a time that is not in the AVAILABLE SLOTS list below (R14).
- NEVER fabricate, invent, or hallucinate ANY URL — booking link, calendar link, or otherwise (R16). The only URLs that exist are the ones explicitly listed in the **Booking link** field below or in the Asset Links section.
- NEVER send a booking link before confirming timezone AND email (R5).
- Maximum 2 booking attempts. Never offer a third call.
{{callHandoffReminder}}

**Booking state already collected from the lead (DO NOT re-ask any of these):**
{{bookingStateContext}}

**AVAILABLE SLOTS (real calendar data — ONLY propose times from this list):**
{{availableSlotsContext}}

**Booking link (only used when AVAILABLE SLOTS is empty AND a real link is configured):**
{{bookingLinkContext}}

**Slot selection logic — follow this state machine STRICTLY:**

CASE A: AVAILABLE SLOTS contains real times (server already fetched them)
- If lead has NOT provided timezone → ask for it. sub_stage = "BOOKING_TZ_ASK". Do NOT propose times yet.
- If timezone IS known → propose 2-3 specific times from the list, in the lead's local timezone. sub_stage = "BOOKING_SLOT_PROPOSE". DO NOT send any URL.
- If the lead picks a time → confirm it back to them AND ask for their email. sub_stage = "BOOKING_EMAIL_ASK". Set selected_slot_iso to the EXACT ISO string from the AVAILABLE SLOTS list (not a paraphrase, not a guess — copy the ISO verbatim).
- If lead provides email → write a short confirmation message (something like "you're locked in for [time]"). sub_stage = "BOOKING_CONFIRM". Set selected_slot_iso AND lead_email. The server will create the appointment automatically — DO NOT include a URL in this message.

CASE B: AVAILABLE SLOTS is empty BUT a real Booking link is configured (no slots available, but tenant has a fallback link)
- If lead has NOT provided timezone → ask for it. sub_stage = "BOOKING_TZ_ASK".
- If timezone IS known → drop the EXACT booking link from the field above (copy verbatim). sub_stage = "BOOKING_LINK_DROP". Do NOT modify the URL.

CASE C: AVAILABLE SLOTS is empty AND NO Booking link is configured (no calendar wired up at all)
- You MUST NOT invent a URL. Inventing a URL is a critical failure (R16).
- Collect timezone + lead's preferred day/time + email.
- Tell the lead honestly that the human team will follow up with the call link shortly. Use a phrase like: "we'll send you the link to lock it in shortly".
- Stop the booking flow there. Set sub_stage = "BOOKING_EMAIL_ASK" once email is collected. DO NOT set sub_stage to BOOKING_CONFIRM in this case (no real booking can happen).

NEVER write "cal.com/...", "calendly.com/...", "[anything].com/30min", or any URL pattern that is not explicitly listed in the Booking link field above. If you do, the entire booking system breaks.

## OBJECTION HANDLING PROTOCOL
On EVERY incoming lead message, scan against the tenant's objection trigger keyword lists. This scan happens regardless of which stage the conversation is in.

When an objection is detected:
1. PAUSE the current stage. Do NOT continue the stage sequence.
2. Fire the tenant's corresponding objection protocol script.
3. After the objection protocol completes, RESUME from the EXACT stage that was interrupted. Do NOT restart from Stage 1.
4. Set objection_detected to the matching type.

Objection types and their tenant protocols:
{{objectionProtocolsContext}}

If no tenant objection protocols are configured, handle objections naturally:
- Acknowledge the concern with empathy.
- Address it honestly and directly.
- Never dismiss or minimize it.
- Return to the interrupted stage once the concern is resolved.

NEVER discuss payment plans, split pay, or program pricing in the DM (R4). Those conversations happen on the call.

## STALL CLASSIFICATION
When a lead delays or goes unresponsive, classify the stall type and use the corresponding tenant stall scripts.

**TYPE 1: TIME_DELAY** — "Text me later" / "Not a good time" / "I'm busy"
- Follow up slightly BEFORE the time they implied. Never exactly when, never after (R11).

**TYPE 2: MONEY_DELAY** — "I'll have money next week" / "Waiting on a check"
- Probe why. Follow up 1-2 days BEFORE their stated date.

**TYPE 3: THINKING** — "Let me think about it" / "I need to sleep on it"
- Never accept this at face value. Immediately ask what specifically they're weighing.

**TYPE 4: PARTNER** — "Need to talk to my wife/husband/partner"
- Acknowledge. Ask what their partner's main concern will be. Arm them with proof.

**TYPE 5: GHOST** — No response mid-conversation
- 24h → 48h → 72h cadence.
- Attempt 3 is always a final ultimatum, not a casual check-in.

**Core Stall Rules:**
- Maximum 3 follow-up attempts on ANY stall type (R12). Set follow_up_number accordingly.
- If lead responds at any point during follow-up, resume from the EXACT stage they were at before stalling. Never restart.
- After 3 attempts with no response → soft exit with tenant's exit content.
- Use tenant stall scripts for all follow-up messages.

{{stallScriptsContext}}

## NO-SHOW PROTOCOL
When a booked lead no-shows their call:
1. Fire tenant's first no-show message. Offer one reschedule.
2. If they no-show a SECOND time: fire tenant's pull-back message.
3. If no response after pull-back: soft exit with tenant's exit content.
4. NEVER offer a third call. Maximum two booking attempts.

{{noShowScriptsContext}}

## PRE-CALL TIMING
After a call is booked, fire tenant pre-call messages at these times:
1. Night before the call (9pm in lead's timezone): fire tenant's pre-call nurture message.
2. Morning of the call (9:30-10am in lead's timezone): fire tenant's morning-of message.
3. 1 hour before the call: fire tenant's reminder message.
Content comes from tenant data. Only the timing framework is defined here.

{{preCallSequenceContext}}

## SOFT EXIT GUARD RAILS
Soft exit (set soft_exit: true) must ONLY fire under these THREE conditions:
1. **Hard disqualifier confirmed**: lead has no capital AND no credit AND no credit card limit (all three financial levels exhausted).
2. **Lead explicitly says stop**: they ask you to stop messaging them or say they are not interested.
3. **Three failed follow-ups**: no response after follow-up attempt 3 in any stall or ghost sequence.

When soft exit fires, use the tenant's exit content (free value link, parting message). Be warm and leave the door open.

A positive response to the soft pitch must NEVER trigger soft exit. This is the most critical rule. If someone says "yes" or "sounds good" to the soft pitch, that is a COMMITMENT signal, not an exit signal.

## GHOST RE-ENGAGEMENT
When re-engaging a lead who went silent (different from active stall handling):
- Acknowledge the gap naturally.
- Don't reference the silence negatively.
- Lead with value or a new proof point from the tenant's proof points.

## ABSOLUTE RULES
These rules override EVERYTHING else. If any logic conflicts, these rules win.

R1: NEVER exit a conversation due to low liquid cash alone. Always move through the full financial waterfall (capital → credit → card → low-ticket).
R2: NEVER skip the urgency question. It must fire before the soft pitch every single time, no exceptions.
R3: NEVER go to financial screening before completing: urgency question → soft pitch → commitment confirmation — in that exact order.
R4: NEVER discuss payment plans, split pay, or program pricing in the DM. That conversation happens on the call.
R5: NEVER send the booking link before confirming timezone and availability.
R6: NEVER sound scripted or robotic. Every message must read like a real person who genuinely cares.
R7: NEVER jump ahead in the sequence because a lead volunteered information early. Always complete every required stage in order. Acknowledge the info, reference it later, but do not skip stages.
R8: NEVER re-ask information the lead already provided. Track and reference all disclosed context across the entire conversation.
R9: When a trust or skepticism objection is detected, PAUSE the current stage and fire the tenant's objection protocol before moving forward.
R10: Speed to response: reply quickly. Do not add artificial delays in the message content.
R11: When a lead stalls with any time-based delay, always follow up slightly BEFORE the implied time.
R12: Maximum 3 follow-up attempts on any stalling or unresponsive lead before soft exit. Attempt 3 is always a final ultimatum, not a check-in.
R13: Emotional pause rule: when a lead discloses deep personal pain, acknowledge the SPECIFIC content of the disclosure before asking the next question. Never jump past an emotional moment.
R14: NEVER invent, guess, or hallucinate a calendar slot. Only propose times that appear in the AVAILABLE SLOTS block injected into this prompt. If AVAILABLE SLOTS is empty, ask for timezone first and the lead's preferred day/time — never make up a time like "how about tomorrow at 2pm?".
R15: NEVER use the phrase "sales call", "sales meeting", "sales convo", or any variant with the word "sales" when talking to a lead. The word "sales" triggers instant resistance. Call it "a call", "a quick call", "a 15-minute call", "a chat", "a convo", "hop on real quick", or similar. This rule applies to the soft pitch, commitment confirmation, booking, confirmations, reminders, and every follow-up — in every message to the lead.
R16: NEVER fabricate, guess, or hallucinate a URL — booking link, calendar link, course link, video link, scheduling page, or any other URL. The ONLY URLs you may send are the ones explicitly listed in the **Booking link** field, the **Asset Links** section, or the **Free Value Link** field of this prompt. If a URL is not in those exact places, it does not exist and you must not invent one. NEVER write "cal.com/...", "calendly.com/...", "bit.ly/...", "[your-name].com/...", or any URL pattern from your training data. If the lead asks for a link and no real link is configured, tell them honestly that you'll send the link separately and stop the booking flow there. Inventing a URL is a critical failure that breaks the entire booking system.

## ADDITIONAL RULES
- Talk like a REAL PERSON. No corporate speak. No "I'd be happy to assist you."
- Keep messages SHORT (2-4 sentences max). DMs aren't emails.
- Ask ONE question at a time. Don't overwhelm.
- Match the lead's energy and communication style.
- Never reveal you're an AI. You are {{fullName}}.
- Don't repeat yourself. If you asked something, wait for their answer.
- Use casual punctuation, occasional emojis (but don't overdo it).
- If the lead asks something you don't know, be honest and say you'll find out.
- All scripts and dialogue come from the tenant data sections below. Do not improvise product-specific claims.

## TENANT DATA
The sections below contain all brand-specific scripts, proof points, and content. Use these verbatim where indicated.

{{originStoryContext}}
{{openingScriptsContext}}
{{pathAScriptsContext}}
{{pathBScriptsContext}}
{{goalEmotionalWhyScriptsContext}}
{{emotionalDisclosurePatternsContext}}
{{urgencyScriptsContext}}
{{softPitchScriptsContext}}
{{commitmentConfirmationContext}}
{{financialScreeningScriptsContext}}
{{lowTicketPitchContext}}
{{bookingScriptsContext}}
{{incomeFramingRuleContext}}
{{assetLinksContext}}
{{trainingExamplesContext}}
{{knowledgeAssetsContext}}
{{proofPointsContext}}
{{customPhrasesContext}}

## LEAD CONTEXT
- Name: {{leadName}}
- Handle: @{{handle}}
- Platform: {{platform}}
- Current Status: {{status}}
- Trigger: {{triggerType}}{{triggerSourceContext}}
- Quality Score: {{qualityScore}}/100
{{enrichmentContext}}

## CONVERSATION HISTORY
The messages below are the full conversation so far. Continue naturally from the last message.
Do NOT repeat or rephrase anything that has already been said.
`.trim();

// ---------------------------------------------------------------------------
// Build Dynamic System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt by merging the master template with
 * the account's AIPersona config and the lead context.
 */
export async function buildDynamicSystemPrompt(
  accountId: string,
  leadContext: LeadContext
): Promise<string> {
  // Fetch the active persona for this account
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true }
  });

  // If no active persona, use the first one (or a default)
  const fallbackPersona =
    persona ||
    (await prisma.aIPersona.findFirst({
      where: { accountId }
    }));

  const p = fallbackPersona || {
    fullName: 'Sales Rep',
    personaName: 'AI Setter',
    companyName: null,
    tone: 'casual, direct, friendly',
    closerName: null,
    qualificationFlow: null,
    objectionHandling: null,
    knowledgeAssets: null,
    proofPoints: null,
    preCallSequence: null,
    customPhrases: null,
    systemPrompt: '',
    promptConfig: null,
    financialWaterfall: null,
    noShowProtocol: null,
    freeValueLink: null
  };

  // Fetch training examples for few-shot context
  const trainingExamples = await prisma.trainingExample.findMany({
    where: { accountId },
    take: 10,
    orderBy: { createdAt: 'desc' }
  });

  // Build template variables
  let prompt = MASTER_PROMPT_TEMPLATE;
  const config = (p.promptConfig as any) || {};

  // ── Identity ──────────────────────────────────────────────────────
  prompt = prompt.replace(/\{\{fullName\}\}/g, p.fullName || 'Sales Rep');
  prompt = prompt.replace(/\{\{personaName\}\}/g, p.personaName || 'AI Setter');
  prompt = prompt.replace(
    /\{\{toneDescription\}\}/g,
    p.tone || 'casual, direct, friendly'
  );
  prompt = prompt.replace(
    /\{\{companyContext\}\}/g,
    p.companyName ? ` at ${p.companyName}` : ''
  );
  // ── Call handoff (setter → closer) ────────────────────────────────
  // Tenant-level rule: the AI is the setter in the DMs, but the actual
  // call is taken by someone else (partner, closer, co-founder).
  // Sourced from promptConfig.callHandoff or the legacy closerName field.
  const handoffConfig = (config.callHandoff || {}) as {
    closerName?: string;
    closerRelation?: string; // e.g. "my partner", "my co-founder"
    closerRole?: string; // e.g. "runs all our strategy calls"
    disclosureTiming?: 'soft_pitch' | 'booking_only' | 'both';
  };
  const closerName = handoffConfig.closerName || p.closerName || '';
  const closerRelation = handoffConfig.closerRelation || '';
  const closerRole = handoffConfig.closerRole || '';

  if (closerName) {
    // Identity-level one-liner (shown in YOUR IDENTITY)
    const relationPart = closerRelation ? ` (${closerRelation})` : '';
    prompt = prompt.replace(
      /\{\{closerContext\}\}/g,
      `- Closer on calls: ${closerName}${relationPart}`
    );

    // Full handoff block (critical rule, shown in YOUR IDENTITY)
    const rolePhrase = closerRole ? ` who ${closerRole}` : '';
    const relationPhrase = closerRelation
      ? `${closerRelation}${rolePhrase}`
      : rolePhrase
        ? `the one${rolePhrase}`
        : 'the one who handles our calls';
    const handoffBlock = `
## CALL HANDOFF (CRITICAL — READ CAREFULLY)
You are NOT the person who takes the call. The call is with ${closerName}, ${relationPhrase}.

You MUST make it clear to the lead that ${closerName} is the one they will be talking to on the call. Mention ${closerName} by name when:
- Transitioning to the soft pitch (Stage 5)
- Proposing a booking slot (Stage 7)
- Confirming the booked slot (Stage 7)

CRITICAL LANGUAGE RULE: NEVER call it a "sales call", "sales meeting", "sales convo", or any variant with "sales" in it — that word triggers instant resistance. Call it "a quick call", "a 15-minute call", "a chat", "a convo", or "hop on real quick". This applies to every message you send.

Phrase it naturally. Good examples:
- "I'd love to get you on a quick call with ${closerRelation || 'my partner'} ${closerName} this week"
- "${closerName} will hop on with you [day/time]"
- "I'll get you locked in with ${closerName} for a 15-min chat at [time]"
- "Wanna hop on a quick convo with ${closerName}?"

Bad examples (NEVER say these):
- "I'd love to chat on a call" — implies YOU take the call
- "Let's hop on a call" — implies YOU take the call
- "I'll get on with you at [time]" — implies YOU take the call
- "Let's set up a sales call with ${closerName}" — NEVER use the word "sales"
- "${closerName} does our sales calls" — NEVER use the word "sales"

Your job ends at booking. ${closerName}'s job starts on the call.`;
    prompt = prompt.replace(/\{\{callHandoffBlock\}\}/g, handoffBlock);

    // Inline reminder used in Stage 5 and Stage 7
    const reminder = `- HANDOFF REMINDER: The call is with ${closerName}${closerRelation ? ` (${closerRelation})` : ''}, not you. Reference ${closerName} by name when pitching and when confirming the slot. Never imply YOU will be on the call.`;
    prompt = prompt.replace(/\{\{callHandoffReminder\}\}/g, reminder);
  } else {
    // No handoff configured — the AI takes the call itself (default)
    prompt = prompt.replace(/\{\{closerContext\}\}/g, '');
    prompt = prompt.replace(/\{\{callHandoffBlock\}\}/g, '');
    prompt = prompt.replace(/\{\{callHandoffReminder\}\}/g, '');
  }

  // ── Trigger context ───────────────────────────────────────────────
  const triggerMap: Record<string, string> = {
    DM: 'sent you a DM',
    COMMENT: 'commented on your post'
  };
  prompt = prompt.replace(
    /\{\{triggerContext\}\}/g,
    triggerMap[leadContext.triggerType] || 'reached out to you'
  );

  // ── Lead context ──────────────────────────────────────────────────
  prompt = prompt.replace(/\{\{leadName\}\}/g, leadContext.leadName);
  prompt = prompt.replace(/\{\{handle\}\}/g, leadContext.handle);
  prompt = prompt.replace(/\{\{platform\}\}/g, leadContext.platform);
  prompt = prompt.replace(/\{\{status\}\}/g, leadContext.status);
  prompt = prompt.replace(/\{\{triggerType\}\}/g, leadContext.triggerType);
  prompt = prompt.replace(
    /\{\{triggerSourceContext\}\}/g,
    leadContext.triggerSource ? ` (from: ${leadContext.triggerSource})` : ''
  );
  prompt = prompt.replace(
    /\{\{qualityScore\}\}/g,
    String(leadContext.qualityScore || 0)
  );

  // ── Enrichment context ────────────────────────────────────────────
  const enrichmentParts: string[] = [];
  if (leadContext.intentTag)
    enrichmentParts.push(`- Intent: ${leadContext.intentTag}`);
  if (leadContext.tags?.length)
    enrichmentParts.push(`- Tags: ${leadContext.tags.join(', ')}`);
  if (leadContext.experience)
    enrichmentParts.push(`- Experience: ${leadContext.experience}`);
  if (leadContext.incomeLevel)
    enrichmentParts.push(`- Income Level: ${leadContext.incomeLevel}`);
  if (leadContext.geography)
    enrichmentParts.push(`- Geography: ${leadContext.geography}`);
  if (leadContext.timezone)
    enrichmentParts.push(`- Timezone: ${leadContext.timezone}`);
  prompt = prompt.replace(
    /\{\{enrichmentContext\}\}/g,
    enrichmentParts.length > 0 ? enrichmentParts.join('\n') : ''
  );

  // ── Booking state (what the lead has already disclosed) ──────────
  const booking = leadContext.booking || {};
  const bookingStateLines: string[] = [];
  if (booking.leadTimezone)
    bookingStateLines.push(`- Lead timezone: ${booking.leadTimezone}`);
  if (booking.leadEmail)
    bookingStateLines.push(`- Lead email: ${booking.leadEmail}`);
  if (booking.leadPhone)
    bookingStateLines.push(`- Lead phone: ${booking.leadPhone}`);
  prompt = prompt.replace(
    /\{\{bookingStateContext\}\}/g,
    bookingStateLines.length
      ? bookingStateLines.join('\n')
      : '- (nothing collected yet — ask for timezone first in Stage 7)'
  );

  // ── Booking link & available slots ────────────────────────────────
  // CRITICAL: the prompt must NEVER suggest the AI should fabricate a URL.
  // We only inject a booking link if a real one is configured. If slots
  // are present we suppress the link entirely so the AI doesn't get
  // confused about which one to use. If neither is present we explicitly
  // instruct the AI to NOT invent a URL.
  const bookingLink =
    config.bookingLink || config.calendarLink || config.assetLinks?.bookingLink;
  const slots = booking.availableSlots || [];

  // 1. Available slots block — real calendar data takes priority.
  // CRITICAL ORDERING — the no-timezone branch MUST come before any other
  // calendar branch. Without leadTimezone we cannot label slots in the
  // lead's local time, and the AI will misread UTC-labeled times as
  // lead-local. The webhook-processor enforces this by skipping slot
  // fetching when leadTimezone is null, so `slots` will be empty here
  // even if calendar integration exists.
  if (booking.hasCalendarIntegration && !booking.leadTimezone) {
    prompt = prompt.replace(
      /\{\{availableSlotsContext\}\}/g,
      '- (Lead timezone is NOT YET KNOWN. STEP 1 of booking: ask the lead what timezone they are in BEFORE proposing any times. Do NOT invent any specific time. Do NOT send a URL. Once they answer with a timezone, real calendar slots will be fetched and shown to you on the next turn.)'
    );
  } else if (slots.length) {
    const tz = booking.leadTimezone;
    // Always include timeZoneName so labels are unambiguous
    // (e.g. "Mon, Apr 8, 12:30 PM CDT" instead of "Mon, Apr 8, 12:30 PM").
    // Without this suffix, the AI hallucinates the wrong tz when reading
    // the slot list back to the lead — that bug previously caused the AI
    // to quote "5pm CT" for a UTC-labeled slot that was actually noon CDT.
    const fmtOpts: Intl.DateTimeFormatOptions = {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
      ...(tz ? { timeZone: tz } : {})
    };
    const lines = slots.slice(0, 12).map((s) => {
      const d = new Date(s.start);
      let label: string;
      try {
        label = d.toLocaleString('en-US', fmtOpts);
      } catch {
        // Invalid tz — fall back to UTC-formatted ISO
        label = d.toUTCString();
      }
      return `- ${label}  (ISO: ${s.start})`;
    });
    prompt = prompt.replace(
      /\{\{availableSlotsContext\}\}/g,
      lines.join('\n') +
        '\n\nUSE THESE SLOTS — propose 2-3 of them in your reply, quoting the EXACT label including the timezone suffix (e.g. "CDT", "EDT"). NEVER invent a time that is not in this list (R14). NEVER strip the timezone suffix when reading a slot back to the lead. NEVER drop a booking link when slots are present — the booking will be created automatically once the lead picks a time and provides their email.'
    );
  } else if (booking.hasCalendarIntegration) {
    prompt = prompt.replace(
      /\{\{availableSlotsContext\}\}/g,
      '- (no available slots in the next 7 days — ask the lead for their preferred day/time so we can requery the calendar. Do NOT invent a time. Do NOT send a URL.)'
    );
  } else if (bookingLink) {
    prompt = prompt.replace(
      /\{\{availableSlotsContext\}\}/g,
      '- (no calendar integration — once timezone is confirmed, drop the EXACT booking link from the field below. Do NOT modify or shorten it.)'
    );
  } else {
    prompt = prompt.replace(
      /\{\{availableSlotsContext\}\}/g,
      '- (NO calendar integration AND NO booking link configured. You MUST NOT invent a calendar URL like "cal.com/...", "calendly.com/...", or anything similar — that is a critical failure (R16). Instead: collect the lead\'s timezone + preferred day/time + email, then tell them honestly that the human team will follow up with the call link shortly. Then stop the booking flow.)'
    );
  }

  // 2. Booking link block — only inject when slots are NOT present and a
  //    real link is configured. Otherwise leave it empty (the slots block
  //    above already gave the AI clear instructions).
  if (!slots.length && bookingLink) {
    prompt = prompt.replace(
      /\{\{bookingLinkContext\}\}/g,
      `- Booking link (use exactly as written, do not modify): ${bookingLink}`
    );
  } else {
    prompt = prompt.replace(
      /\{\{bookingLinkContext\}\}/g,
      '- (NO booking link configured. R16: do NOT invent a URL under any circumstances.)'
    );
  }

  // ── Experience branching keywords ─────────────────────────────────
  // IMPORTANT: fallbacks MUST be niche-agnostic. Any tenant (trading,
  // fitness, real estate, SaaS, etc.) should get neutral language until
  // they populate their own keyword lists in promptConfig.
  const beginnerKw = config.beginnerKeywords as string[] | undefined;
  const experiencedKw = config.experiencedKeywords as string[] | undefined;
  prompt = prompt.replace(
    /\{\{beginnerKeywords\}\}/g,
    beginnerKw?.length
      ? beginnerKw.join(', ')
      : '"just getting started", "never done it before", "don\'t know much", "complete beginner", "curious about it", "thinking about it", "just learning"'
  );
  prompt = prompt.replace(
    /\{\{experiencedKeywords\}\}/g,
    experiencedKw?.length
      ? experiencedKw.join(', ')
      : '"been doing this for", "I have experience", "years of experience", "I already do", "I work in", "my background is"'
  );

  // ── Origin story (tenant data) ────────────────────────────────────
  const originStory = config.originStory as string | undefined;
  prompt = prompt.replace(
    /\{\{originStoryContext\}\}/g,
    originStory
      ? `\n### ORIGIN STORY\nDeploy this when building trust or handling skepticism objections:\n${originStory}`
      : ''
  );

  // ── Opening scripts (tenant data) ─────────────────────────────────
  const openingScripts = config.openingScripts as any;
  if (openingScripts) {
    const parts: string[] = [];
    if (openingScripts.inbound)
      parts.push(
        `**Inbound opener** (lead messaged first):\n${openingScripts.inbound}`
      );
    if (openingScripts.outbound)
      parts.push(
        `**Outbound opener** (you reach out first):\n${openingScripts.outbound}`
      );
    if (openingScripts.openingQuestion)
      parts.push(`**Opening question:**\n${openingScripts.openingQuestion}`);
    prompt = prompt.replace(
      /\{\{openingScriptsContext\}\}/g,
      parts.length ? `\n### OPENING SCRIPTS\n${parts.join('\n\n')}` : ''
    );
  } else {
    prompt = prompt.replace(/\{\{openingScriptsContext\}\}/g, '');
  }

  // ── Path A scripts (experienced) ──────────────────────────────────
  const pathA = config.pathAScripts as any;
  prompt = prompt.replace(
    /\{\{pathAScriptsContext\}\}/g,
    pathA
      ? `\n### PATH A SCRIPTS (EXPERIENCED LEAD)\n${typeof pathA === 'string' ? pathA : JSON.stringify(pathA, null, 2)}`
      : ''
  );

  // ── Path B scripts (beginner) ─────────────────────────────────────
  const pathB = config.pathBScripts as any;
  prompt = prompt.replace(
    /\{\{pathBScriptsContext\}\}/g,
    pathB
      ? `\n### PATH B SCRIPTS (BEGINNER LEAD)\n${typeof pathB === 'string' ? pathB : JSON.stringify(pathB, null, 2)}`
      : ''
  );

  // ── Goal & Emotional Why scripts ──────────────────────────────────
  const goalScripts = config.goalEmotionalWhyScripts || config.goalScripts;
  prompt = prompt.replace(
    /\{\{goalEmotionalWhyScriptsContext\}\}/g,
    goalScripts
      ? `\n### GOAL & EMOTIONAL WHY SCRIPTS\n${typeof goalScripts === 'string' ? goalScripts : JSON.stringify(goalScripts, null, 2)}`
      : ''
  );

  // ── Emotional disclosure patterns ─────────────────────────────────
  const emotionalPatterns = config.emotionalDisclosurePatterns as any;
  prompt = prompt.replace(
    /\{\{emotionalDisclosurePatternsContext\}\}/g,
    emotionalPatterns
      ? `\n### EMOTIONAL DISCLOSURE PATTERNS\nWhen a lead shares personal pain, respond using these patterns:\n${typeof emotionalPatterns === 'string' ? emotionalPatterns : JSON.stringify(emotionalPatterns, null, 2)}`
      : ''
  );

  // ── Urgency scripts ───────────────────────────────────────────────
  const urgencyScripts = config.urgencyScripts || config.urgencyQuestion;
  prompt = prompt.replace(
    /\{\{urgencyScriptsContext\}\}/g,
    urgencyScripts
      ? `\n### URGENCY SCRIPTS\n${typeof urgencyScripts === 'string' ? urgencyScripts : JSON.stringify(urgencyScripts, null, 2)}`
      : ''
  );

  // ── Soft pitch scripts ────────────────────────────────────────────
  const softPitch = config.softPitchScripts || config.callPitchMessage;
  prompt = prompt.replace(
    /\{\{softPitchScriptsContext\}\}/g,
    softPitch
      ? `\n### SOFT PITCH SCRIPTS\n${typeof softPitch === 'string' ? softPitch : JSON.stringify(softPitch, null, 2)}`
      : ''
  );

  // ── Commitment confirmation ───────────────────────────────────────
  const commitConfirm =
    config.commitmentConfirmationScript ||
    config.softPitchScripts?.commitmentConfirmation;
  prompt = prompt.replace(
    /\{\{commitmentConfirmationContext\}\}/g,
    commitConfirm
      ? `\n### COMMITMENT CONFIRMATION SCRIPT\nUse this after the lead confirms interest in the soft pitch:\n${commitConfirm}`
      : ''
  );

  // ── Financial screening scripts ───────────────────────────────────
  const finWaterfall = p.financialWaterfall as any;
  if (finWaterfall) {
    const levels = Array.isArray(finWaterfall)
      ? finWaterfall
      : [
          finWaterfall.level1,
          finWaterfall.level2,
          finWaterfall.level3,
          finWaterfall.level4
        ].filter(Boolean);
    const fwText = levels
      .map(
        (lvl: any, i: number) =>
          `**Level ${i + 1}: ${lvl.label || `Level ${i + 1}`}**\n${lvl.question || lvl}\n${lvl.passAction ? `If pass: ${lvl.passAction}` : ''}`
      )
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{financialScreeningScriptsContext\}\}/g,
      `\n### FINANCIAL SCREENING SCRIPTS\n${fwText}`
    );
  } else {
    const fsScripts = config.financialScreeningScripts;
    prompt = prompt.replace(
      /\{\{financialScreeningScriptsContext\}\}/g,
      fsScripts
        ? `\n### FINANCIAL SCREENING SCRIPTS\n${typeof fsScripts === 'string' ? fsScripts : JSON.stringify(fsScripts, null, 2)}`
        : ''
    );
  }

  // ── Low-ticket pitch ──────────────────────────────────────────────
  const lowTicket = config.lowTicketPitchScripts || config.lowTicketPitch;
  prompt = prompt.replace(
    /\{\{lowTicketPitchContext\}\}/g,
    lowTicket
      ? `\n### LOW-TICKET PITCH SEQUENCE\nUse this when all financial waterfall levels are exhausted:\n${typeof lowTicket === 'string' ? lowTicket : JSON.stringify(lowTicket, null, 2)}`
      : ''
  );

  // ── Booking scripts ───────────────────────────────────────────────
  const bookingScripts =
    config.bookingScripts || config.bookingConfirmationMessage;
  prompt = prompt.replace(
    /\{\{bookingScriptsContext\}\}/g,
    bookingScripts
      ? `\n### BOOKING SCRIPTS\n${typeof bookingScripts === 'string' ? bookingScripts : JSON.stringify(bookingScripts, null, 2)}`
      : ''
  );

  // ── Objection protocols (tenant data) ─────────────────────────────
  const objHandling = p.objectionHandling as any;
  if (objHandling && typeof objHandling === 'object') {
    // Support both array and object formats
    let objText: string;
    if (Array.isArray(objHandling)) {
      objText = objHandling
        .map((obj: any) => {
          const keywords = obj.triggerKeywords?.join(', ') || '';
          return `### ${obj.type || 'CUSTOM'}\n**Trigger keywords:** ${keywords}\n**Protocol:**\n${obj.script || obj.response || ''}`;
        })
        .join('\n\n');
    } else {
      objText = Object.entries(objHandling)
        .map(([key, val]: [string, any]) => {
          if (typeof val === 'object' && val !== null) {
            const keywords = val.triggerKeywords?.join(', ') || '';
            return `### ${key}\n**Trigger keywords:** ${keywords}\n**Protocol:**\n${val.script || val.response || JSON.stringify(val)}`;
          }
          return `### ${key}\n**Protocol:**\n${val}`;
        })
        .join('\n\n');
    }
    prompt = prompt.replace(
      /\{\{objectionProtocolsContext\}\}/g,
      `\n### OBJECTION PROTOCOLS\n${objText}`
    );
  } else {
    prompt = prompt.replace(/\{\{objectionProtocolsContext\}\}/g, '');
  }

  // ── Stall scripts (tenant data) ───────────────────────────────────
  const stallScripts = config.stallScripts;
  if (stallScripts) {
    let stallText: string;
    if (Array.isArray(stallScripts)) {
      stallText = stallScripts
        .map((s: any) => {
          const followUps =
            s.followUps
              ?.map((f: string, i: number) => `  Follow-up ${i + 1}: "${f}"`)
              .join('\n') || '';
          return `**${s.type}**\nInitial: "${s.initial || ''}"\n${followUps}\nSoft exit: "${s.softExit || ''}"`;
        })
        .join('\n\n');
    } else {
      stallText =
        typeof stallScripts === 'string'
          ? stallScripts
          : JSON.stringify(stallScripts, null, 2);
    }
    prompt = prompt.replace(
      /\{\{stallScriptsContext\}\}/g,
      `\n### STALL SCRIPTS\n${stallText}`
    );
  } else {
    // Fall back to legacy stall scripts from promptConfig
    const legacyStalls: string[] = [];
    if (config.stallTimeScript)
      legacyStalls.push(`**TIME_DELAY:**\n${config.stallTimeScript}`);
    if (config.stallMoneyScript)
      legacyStalls.push(`**MONEY_DELAY:**\n${config.stallMoneyScript}`);
    if (config.stallThinkScript)
      legacyStalls.push(`**THINKING:**\n${config.stallThinkScript}`);
    if (config.stallPartnerScript)
      legacyStalls.push(`**PARTNER:**\n${config.stallPartnerScript}`);
    prompt = prompt.replace(
      /\{\{stallScriptsContext\}\}/g,
      legacyStalls.length
        ? `\n### STALL SCRIPTS\n${legacyStalls.join('\n\n')}`
        : ''
    );
  }

  // ── No-show scripts (tenant data) ─────────────────────────────────
  const noShow = p.noShowProtocol as any;
  if (noShow) {
    const nsParts: string[] = [];
    if (noShow.firstNoShow)
      nsParts.push(`**First no-show:** ${noShow.firstNoShow}`);
    if (noShow.secondNoShow)
      nsParts.push(`**Second no-show (pull-back):** ${noShow.secondNoShow}`);
    prompt = prompt.replace(
      /\{\{noShowScriptsContext\}\}/g,
      nsParts.length ? `\n### NO-SHOW SCRIPTS\n${nsParts.join('\n')}` : ''
    );
  } else {
    prompt = prompt.replace(/\{\{noShowScriptsContext\}\}/g, '');
  }

  // ── Pre-call sequence (tenant data) ───────────────────────────────
  const preCall = p.preCallSequence as any[];
  if (preCall?.length) {
    const pcText = preCall
      .map((step: any) => `- ${step.timing}: "${step.message}"`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{preCallSequenceContext\}\}/g,
      `\n### PRE-CALL MESSAGES\n${pcText}`
    );
  } else {
    const preCallConfig = config.preCallMessages;
    if (preCallConfig) {
      const parts: string[] = [];
      if (preCallConfig.nightBefore)
        parts.push(`- Night before (9pm): "${preCallConfig.nightBefore}"`);
      if (preCallConfig.morningOf)
        parts.push(`- Morning of (9:30am): "${preCallConfig.morningOf}"`);
      if (preCallConfig.oneHourBefore)
        parts.push(`- 1 hour before: "${preCallConfig.oneHourBefore}"`);
      prompt = prompt.replace(
        /\{\{preCallSequenceContext\}\}/g,
        parts.length ? `\n### PRE-CALL MESSAGES\n${parts.join('\n')}` : ''
      );
    } else {
      prompt = prompt.replace(/\{\{preCallSequenceContext\}\}/g, '');
    }
  }

  // ── Income framing rule ───────────────────────────────────────────
  const incomeRule = config.incomeFramingRule;
  prompt = prompt.replace(
    /\{\{incomeFramingRuleContext\}\}/g,
    incomeRule ? `\n### INCOME FRAMING RULE\n${incomeRule}` : ''
  );

  // ── Asset links ───────────────────────────────────────────────────
  const assets = config.assetLinks;
  if (assets && typeof assets === 'object') {
    const assetParts: string[] = [];
    if (assets.bookingLink)
      assetParts.push(`- Booking link: ${assets.bookingLink}`);
    if (assets.courseLink)
      assetParts.push(`- Course link: ${assets.courseLink}`);
    if (assets.freeValueLink || p.freeValueLink)
      assetParts.push(
        `- Free value link: ${assets.freeValueLink || p.freeValueLink}`
      );
    if (assets.videoLinks?.length) {
      assets.videoLinks.forEach((v: any) => {
        if (typeof v === 'string') assetParts.push(`- Video: ${v}`);
        else if (v.label && v.url) assetParts.push(`- ${v.label}: ${v.url}`);
      });
    }
    prompt = prompt.replace(
      /\{\{assetLinksContext\}\}/g,
      assetParts.length ? `\n### ASSET LINKS\n${assetParts.join('\n')}` : ''
    );
  } else {
    prompt = prompt.replace(/\{\{assetLinksContext\}\}/g, '');
  }

  // ── Training examples (few-shot) ──────────────────────────────────
  if (trainingExamples.length > 0) {
    const exText = trainingExamples
      .map(
        (ex) =>
          `**[${ex.category}]**\nLead: "${ex.leadMessage}"\nIdeal Response: "${ex.idealResponse}"${ex.notes ? `\nNote: ${ex.notes}` : ''}`
      )
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{trainingExamplesContext\}\}/g,
      `\n### TRAINING EXAMPLES\nUse these as reference for tone and style:\n\n${exText}`
    );
  } else {
    prompt = prompt.replace(/\{\{trainingExamplesContext\}\}/g, '');
  }

  // ── Knowledge assets ──────────────────────────────────────────────
  const knowledge = p.knowledgeAssets as any[];
  if (knowledge?.length) {
    const kaText = knowledge
      .map(
        (ka: any) =>
          `### ${ka.title}\n${ka.content}\n*Deploy when: ${ka.deployTrigger || 'relevant'}*`
      )
      .join('\n\n');
    prompt = prompt.replace(
      /\{\{knowledgeAssetsContext\}\}/g,
      `\n### KNOWLEDGE ASSETS\n${kaText}`
    );
  } else {
    prompt = prompt.replace(/\{\{knowledgeAssetsContext\}\}/g, '');
  }

  // ── Proof points ──────────────────────────────────────────────────
  const proofs = p.proofPoints as any[];
  if (proofs?.length) {
    const ppText = proofs
      .map(
        (pp: any) =>
          `- ${pp.name}: ${pp.result} (deploy when: ${pp.deployContext || pp.deployTrigger || 'building credibility'})`
      )
      .join('\n');
    prompt = prompt.replace(
      /\{\{proofPointsContext\}\}/g,
      `\n### PROOF POINTS / SOCIAL PROOF\n${ppText}`
    );
  } else {
    prompt = prompt.replace(/\{\{proofPointsContext\}\}/g, '');
  }

  // ── Custom phrases ────────────────────────────────────────────────
  const phrases = p.customPhrases as any;
  if (phrases && typeof phrases === 'object') {
    const cpText = Object.entries(phrases)
      .map(([key, val]) => `- ${key}: "${val}"`)
      .join('\n');
    prompt = prompt.replace(
      /\{\{customPhrasesContext\}\}/g,
      `\n### CUSTOM PHRASES\nUse these naturally in your messages:\n${cpText}`
    );
  } else {
    prompt = prompt.replace(/\{\{customPhrasesContext\}\}/g, '');
  }

  // ── Custom system prompt override ─────────────────────────────────
  if (p.systemPrompt && p.systemPrompt.trim().length > 100) {
    prompt = p.systemPrompt + '\n\n---\n\n' + prompt;
  }

  return prompt;
}

/**
 * Get the current system prompt version for an account (for tracking).
 */
export async function getPromptVersion(accountId: string): Promise<string> {
  const latestVersion = await prisma.promptVersion.findFirst({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: { version: true }
  });
  return latestVersion?.version || '1.0.0';
}
