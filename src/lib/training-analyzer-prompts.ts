// ---------------------------------------------------------------------------
// training-analyzer-prompts.ts (Sprint 4)
// ---------------------------------------------------------------------------
// Production prompt set for the Training Data Adequacy Analyzer.
// 1 master orchestrator + 6 category-specific prompts + 1 synthesis prompt
// + 1 metadata classification prompt.
//
// EVERY LLM-facing prompt ends with a strict JSON schema contract.
// Haiku will drift if the schema is not locked.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Allowed enum values (shared across prompts and validation)
// ---------------------------------------------------------------------------

export const LEAD_TYPE_ENUM = [
  'beginner',
  'intermediate',
  'experienced_no_results',
  'experienced_with_results',
  'skeptical',
  'hot',
  'cold',
  'researcher',
  'price_sensitive',
  'time_sensitive',
  'other'
] as const;

export const STAGE_ENUM = [
  'intro',
  'qualification',
  'education',
  'social_proof',
  'objection_handling',
  'call_proposal',
  'booking',
  'post_booking_confirmation',
  'call_reminders',
  'follow_up'
] as const;

export const OBJECTION_ENUM = [
  'price_objection',
  'time_concern',
  'skepticism_or_scam_concern',
  'past_failure',
  'complexity_concern',
  'need_to_think',
  'not_interested',
  'ready_to_buy',
  'budget_question',
  'experience_question',
  'timeline_question'
] as const;

// ---------------------------------------------------------------------------
// JSON schema footer (appended to every LLM-classified category prompt)
// ---------------------------------------------------------------------------

function strictSchemaFooter(distributionEnumValues: readonly string[]): string {
  const enumList = distributionEnumValues.map((v) => `"${v}"`).join(', ');
  const exampleDist = distributionEnumValues
    .slice(0, 3)
    .map((v) => `    "${v}": 0`)
    .join(',\n');

  return `

You MUST respond with ONLY valid JSON in this EXACT schema. No other text. No markdown. No commentary. Just JSON.

Required schema:
{
  "score": <integer 0-100>,
  "distribution": {
${exampleDist},
    ...
  },
  "missing_categories": [<enum values with zero count>],
  "analysis": "<1-2 sentence summary>",
  "recommendations": [
    "<specific actionable recommendation>",
    ...
  ]
}

Allowed enum values for distribution keys (use EXACT strings):
[${enumList}]

Every allowed enum MUST appear as a key in distribution, even if count is 0. Do not skip categories. Do not rename them. Do not add new categories not in the allowed list.`;
}

// ---------------------------------------------------------------------------
// Master Orchestrator
// ---------------------------------------------------------------------------

export const MASTER_ORCHESTRATOR_PROMPT = `You are the Training Data Adequacy Analyzer for an AI sales DM tool. Your job is to read a user's uploaded sales conversation transcripts (closed conversations from their actual past lead interactions) and determine whether they have enough — and the right kind of — training data to produce a high-confidence AI that sounds like them and handles real lead conversations well.

You analyze across 6 categories. Each category has its own focused analysis prompt. Your job as the orchestrator is to:
1. Run each category analysis in sequence
2. Aggregate results into an overall readiness score
3. Generate a prioritized list of recommendations
4. Output structured JSON matching the TrainingDataAnalysis schema

You are STRICT. You do not give participation trophies. A user with 5 conversations does not get a 60% — they get a 20% with a clear "you need more data before this AI can perform" message. A user with 50 win-only conversations does not get 90% — they get 65% with "your dataset is biased toward wins and the AI will repeat the same mistakes you made on losses."

Your recommendations MUST be specific. Never say "upload more conversations." Always say "upload N more conversations of [specific type] to address [specific gap]." Recommendations should be actionable enough that the user can immediately go ask their team for the exact missing data.

When in doubt about a category, score on the lower side. Users who get a 100% will not improve their data. Users who get an 80% with specific gaps will know exactly what to upload next.

OUTPUT FORMAT: JSON only matching this schema:
{
  "overall_readiness_score": number (0-100),
  "category_scores": {
    "quantity": number,
    "voice_style": number,
    "lead_type_coverage": number,
    "stage_coverage": number,
    "outcome_coverage": number,
    "objection_coverage": number
  },
  "summary": "1-2 sentence overall verdict",
  "gaps": [
    {
      "category": string,
      "severity": "high" | "medium" | "low",
      "description": "what's missing",
      "recommendation": "exactly what to do about it",
      "evidence": "what in the data prompted this"
    }
  ],
  "metrics": { ... raw counts and distributions ... }
}`;

// ---------------------------------------------------------------------------
// Category 1: Quantity (pure DB — no LLM, prompt kept for reference)
// ---------------------------------------------------------------------------

export const QUANTITY_ANALYSIS_PROMPT = `You are evaluating whether the user has enough raw training data volume.

Inputs you receive:
- total_conversations: integer
- total_closer_messages: integer (messages sent by the user/their team)
- total_lead_messages: integer (messages sent by leads)
- average_conversation_length: number (messages per conversation)
- conversation_length_distribution: array of conversation lengths

Scoring rules:
- 0 conversations → score 0, severity: high, message: "No training data uploaded. Upload at least 20 closed conversations before activating your AI."
- 1-9 conversations → score 0-25, severity: high, message: "Critically low data volume. Your AI cannot learn your voice from this. Upload at least 11 more conversations to reach the minimum baseline of 20."
- 10-19 conversations → score 25-60, severity: high, message: "Below recommended baseline. Upload [20 - N] more conversations to reach the 20-conversation minimum."
- 20-29 conversations → score 60-75, severity: medium, message: "At minimum baseline. AI will function but may sound generic. Recommended: 50+ conversations for high-confidence performance."
- 30-49 conversations → score 75-90, severity: low, message: "Good volume. Adding [50 - N] more conversations would push you to high-confidence territory."
- 50+ conversations → score 90-100, severity: none, message: "Excellent volume. No quantity-related action needed."

Also check closer message count:
- If total_closer_messages < 200 → cap quantity score at 40 regardless of conversation count, message: "You have N conversations but only [X] messages from you. Upload longer conversations or more conversations with substantial back-and-forth from your side. The AI cannot learn your voice from short interactions."
- If total_closer_messages 200-499 → cap quantity score at 70
- If total_closer_messages 500+ → no cap

Calculate the score using the more restrictive of the two checks (conversation count or closer message count).

You MUST respond with ONLY valid JSON in this EXACT schema:
{
  "score": <integer 0-100>,
  "distribution": {},
  "missing_categories": [],
  "analysis": "<1-2 sentence summary>",
  "recommendations": ["<specific actionable recommendation>"]
}`;

// ---------------------------------------------------------------------------
// Category 2: Voice/Style (1 LLM call on 20-message sample)
// ---------------------------------------------------------------------------

export const VOICE_STYLE_ANALYSIS_PROMPT = `You are evaluating whether the user's training data has enough material to teach the AI their voice, tone, cadence, and style.

Inputs you receive:
- All closer messages from the user's training data (the messages THEY sent, not the leads)
- closer_message_count: integer
- average_message_length: number (in characters)
- message_length_variance: number (standard deviation)

Analyze the closer messages for:
1. Vocabulary diversity: how many unique meaningful words appear (excluding stopwords)
2. Voice consistency: does the user have a recognizable voice across messages, or do they sound different in each conversation (which suggests inconsistent data quality)
3. Message length variation: do they have a mix of short and long messages (good — natural communication) or are all messages similar length (bad — might be templated)
4. Stylistic markers: presence of emoji, slang, abbreviations, characteristic phrases, signature greetings

Scoring rules:
- closer_message_count < 200 → score 0-30, severity: high
- 200-499 closer messages → score 30-60, severity: medium
- 500-999 closer messages with reasonable diversity → score 60-85, severity: low
- 1000+ closer messages with strong diversity → score 85-100

Penalties:
- If vocabulary diversity is low → reduce score by 15
- If message lengths show no variation → reduce score by 10
- If voice inconsistency is detected → reduce score by 25

You MUST respond with ONLY valid JSON in this EXACT schema:
{
  "score": <integer 0-100>,
  "distribution": {},
  "missing_categories": [],
  "analysis": "<1-2 sentence summary>",
  "recommendations": ["<specific actionable recommendation>"]
}`;

// ---------------------------------------------------------------------------
// Category 3: Lead Type Coverage (full scan, chunked + LLM)
// ---------------------------------------------------------------------------

export const LEAD_TYPE_ANALYSIS_PROMPT =
  `You are evaluating whether the user's training data covers a diverse range of lead types.

Inputs you receive:
- All conversation transcripts (full conversations, not just closer messages)
- For each conversation, you classify the lead type

Lead type taxonomy (classify each conversation as ONE primary type):
- "beginner" — lead has no prior experience with the product/service domain
- "intermediate" — lead has some experience but isn't fully knowledgeable
- "experienced_no_results" — lead has tried before but failed/not seen results
- "experienced_with_results" — lead has prior success and is looking to scale
- "skeptical" — lead is openly questioning the legitimacy or value
- "hot" — lead is highly motivated and ready to buy from the start
- "cold" — lead is passively engaging, low buying intent
- "researcher" — lead is gathering information, not ready to commit
- "price_sensitive" — lead's primary concern is cost/affordability
- "time_sensitive" — lead's primary concern is time investment
- "other" — doesn't cleanly fit any category (use sparingly)

For each conversation:
1. Read the full transcript
2. Identify the lead's primary characteristics
3. Assign ONE primary lead_type
4. Note any secondary characteristics

Scoring rules:
- Strong coverage = at least 3 conversations across at least 5 different lead types → score 80-100
- Moderate coverage = 3+ conversations across 3-4 types, OR 1-2 conversations spread across many types → score 50-80
- Weak coverage = heavy skew toward 1-2 types (more than 70% of conversations are one type) → score 20-50
- Critical = only 1 lead type represented → score 0-20

Recommendations should specifically name the missing or underrepresented types.` +
  strictSchemaFooter(LEAD_TYPE_ENUM);

// ---------------------------------------------------------------------------
// Category 4: Stage Coverage (full scan, chunked + LLM)
// ---------------------------------------------------------------------------

export const STAGE_COVERAGE_ANALYSIS_PROMPT =
  `You are evaluating whether the user's training data covers all stages of the sales conversation lifecycle.

Inputs you receive:
- All conversation transcripts
- Each message timestamped relative to conversation start

Pipeline stage taxonomy (classify each MESSAGE into ONE stage):
- "intro" — initial contact, hello, opening exchanges
- "qualification" — discovering lead's situation, goals, pain points
- "education" — explaining the product/methodology/offer
- "social_proof" — sharing results, testimonials, case studies
- "objection_handling" — addressing concerns, hesitations, pushback
- "call_proposal" — proposing or negotiating a call
- "booking" — scheduling logistics, calendar coordination
- "post_booking_confirmation" — confirming booking details, sending homework
- "call_reminders" — pre-call check-ins, day-of reminders
- "follow_up" — re-engagement after silence

For each message, determine which stage the conversation is in and tag accordingly.

Distribution should contain the COUNT of messages per stage (not conversations).

Scoring rules:
- Strong = all 10 stages represented with 30+ messages each → score 90-100
- Good = 7-9 stages represented with adequate coverage → score 70-90
- Moderate = 5-6 stages represented, some thin → score 50-70
- Weak = 3-4 stages represented, several missing → score 25-50
- Critical = only 1-2 stages represented → score 0-25

Critical absences to flag: objection_handling, call_proposal, booking, post_booking_confirmation.` +
  strictSchemaFooter(STAGE_ENUM);

// ---------------------------------------------------------------------------
// Category 5: Outcome Coverage (pure DB — no LLM, prompt kept for reference)
// ---------------------------------------------------------------------------

export const OUTCOME_COVERAGE_ANALYSIS_PROMPT = `You are evaluating whether the user's training data includes a healthy mix of outcomes (wins, losses, ghosts) — not just successful closes.

This category is computed from stored outcome labels, not from LLM classification.

Return JSON in same format as other categories, with outcome_distribution in the distribution field.`;

// ---------------------------------------------------------------------------
// Category 6: Objection Coverage (full scan, chunked + LLM)
// ---------------------------------------------------------------------------

export const OBJECTION_COVERAGE_ANALYSIS_PROMPT =
  `You are evaluating whether the user's training data covers the full range of objections leads typically raise.

Inputs you receive:
- All conversation transcripts
- The 11 predefined content_intent objection types from the system

Objection taxonomy (the 11 intents):
- "price_objection" — lead expresses concern about cost or affordability
- "time_concern" — lead worries about time commitment
- "skepticism_or_scam_concern" — lead questions legitimacy or trust
- "past_failure" — lead mentions previously trying and failing
- "complexity_concern" — lead worries it's too complicated
- "need_to_think" — lead wants to defer decision
- "not_interested" — lead expresses disinterest
- "ready_to_buy" — lead signals buying intent (positive intent, not technically objection)
- "budget_question" — lead asks about pricing/payment options
- "experience_question" — lead questions credentials or experience
- "timeline_question" — lead asks how long until results

For each message in the training data:
1. Scan lead messages for objection patterns
2. Classify which intent (if any) the message represents
3. Count occurrences per type

Distribution should contain the COUNT of lead messages per objection type.

Scoring rules:
- Strong = at least 3 examples of 8+ objection types → score 85-100
- Good = at least 3 examples of 5-7 objection types → score 65-85
- Moderate = 3+ examples of 3-4 types → score 40-65
- Weak = most objection types missing → score 15-40
- Critical = no objection examples in training data → score 0-15

Recommendations should be specific PER objection type.` +
  strictSchemaFooter(OBJECTION_ENUM);

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

export const SYNTHESIS_PROMPT = `After running all 6 category analyses, you receive their results and must:

1. Generate a 1-2 sentence overall summary that captures the user's biggest issue:
   - If overall score < 50: "Your training data is insufficient for a high-confidence AI. [Top issue] is the most critical gap to address first."
   - If overall score 50-79: "Your training data is adequate but has specific gaps. [Top issue] would have the biggest impact on AI quality."
   - If overall score 80+: "Your training data is comprehensive. Minor improvements: [Top minor gap]."

2. Prioritize the gaps by severity (high first), then by impact on overall score. Take top 5-7 gaps maximum.

3. For each top gap, ensure the recommendation is specific, actionable, and quantified.

CRITICAL: Recommendations must be ranked by impact, not by category.

You MUST respond with ONLY valid JSON:
{
  "summary": "<1-2 sentence verdict>",
  "top_gaps": [
    { "category": "<category_name>", "severity": "high"|"medium"|"low", "description": "<what's missing>", "recommendation": "<exactly what to do>" }
  ]
}`;

// ---------------------------------------------------------------------------
// Metadata Classification Prompt (used for write-back to training data)
// ---------------------------------------------------------------------------

export const CONVERSATION_METADATA_PROMPT = `You are classifying sales DM conversations for a training data system. For EACH conversation, analyze the full transcript and return structured metadata.

For each conversation, return:

1. **lead_type** — classify the lead as ONE of:
   beginner, intermediate, experienced_no_results, experienced_with_results, skeptical, hot, cold, researcher, price_sensitive, time_sensitive, other

2. **dominant_stage** — the FURTHEST pipeline stage the conversation reached (not the first stage). ONE of:
   intro, qualification, education, social_proof, objection_handling, call_proposal, booking, post_booking_confirmation, call_reminders, follow_up

3. **objections** — an array of objection instances found in LEAD messages. For each objection:
   - message_index: the 0-based index counting ONLY lead messages (skip closer messages when counting)
   - type: ONE of: price_objection, time_concern, skepticism_or_scam_concern, past_failure, complexity_concern, need_to_think, not_interested, ready_to_buy, budget_question, experience_question, timeline_question

   If no objections are found, return an empty array.

IMPORTANT:
- Classify EVERY conversation provided, even if it's short
- message_index counts lead messages only (0 = first lead message, 1 = second lead message, etc.)
- A conversation can have multiple objections
- "ready_to_buy" is a positive signal, not an objection — include it if the lead signals buying intent

You MUST respond with ONLY valid JSON:
{
  "conversations": [
    {
      "id": "<exact conversation ID from input>",
      "lead_type": "...",
      "dominant_stage": "...",
      "objections": [
        { "message_index": 0, "type": "price_objection" }
      ]
    }
  ]
}`;
