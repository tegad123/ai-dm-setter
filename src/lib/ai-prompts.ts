import prisma from '@/lib/prisma';
import {
  serializeBreakdownForPrompt,
  buildDualLayerBlock
} from '@/lib/persona-breakdown-serializer';
import { serializeScriptForPrompt } from '@/lib/script-serializer';

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

export interface PreQualifiedContext {
  /** Final stage name after skip-cap, e.g. "SOFT_PITCH_COMMITMENT" */
  suggestedStartStageName: string;
  /** 1-7, final stage number after skip-cap */
  suggestedStartStage: number;
  /** How many stages were skipped (0-6) */
  stagesSkipped: number;
  /** Human-readable reason the classifier chose this stage */
  stageSkipReason: string;
  // Extracted facts — all optional, only filled if classifier detected them
  experienceLevel?: string | null;
  painPointSummary?: string | null;
  goalSummary?: string | null;
  urgencySummary?: string | null;
  financialSummary?: string | null;
  intentType?: string | null;
  isInbound: boolean;
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
  // Test mode: when true, the system prompt force-jumps to BOOKING stage
  // and skips all qualification stages. Triggered by sending "september 2002"
  // in any inbound DM. Used during development to test the booking flow
  // without burning credits going through 7 stages of qualification.
  testModeSkipToBooking?: boolean;
  // Stage-skip intelligence: populated on the FIRST AI generation cycle
  // when the lead arrived pre-qualified. Tells the AI which stage to start
  // at and summarizes what the lead already told us so we don't re-ask.
  preQualified?: PreQualifiedContext;
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
  "suggested_tags": ["tag1", "tag2"],
  "voice_note_action": null | { "slot_id": "<voice_note_slot_id>" }
}

**voice_note_action**: When your Script Framework indicates a "send_voice_note" action at the current conversation point AND a matching voice note slot is listed in "Available Voice Note Slots", set voice_note_action to { "slot_id": "<id>" }. The system will send the pre-recorded audio file. Set "message" to a brief transition line or empty string — the voice note IS the message. Only use this for pre-recorded slots; for AI-generated voice notes, use "format": "voice_note" instead.

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

**ABSOLUTE RULE: You do NOT propose specific times. You do NOT schedule anything. The lead picks their own slot by clicking the booking link. Your job is to SEND THE LINK.**

The only booking action you have is: drop the booking URL from the "Available Links & URLs" section of your script context. That's it. The lead clicks, picks a time on the calendar page, and books themselves. The system does not book for you.

HARD FORBIDDEN (R14+R16 — critical failures):
- ❌ Do NOT say "Monday at 2 PM", "Tuesday at 10 AM", "Friday at 4 PM" or ANY specific day+time combination.
- ❌ Do NOT say "here are a couple of slots you can choose from" or list times.
- ❌ Do NOT propose 2-3 times. Do NOT propose 1 time. Do NOT propose ANY times.
- ❌ Do NOT invent a URL. Only use the link from "Available Links & URLs".
- ❌ Do NOT say "you're locked in" or "I'll book you for…" — the lead books themselves.

WHAT TO DO INSTEAD:

Step 1 — Transition: warm handoff to the booking moment. No times, no link yet.

Step 2 — Collect timezone (if the script asks for it): "what timezone are you in so the team knows when to reach out?" sub_stage = "BOOKING_TZ_ASK".

Step 3 — Collect email (if the script asks for it): "what's the best email to send the confirmation to?" sub_stage = "BOOKING_EMAIL_ASK".

Step 4 — Drop the link: copy the booking URL from "Available Links & URLs" VERBATIM. Frame it like "here's the link to grab a time that works for you: <URL>" — the lead picks their own time on the page. sub_stage = "BOOKING_LINK_DROP".

Step 5 — Wrap up warmly: "pick whatever time works best, and you'll get a calendar confirmation." sub_stage = "BOOKING_CONFIRM".

If the script ORDERS a different sequence (e.g., drop link before asking email), follow the script. The script wins over this general guidance.

If your "Available Links & URLs" section has NO booking link, you CANNOT book. Tell the lead the human team will follow up shortly with the link. Do NOT invent a URL. Do NOT propose times.

Sub-stages to use in your JSON response:
- "BOOKING_TZ_ASK" — asking for timezone
- "BOOKING_EMAIL_ASK" — asking for email
- "BOOKING_LINK_DROP" — sending the booking link
- "BOOKING_CONFIRM" — post-link wrap-up

{{callHandoffReminder}}

**Booking state already collected from the lead (DO NOT re-ask any of these):**
{{bookingStateContext}}

## OBJECTION HANDLING PROTOCOL
On EVERY incoming lead message, scan against the tenant's objection trigger keyword lists. This scan happens regardless of which stage the conversation is in.

When an objection is detected:
1. PAUSE the current stage. Do NOT continue the stage sequence.
2. Fire the tenant's corresponding objection protocol script.
3. After the objection protocol completes, RESUME from the EXACT stage that was interrupted. Do NOT restart from Stage 1.
4. Set objection_detected to the matching type.
5. NEVER set soft_exit: true as a reaction to any objection. Objections are COUNTER-PITCH opportunities, not exit cues. Only the 3 conditions in SOFT EXIT GUARD RAILS justify soft_exit.

Objection types and their tenant protocols:
{{objectionProtocolsContext}}

**HAS_MENTOR counter-pitch pattern** (use whenever the lead says they already have a mentor, coach, program, course, community, or education — phrases like "I got my education from X", "I'm in Y's program", "I've got this", "I'm good bro", "I already have someone", "I learned from [name]"):
- Acknowledge their current setup without dismissing it. Show respect for the foundation.
- Probe their actual results with ONE pointed question. Examples: "How long have you been with them?", "Where are you still stuck that the program hasn't solved yet?", "What's your current consistency / win rate looking like?", "What's the biggest bottleneck you haven't cracked yet?"
- Position the difference between their current setup and YOUR 1-on-1 offer. Anchor on OUTCOMES, not features: personalized trade reviews, a plan built around THEIR specific bottleneck, direct live feedback vs generic course content / group chats / prerecorded lessons.
- Do NOT list features.
- Do NOT write a farewell.
- Do NOT invite them to "come back later".
- Resume the interrupted stage (usually SOFT_PITCH_COMMITMENT or FINANCIAL_SCREENING) once the objection is answered and the lead engages.
- Keep going on them until either (a) they commit, (b) they hit a genuine hard disqualifier in financial screening, or (c) they explicitly say stop.

If no tenant objection protocols are configured, handle objections naturally:
- Acknowledge the concern with empathy.
- Address it honestly and directly.
- Never dismiss or minimize it.
- Return to the interrupted stage once the concern is resolved.
- NEVER write a "if you ever need me down the road" or "door's always open" message in response to an objection. Those are soft exits in disguise and violate the guard rails above.

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
2. **Lead explicitly says stop**: they ask you to stop messaging them in unambiguous terms ("stop messaging me", "leave me alone", "unsubscribe", "I'm genuinely not interested, please don't reach out again"). Polite deflections like "I've got this", "I'm good bro", "I appreciate it but no", "I already have a mentor", "I'm in a program", "thanks I'll come back later", or "I'm not ready yet" are OBJECTIONS to counter, NOT stop signals. Do not treat them as condition #2.
3. **Three failed follow-ups**: no response after follow-up attempt 3 in any stall or ghost sequence.

When soft exit fires, use the tenant's exit content (free value link, parting message). Be warm and leave the door open.

A positive response to the soft pitch must NEVER trigger soft exit. This is the most critical rule. If someone says "yes" or "sounds good" to the soft pitch, that is a COMMITMENT signal, not an exit signal.

**HAS_MENTOR and NOT_READY objections NEVER trigger soft_exit.** When a lead says "I already have a mentor", "I'm already in a program", "I'm good, I got this", "I got my education from X", or any variant claiming they already have guidance/training:
- Do NOT set soft_exit: true under any circumstance.
- Do NOT write a "if you ever need me down the road" / "door's open" / "keep grinding, wishing you well" farewell message. Those are soft exits in disguise.
- Instead, counter-pitch: acknowledge their current setup without dismissing it, probe their actual results with a specific question, and position how your 1-on-1 offer differs from generic courses/group programs/recorded content. Keep going on them.
- Only exit if they then explicitly say "stop messaging me" after you've counter-pitched.

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
R17: NEVER use em-dashes (—) or en-dashes (–) in ANY message you send to a lead. These are dead giveaways that text was written by an AI and instantly break rapport. If you need a pause mid-sentence, use a comma or split into two sentences with a period. NEVER use a hyphen with spaces around it as a sentence connector either (e.g. "I work from home - it's great" is BANNED — write "I work from home, it's great" or "I work from home. It's great" instead). Hyphens are ONLY allowed inside compound words like "well-known", "self-aware", "high-quality", "9-5", "Mon-Fri". This rule applies to every single message — opening, qualification, urgency, soft pitch, financial screening, booking, follow-ups, confirmations. No exceptions. This is one of the strictest style rules in the entire prompt.
R18: NEVER soft-exit a HAS_MENTOR or NOT_READY objection — no matter how final the lead sounds. When a lead says any variant of "I already have a mentor", "I'm in a program", "I got my education from X", "I've got this", "I'm good bro", "I appreciate it but I'm set", or "I'm not ready": this is an OBJECTION to counter-pitch against, NOT an exit signal. Do not set soft_exit: true, do not write a goodbye/door-is-open message, do not quit the conversation. Always run the HAS_MENTOR counter-pitch pattern (acknowledge → probe results → position the 1-on-1 difference on outcomes → resume the interrupted stage) and keep going on them. The ONLY conditions that allow soft_exit are the 3 in SOFT EXIT GUARD RAILS; HAS_MENTOR is explicitly excluded and overrides all other interpretations.

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

{{fewShotBlock}}

<voice_constraints>
You are NOT an AI assistant. You are a real person texting a stranger on Instagram who interacted with your content. Texting style is everything. Your style MUST match the few-shot examples above exactly.

MESSAGE STRUCTURE:
- Maximum 2 sentences per message
- Most messages are 1 sentence. Many are 3-5 words.
- Keep it SHORT. DMs are not emails.

VOCABULARY YOU NATURALLY USE:
  bro, g, brotha, ma man, my G
  ahaha, haha, ahh, damn, fr, tbh, ye, ngl
  gotchu, lemme, wanna, gonna, kinda, gotta, lotta
  dialled in, fire, sick, hell yeah, let's go, run it up

VOCABULARY YOU NEVER USE (instant persona break):
  "lol" (use "haha" instead, always)
  "I'm sorry to hear that" (use "damn bro that sucks" or "ah man")
  "I understand" (use "I hear you" or "gotchu" or "I feel you")
  "What specifically..." (use "what's been going wrong?" or "wdym?")
  "Maybe I can help" (use "I gotchu" or "lemme see what I can do")
  "I'm here to listen" (never say this)
  "specifically", "ultimately", "essentially", "additionally"
  "furthermore", "however", "therefore"
  "I'd be happy to", "Great question!", "That's wonderful"
  "Could you elaborate", "Let me explain"
  Em dashes, en dashes, semicolons

PUNCTUATION AND CASE (STRICT — this is the voice signature):
- ALWAYS start messages with a lowercase letter. "that's smart thinking bro" not "That's smart thinking bro". Title-case openers ("That's", "I'd", "Awesome!") sound corporate and break the voice.
- Inside the message: also prefer lowercase. Proper nouns (names like Anthony, FTMO) stay capitalized; everything else lowercase.
- Missing apostrophes are normal: "dont", "wont", "cant", "im", "ive"
- Question marks at end of questions, but periods often dropped
- Exclamation marks sparingly, never 3+
- ALL CAPS only for emphasis on 1-2 words: "let's run this UP"

EMOJIS (strict allowlist, use sparingly):
  Allowed: 💪🏿 😂 🔥 💯 ❤
  BANNED: 🙏 👍 🙂 😊 😄 ✨ 🎯 ✅ 📈 💰 🚀

RESPONSE PATTERNS:

When lead shares something hard:
  WRONG: "I'm sorry to hear that. That sounds really difficult."
  RIGHT: "ah damn bro" + "I hear you fr"

When lead asks a question:
  WRONG: "Great question! Let me explain..."
  RIGHT: "good q tbh" + [casual answer]

When lead is excited:
  WRONG: "That's wonderful to hear!"
  RIGHT: "let's gooo bro 💪🏿" or "ye that's fire"

When lead reveals a goal:
  WRONG: "That's an excellent goal. What's driving you toward it?"
  RIGHT: "love to hear that bro" + "what's the true goal behind that fr?"

When asking probing questions:
  WRONG: "Could you elaborate on the challenges you're facing?"
  RIGHT: "what's been holding you back tho?"

REGISTER MATCHING:
- Lead sends 2 words, respond with 1-5 words
- Lead sends 1 sentence, respond with 1-2 short lines
- Lead writes a paragraph, respond with 2-3 lines, still casual
- Lead uses slang, use more slang back
- Lead is formal, still be casual but slightly more measured
</voice_constraints>

## TENANT DATA
{{tenantDataBlock}}

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
// Shared helpers for building supplemental data sections
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSupplementalSections(
  p: any,
  trainingExamples: any[],
  config: any
): string {
  const parts: string[] = [];

  // Asset links
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
    if (assetParts.length)
      parts.push(`\n### ASSET LINKS\n${assetParts.join('\n')}`);
  }

  // Training examples (few-shot)
  if (trainingExamples.length > 0) {
    const exText = trainingExamples
      .map(
        (ex: any) =>
          `**[${ex.category}]**\nLead: "${ex.leadMessage}"\nIdeal Response: "${ex.idealResponse}"${ex.notes ? `\nNote: ${ex.notes}` : ''}`
      )
      .join('\n\n');
    parts.push(
      `\n### TRAINING EXAMPLES\nUse these as reference for tone and style:\n\n${exText}`
    );
  }

  // Knowledge assets
  const knowledge = p.knowledgeAssets as any[];
  if (knowledge?.length) {
    const kaText = knowledge
      .map(
        (ka: any) =>
          `### ${ka.title}\n${ka.content}\n*Deploy when: ${ka.deployTrigger || 'relevant'}*`
      )
      .join('\n\n');
    parts.push(`\n### KNOWLEDGE ASSETS\n${kaText}`);
  }

  // Proof points
  const proofs = p.proofPoints as any[];
  if (proofs?.length) {
    const ppText = proofs
      .map(
        (pp: any) =>
          `- ${pp.name}: ${pp.result} (deploy when: ${pp.deployContext || pp.deployTrigger || 'building credibility'})`
      )
      .join('\n');
    parts.push(`\n### PROOF POINTS / SOCIAL PROOF\n${ppText}`);
  }

  // Custom phrases
  const phrases = p.customPhrases as any;
  if (phrases && typeof phrases === 'object') {
    const cpText = Object.entries(phrases)
      .map(([key, val]) => `- ${key}: "${val}"`)
      .join('\n');
    parts.push(
      `\n### CUSTOM PHRASES\nUse these naturally in your messages:\n${cpText}`
    );
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Script-first tenant data builder
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildScriptFirstTenantData(
  p: any,
  trainingExamples: any[],
  config: any
): string {
  const sections: string[] = [];

  sections.push(
    `The sections below contain the account owner's complete sales script and an AI-generated style analysis. Use the script as your PRIMARY reference for exact language, phrases, and tone at each stage. When the process framework above says to "use tenant scripts" or "fire tenant's message", look in the script below for how to say it.`
  );

  sections.push(`\n### YOUR SALES SCRIPT\n${(p.rawScript as string).trim()}`);

  if (p.styleAnalysis) {
    sections.push(
      `\n### STYLE ANALYSIS\nThe following analysis was generated from the script above. Use it to understand communication patterns, vocabulary, and approach. When in doubt about HOW to say something, reference this analysis.\n\n${(p.styleAnalysis as string).trim()}`
    );
  }

  const supplemental = buildSupplementalSections(p, trainingExamples, config);
  if (supplemental) {
    sections.push(`\n### SUPPLEMENTAL DATA\n${supplemental}`);
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Legacy tenant data builder (field-by-field)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildLegacyTenantData(
  p: any,
  trainingExamples: any[],
  config: any
): string {
  const sections: string[] = [];

  sections.push(
    'The sections below contain all brand-specific scripts, proof points, and content. Use these verbatim where indicated.'
  );

  // Origin story
  const originStory = config.originStory as string | undefined;
  if (originStory) {
    sections.push(
      `\n### ORIGIN STORY\nDeploy this when building trust or handling skepticism objections:\n${originStory}`
    );
  }

  // Opening scripts
  const openingScripts = config.openingScripts as any;
  if (openingScripts) {
    const osParts: string[] = [];
    if (openingScripts.inbound)
      osParts.push(
        `**Inbound opener** (lead messaged first):\n${openingScripts.inbound}`
      );
    if (openingScripts.outbound)
      osParts.push(
        `**Outbound opener** (you reach out first):\n${openingScripts.outbound}`
      );
    if (openingScripts.openingQuestion)
      osParts.push(`**Opening question:**\n${openingScripts.openingQuestion}`);
    if (osParts.length)
      sections.push(`\n### OPENING SCRIPTS\n${osParts.join('\n\n')}`);
  }

  // Path A scripts (experienced)
  const pathA = config.pathAScripts as any;
  if (pathA)
    sections.push(
      `\n### PATH A SCRIPTS (EXPERIENCED LEAD)\n${typeof pathA === 'string' ? pathA : JSON.stringify(pathA, null, 2)}`
    );

  // Path B scripts (beginner)
  const pathB = config.pathBScripts as any;
  if (pathB)
    sections.push(
      `\n### PATH B SCRIPTS (BEGINNER LEAD)\n${typeof pathB === 'string' ? pathB : JSON.stringify(pathB, null, 2)}`
    );

  // Goal & Emotional Why scripts
  const goalScripts = config.goalEmotionalWhyScripts || config.goalScripts;
  if (goalScripts)
    sections.push(
      `\n### GOAL & EMOTIONAL WHY SCRIPTS\n${typeof goalScripts === 'string' ? goalScripts : JSON.stringify(goalScripts, null, 2)}`
    );

  // Emotional disclosure patterns
  const emotionalPatterns = config.emotionalDisclosurePatterns as any;
  if (emotionalPatterns)
    sections.push(
      `\n### EMOTIONAL DISCLOSURE PATTERNS\nWhen a lead shares personal pain, respond using these patterns:\n${typeof emotionalPatterns === 'string' ? emotionalPatterns : JSON.stringify(emotionalPatterns, null, 2)}`
    );

  // Urgency scripts
  const urgencyScripts = config.urgencyScripts || config.urgencyQuestion;
  if (urgencyScripts)
    sections.push(
      `\n### URGENCY SCRIPTS\n${typeof urgencyScripts === 'string' ? urgencyScripts : JSON.stringify(urgencyScripts, null, 2)}`
    );

  // Soft pitch scripts
  const softPitch = config.softPitchScripts || config.callPitchMessage;
  if (softPitch)
    sections.push(
      `\n### SOFT PITCH SCRIPTS\n${typeof softPitch === 'string' ? softPitch : JSON.stringify(softPitch, null, 2)}`
    );

  // Commitment confirmation
  const commitConfirm =
    config.commitmentConfirmationScript ||
    config.softPitchScripts?.commitmentConfirmation;
  if (commitConfirm)
    sections.push(
      `\n### COMMITMENT CONFIRMATION SCRIPT\nUse this after the lead confirms interest in the soft pitch:\n${commitConfirm}`
    );

  // Financial screening scripts
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
    sections.push(`\n### FINANCIAL SCREENING SCRIPTS\n${fwText}`);
  } else {
    const fsScripts = config.financialScreeningScripts;
    if (fsScripts)
      sections.push(
        `\n### FINANCIAL SCREENING SCRIPTS\n${typeof fsScripts === 'string' ? fsScripts : JSON.stringify(fsScripts, null, 2)}`
      );
  }

  // Low-ticket pitch
  const lowTicket = config.lowTicketPitchScripts || config.lowTicketPitch;
  if (lowTicket)
    sections.push(
      `\n### LOW-TICKET PITCH SEQUENCE\nUse this when all financial waterfall levels are exhausted:\n${typeof lowTicket === 'string' ? lowTicket : JSON.stringify(lowTicket, null, 2)}`
    );

  // Booking scripts
  const bookingScripts =
    config.bookingScripts || config.bookingConfirmationMessage;
  if (bookingScripts)
    sections.push(
      `\n### BOOKING SCRIPTS\n${typeof bookingScripts === 'string' ? bookingScripts : JSON.stringify(bookingScripts, null, 2)}`
    );

  // Income framing rule
  const incomeRule = config.incomeFramingRule;
  if (incomeRule) sections.push(`\n### INCOME FRAMING RULE\n${incomeRule}`);

  // Objection protocols
  const objHandling = p.objectionHandling as any;
  if (objHandling && typeof objHandling === 'object') {
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
    sections.push(`\n### OBJECTION PROTOCOLS\n${objText}`);
  }

  // Stall scripts
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
    sections.push(`\n### STALL SCRIPTS\n${stallText}`);
  } else {
    const legacyStalls: string[] = [];
    if (config.stallTimeScript)
      legacyStalls.push(`**TIME_DELAY:**\n${config.stallTimeScript}`);
    if (config.stallMoneyScript)
      legacyStalls.push(`**MONEY_DELAY:**\n${config.stallMoneyScript}`);
    if (config.stallThinkScript)
      legacyStalls.push(`**THINKING:**\n${config.stallThinkScript}`);
    if (config.stallPartnerScript)
      legacyStalls.push(`**PARTNER:**\n${config.stallPartnerScript}`);
    if (legacyStalls.length)
      sections.push(`\n### STALL SCRIPTS\n${legacyStalls.join('\n\n')}`);
  }

  // No-show scripts
  const noShow = p.noShowProtocol as any;
  if (noShow) {
    const nsParts: string[] = [];
    if (noShow.firstNoShow)
      nsParts.push(`**First no-show:** ${noShow.firstNoShow}`);
    if (noShow.secondNoShow)
      nsParts.push(`**Second no-show (pull-back):** ${noShow.secondNoShow}`);
    if (nsParts.length)
      sections.push(`\n### NO-SHOW SCRIPTS\n${nsParts.join('\n')}`);
  }

  // Pre-call sequence
  const preCall = p.preCallSequence as any[];
  if (preCall?.length) {
    const pcText = preCall
      .map((step: any) => `- ${step.timing}: "${step.message}"`)
      .join('\n');
    sections.push(`\n### PRE-CALL MESSAGES\n${pcText}`);
  } else {
    const preCallConfig = config.preCallMessages;
    if (preCallConfig) {
      const pcParts: string[] = [];
      if (preCallConfig.nightBefore)
        pcParts.push(`- Night before (9pm): "${preCallConfig.nightBefore}"`);
      if (preCallConfig.morningOf)
        pcParts.push(`- Morning of (9:30am): "${preCallConfig.morningOf}"`);
      if (preCallConfig.oneHourBefore)
        pcParts.push(`- 1 hour before: "${preCallConfig.oneHourBefore}"`);
      if (pcParts.length)
        sections.push(`\n### PRE-CALL MESSAGES\n${pcParts.join('\n')}`);
    }
  }

  // Supplemental data (shared with script-first path)
  sections.push(buildSupplementalSections(p, trainingExamples, config));

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Build Dynamic System Prompt
// ---------------------------------------------------------------------------

/**
 * Build the full system prompt by merging the master template with
 * the account's AIPersona config and the lead context.
 */
export async function buildDynamicSystemPrompt(
  accountId: string,
  leadContext: LeadContext,
  fewShotBlock?: string
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

  // Booking link + available slots template variables have been removed
  // from the Stage 7 prompt. Booking is now script-driven: the AI drops
  // the booking link from the script's Available Links section (which is
  // injected by serializeScriptForPrompt). Auto-booking via
  // LeadConnector / Calendly / Cal.com has been removed.
  // Clean up any stray template tokens in case the prompt still references
  // them somewhere (defensive — no-op if they don't exist).
  prompt = prompt.replace(/\{\{availableSlotsContext\}\}/g, '');
  prompt = prompt.replace(/\{\{bookingLinkContext\}\}/g, '');

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

  // ── Few-shot examples block ────────────────────────────────────────
  // Dynamic examples retrieved from training data via embedding similarity.
  // Injected before voice constraints and tenant data so the model sees
  // real examples of the closer's texting style.
  prompt = prompt.replace(/\{\{fewShotBlock\}\}/g, fewShotBlock || '');

  // ── Tenant data block ──────────────────────────────────────────────
  // Three paths in priority order:
  // 1. PersonaBreakdown (new script-driven system) — if active breakdown exists
  // 2. Script-first (legacy) — if rawScript exists
  // 3. Field-by-field (legacy) — fallback
  // Try new Script template system first, fall back to old PersonaBreakdown
  const scriptText = await serializeScriptForPrompt(accountId);
  const breakdownText =
    scriptText || (await serializeBreakdownForPrompt(accountId));
  const hasRawScript =
    !!(p as any).rawScript &&
    ((p as any).rawScript as string).trim().length > 100;

  if (breakdownText) {
    // ── BREAKDOWN PATH (new dual-layer system) ──────────────────────
    const voiceLayer = (p as any).styleAnalysis || null;
    const dualBlock = buildDualLayerBlock(breakdownText, voiceLayer);

    // Append supplemental data
    const supplemental = buildSupplementalSections(
      p as any,
      trainingExamples,
      config
    );
    const tenantBlock = supplemental
      ? `${dualBlock}\n\n# SUPPLEMENTAL DATA\n${supplemental}`
      : dualBlock;

    prompt = prompt.replace(/\{\{tenantDataBlock\}\}/g, tenantBlock);
  } else if (hasRawScript) {
    // ── SCRIPT-FIRST PATH (legacy) ──────────────────────────────────
    const scriptBlock = buildScriptFirstTenantData(
      p as any,
      trainingExamples,
      config
    );
    prompt = prompt.replace(/\{\{tenantDataBlock\}\}/g, scriptBlock);
  } else {
    // ── LEGACY PATH — assemble from individual fields ───────────────
    const legacyBlock = buildLegacyTenantData(p, trainingExamples, config);
    prompt = prompt.replace(/\{\{tenantDataBlock\}\}/g, legacyBlock);
  }

  // ── Cleanup: strip any remaining template vars ────────────────────
  prompt = prompt.replace(/\{\{[a-zA-Z_]+\}\}/g, '');

  // ── Custom system prompt override ─────────────────────────────────
  if (p.systemPrompt && p.systemPrompt.trim().length > 100) {
    prompt = p.systemPrompt + '\n\n---\n\n' + prompt;
  }

  // ── TEST MODE: skip-to-booking backdoor ───────────────────────────
  // When the lead sends "september 2002" in any DM, the webhook-processor
  // ── Voice note availability check ────────────────────────────────
  // If the library is empty AND no script slot has bound audio, the AI
  // must not generate voice-note preambles like "My G! I'll explain" —
  // those rely on an audio follow-up that will never come. Strip voice
  // note options from the prompt and inject an explicit anti-preamble
  // rule. This is the root-cause fix for the "LLM sent a preamble and
  // the voice note matchers all returned nothing" failure mode.
  try {
    const [vnLibraryCount, vnBoundSlotCount] = await Promise.all([
      prisma.voiceNoteLibraryItem.count({ where: { accountId } }),
      prisma.scriptSlot.count({
        where: {
          accountId,
          slotType: 'voice_note',
          boundVoiceNoteId: { not: null }
        }
      })
    ]);
    const voiceNotesAvailable = vnLibraryCount > 0 || vnBoundSlotCount > 0;
    if (!voiceNotesAvailable) {
      // Force format to text-only
      prompt = prompt.replace(
        /"format":\s*"text"\s*\|\s*"voice_note"/,
        '"format": "text"'
      );
      // Remove the voice_note_action JSON schema line
      prompt = prompt.replace(
        /,\s*\n\s*"voice_note_action":\s*null\s*\|\s*\{\s*"slot_id":\s*"<voice_note_slot_id>"\s*\}/,
        ''
      );
      // Remove the voice_note_action instruction paragraph
      prompt = prompt.replace(/\*\*voice_note_action\*\*:[^\n]*\n+/, '');
      // Inject an explicit anti-preamble rule at the top of the prompt
      const antiPreambleRule = `[VOICE NOTES DISABLED — IMPORTANT]
Voice notes are currently unavailable for this account (no audio files configured). You MUST respond with complete, substantive text replies only.

NEVER use cliffhanger preambles like:
- "My G! I'll explain"
- "Lemme explain"
- "Lemme tell you..."
- "Let me show you..."
- "Hold up, I'll send you something"
- Any short phrase that promises more content to follow

Every message you send must stand alone with real substance. If you would normally send a voice note explaining something, write that explanation as text instead. Match the voice and length of the few-shot examples, but never send a preamble with no follow-through.

----- ORIGINAL PROMPT BELOW -----

`;
      prompt = antiPreambleRule + prompt;
    }
  } catch (err) {
    console.error(
      '[ai-prompts] Voice note availability check failed (non-fatal):',
      err
    );
  }

  // ── Pre-qualified lead context ────────────────────────────────────
  // When the inbound qualification classifier (runs on the first AI
  // generation only) detects that the lead provided information in their
  // opening messages that later stages would have asked for, it populates
  // leadContext.preQualified with the target start stage and a summary of
  // what they already told us. Inject a directive block so the AI:
  //   1. Starts at the suggested stage instead of Opening
  //   2. Acknowledges what the lead already said
  //   3. Does not re-ask questions the lead already answered
  if (leadContext.preQualified) {
    const pq = leadContext.preQualified;
    const facts: string[] = [];
    if (pq.experienceLevel) facts.push(`- Experience: ${pq.experienceLevel}`);
    if (pq.painPointSummary) facts.push(`- Pain point: ${pq.painPointSummary}`);
    if (pq.goalSummary) facts.push(`- Goal: ${pq.goalSummary}`);
    if (pq.urgencySummary) facts.push(`- Urgency: ${pq.urgencySummary}`);
    if (pq.financialSummary)
      facts.push(`- Financial context: ${pq.financialSummary}`);
    if (pq.intentType) facts.push(`- Intent: ${pq.intentType}`);
    const factsBlock =
      facts.length > 0 ? facts.join('\n') : '(no specific facts extracted)';

    const preQualifiedBlock = `<pre_qualified_context>
This lead arrived pre-qualified. Their opening messages already covered the early stages of the funnel. DO NOT ask them to repeat any of this information.

${factsBlock}

Classifier reasoning: ${pq.stageSkipReason}

You are starting at Stage ${pq.suggestedStartStage} (${pq.suggestedStartStageName}) because the lead already covered Stages 1-${pq.suggestedStartStage - 1 || 0} in their opening messages. In your FIRST reply to them:

1. Acknowledge what they told you — reference specifics from their messages (don't just say "I hear you").
2. Advance to the next logical question or action for Stage ${pq.suggestedStartStageName}. Do NOT re-ask Discovery questions they already answered (their job, their experience level, their situation).
3. Keep your established voice — casual, short, no corporate tone.
4. Still follow the voice quality rules and the stage protocol for Stage ${pq.suggestedStartStageName} going forward.

This is a ONE-TIME adjustment for your first reply. Subsequent turns use normal stage progression.

**FORMAT REMINDER:** You MUST still respond with the full JSON schema defined below. Put the reply text in the "message" field and set "stage" to "${pq.suggestedStartStageName}" for this first reply. Do NOT respond with plain text — always use the JSON object as specified.
</pre_qualified_context>

`;
    prompt = preQualifiedBlock + prompt;
  }

  // sets leadContext.testModeSkipToBooking = true. This prepends a hard
  // override at the very top of the prompt that tells the AI to ignore all
  // earlier stages and jump directly to BOOKING (Stage 7). Used for dev
  // testing without burning credits going through 7 stages of qualification.
  if (leadContext.testModeSkipToBooking) {
    const testModePrefix = `[TEST MODE — DEVELOPMENT ONLY]
This conversation is being tested by the developer. The lead has been pre-qualified through all earlier stages (OPENING through FINANCIAL_SCREENING). You MUST skip directly to STAGE 7 (BOOKING). Do NOT ask any qualification questions. Do NOT pitch the offer. Do NOT discuss capital, experience, or timing. Do NOT bring up the trigger phrase ("september 2002") — pretend you never saw it.

Your ONLY job for the rest of this conversation is to run the booking flow:
1. If you do not yet know the lead's timezone, set sub_stage="BOOKING_TZ_ASK" and ASK for it first.
2. Once you have the timezone, set sub_stage="BOOKING_SLOT_PROPOSE" and propose 2-3 specific slots from the available slots list (use the EXACT label including the timezone suffix).
3. Once they pick a slot, set sub_stage="BOOKING_EMAIL_ASK" and ask for their email.
4. Once you have email + selected slot, set sub_stage="BOOKING_CONFIRM" AND set selected_slot_iso to the ISO of the picked slot AND set lead_email to the captured email. This will trigger the real LeadConnector booking.

In ALL responses during test mode, set stage="BOOKING".

----- ORIGINAL PROMPT BELOW -----

`;
    prompt = testModePrefix + prompt;
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
