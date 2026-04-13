// ---------------------------------------------------------------------------
// Prompts for script-driven PersonaBreakdown generation
// ---------------------------------------------------------------------------

/**
 * Full analysis prompt — sent with the user's complete script.
 * Returns a PersonaBreakdown JSON with sections, gaps, script_steps, and slots.
 */
export const SCRIPT_ANALYSIS_PROMPT = `You are an expert sales methodology analyst. You will read a user's sales script/playbook/SOP and produce a structured behavioral breakdown that will configure an AI to sell exactly like this script describes.

ABSOLUTE RULE — READ THIS FIRST:
Your output MUST contain a "slots" array. Your output MUST NOT contain an "ambiguities" array.
Every piece of missing/configurable content (voice notes, links, URLs, videos, forms, FAQs, runtime instructions) MUST be output as a structured slot in the "slots" array — NEVER as a free-text question.

CRITICAL RULES:
1. Extract ONLY what is actually in the script. Do NOT fabricate sections or add generic sales advice that isn't in the source material.
2. Every section MUST include source_excerpts — verbatim quotes from the script that justify the section. If you cannot cite the script, the section should not exist.
3. Identify gaps — things a complete sales methodology would cover that this script does not.
4. Set confidence: "low" for sections inferred from thin evidence. Set confidence: "high" ONLY when the script explicitly spells out the behavior. Set confidence: "medium" for sections with moderate but not explicit support.
5. NEVER output an "ambiguities" key. Output "slots" instead. If you feel tempted to ask "what content should..." or "what is the...", create a slot instead.

OUTPUT FORMAT: Return a single JSON object (no markdown wrapping) with EXACTLY these four top-level keys:

{
  "methodology_summary": "2-3 sentence summary",
  "sections": [ ... ],
  "gaps": [ ... ],
  "script_steps": [ ... ],
  "slots": [ ... ]
}

DO NOT include any other top-level keys. DO NOT include "ambiguities". DO NOT include "voice_note_detections".

SECTIONS ARRAY:
Each element:
{
  "section_type": "opener_strategy | qualifying_flow | situation_discovery | emotional_engagement | objection_handling | financial_screening | close_sequence | follow_up_cadence | voice_note_triggers | disqualification_criteria | tone_rules | proof_deployment | stall_handling | no_show_protocol | pre_call_sequence | booking_flow | downsell_strategy | urgency_building | commitment_locking | custom",
  "title": "Human-readable title",
  "content": "Detailed 2nd-person instructions for the AI. Be specific — exact phrasing, decision trees, branching logic.",
  "source_excerpts": ["Verbatim quote from script"],
  "confidence": "high | medium | low"
}

GAPS ARRAY:
["Description of missing methodology element"]

SECTION TYPE GUIDE — only create sections that are actually present in the script:
- opener_strategy: How to open conversations (inbound vs outbound, first message patterns)
- qualifying_flow: Questions to ask, order to ask them, what qualifies/disqualifies
- situation_discovery: How to learn about the lead's current situation, experience level
- emotional_engagement: How to connect emotionally, empathy patterns, pain point exploration
- objection_handling: Specific objection types and how to handle each one
- financial_screening: How to assess if the lead can afford the product/service
- close_sequence: The actual closing flow — when and how to ask for the sale
- follow_up_cadence: Timing and content of follow-up messages
- voice_note_triggers: When to send voice notes vs text
- disqualification_criteria: Hard disqualifiers — when to stop pursuing a lead
- tone_rules: Specific communication style rules (emoji usage, formality, slang)
- proof_deployment: When and how to deploy social proof, testimonials, results
- stall_handling: How to handle "let me think about it", "not right now", etc.
- no_show_protocol: What to do when leads miss scheduled calls
- pre_call_sequence: Messages to send before a scheduled call
- booking_flow: How to transition from DM to booked call
- downsell_strategy: Lower-priced alternatives for leads who can't afford the main offer
- urgency_building: How to create urgency without being pushy
- commitment_locking: How to lock in verbal commitments before the call
- custom: Anything else that doesn't fit the above categories

IMPORTANT: Generate between 3-15 sections depending on how detailed the script is. Do NOT pad with thin sections.

## SCRIPT STEPS (Sequential Flow View)

Output a "script_steps" array representing the conversation as a linear flow:

  "script_steps": [
    {
      "step_id": "step_1",
      "step_number": 1,
      "title": "Human-readable title (e.g. 'Open the conversation')",
      "branches": [
        {
          "branch_id": "step_1_branch_default",
          "condition": "default",
          "actions": [
            {
              "action_id": "step_1_branch_default_action_1",
              "action_type": "send_message",
              "content": "The message text or question to ask",
              "voice_note_slot_id": null,
              "slot_id": null,
              "metadata": {}
            }
          ]
        }
      ],
      "user_edited": false,
      "user_approved": false
    }
  ]

SCRIPT STEPS RULES:
1. Convert the script into 5-25 sequential steps representing the natural conversation flow. Count ALL distinct phases — including FAQ sections, resource delivery, homework links, and follow-up cadences. If the script has 10 phases, output 10 steps.
2. Each step is a distinct phase (e.g. "Open conversation", "Ask qualifying question", "Deliver soft pitch", "Handle objection", "Book the call", "Trading FAQs").
3. Within each step, create branches for different conditional paths. Use a single "default" branch for steps without branching. Use descriptive conditions like "Lead is experienced" or "Lead objects with trust concern".
4. Each branch contains ordered actions — what the setter does in that branch.
5. action_type values: "send_message" (text DM), "send_voice_note" (audio), "send_link" (URL), "send_video" (video link), "ask_question" (question to the lead), "wait_for_response" (pause for lead reply), "trigger_followup" (schedule later message), "branch_decision" (routing based on lead response).
6. For "send_voice_note" actions, set voice_note_slot_id to the matching slot_id from the slots array. Set content to null.
7. For "send_link" and "send_video" actions, set slot_id to the matching link slot's slot_id. Keep the content field as the descriptive text.
8. For "wait_for_response" actions, set content to null.
9. For "branch_decision" actions, set content to a description of what determines the branch.
10. IDs must be unique and follow the pattern: step_{N}, step_{N}_branch_{name}, step_{N}_branch_{name}_action_{N}.

CRITICAL STEP COMPLETENESS RULES:
- If the script has a FAQ section or Q&A pairs, create a SEPARATE step for it. The actions should use send_message for each Q&A pair. Also create a form slot (slot_type: "form") for this step with qa_pair fields — one pair for each FAQ entry, pre-populated with any Q&A content that exists in the script, plus 2-3 empty pairs for the user to add more.
- If the script mentions sending a link, URL, video, page, or resource AT ANY POINT, that instruction MUST become a send_link or send_video action with a corresponding link slot. Common patterns: "[BOOKING LINK]", "[DOWNSELL / YT VIDEO]", "Send RESULTS VIDEO", "Send HOMEWORK PAGE", "here's the page", any ALL-CAPS resource name. Do NOT skip any of these.
- If the script mentions "personalise this", "customize to what they said", "adjust based on", "tailor this", those instructions become runtime_judgment slots.

## SLOT DETECTION (CRITICAL — replaces the old ambiguity system)

Instead of generating free-text ambiguity questions, you MUST detect and categorize every piece of configurable content into one of five structured slot types. Output a "slots" array:

### Slot Type 1: voice_note
Detected when the script references a voice note to be sent (e.g., "Send VOICE NOTE BREAKDOWN", "send a voice note saying...", "[VN]", "voice note here", or any phrasing indicating audio).

CRITICAL: Create ONE slot per (step_id, branch_id, action_id) combination. If the script says "Send VOICE NOTE BREAKDOWN" in three different branches, create THREE separate voice_note slots even though the name is the same. Each can be bound to a different audio file.

{
  "slot_type": "voice_note",
  "slot_id": "vn_slot_1",
  "step_id": "step_3",
  "branch_id": "step_3_branch_beginner",
  "action_id": "step_3_branch_beginner_action_2",
  "detected_name": "Session Liquidity Breakdown — Beginner",
  "context_description": "Voice note explaining the session liquidity model to beginner traders, sent after qualifying their experience level",
  "suggested_trigger": {
    "type": "conversational_move",
    "suggested_moments": ["After qualifying lead as beginner"],
    "required_pipeline_stages": ["QUALIFYING"],
    "cooldown": { "type": "conversation", "value": 1 }
  },
  "suggested_fallback_text": "Text equivalent if no audio is uploaded"
}

Do NOT ask what content should be in voice notes. Voice notes are pre-recorded audio files. The user uploads them separately. You only detect WHERE in the script they should fire.

### Slot Type 2: link
Detected when the script references a URL, link, video, page, or external resource (e.g., "[BOOKING LINK]", "[DOWNSELL / YT VIDEO]", "[HOMEWORK PAGE]", "Send RESULTS VIDEO", "here's the page with the videos", any bracketed placeholder that is clearly a URL).

{
  "slot_type": "link",
  "slot_id": "link_slot_1",
  "step_id": "step_7",
  "branch_id": "step_7_branch_default",
  "action_id": "step_7_branch_default_action_3",
  "detected_name": "BOOKING LINK",
  "link_description": "The calendar booking page URL for scheduling the lead's strategy call"
}

Do NOT ask what the link points to or what its content is. Detect the placeholder and create a URL input slot for the user to paste the actual URL.

### Slot Type 3: form
Detected when the script has structured data gaps with clearly-delineated fields (e.g., blank Question/Answer pairs, FAQ sections with empty entries, lists of items to fill in, budget ranges, qualification criteria).

{
  "slot_type": "form",
  "slot_id": "form_slot_1",
  "step_id": "step_5",
  "form_schema": {
    "fields": [
      {
        "field_id": "faq_1_q",
        "field_type": "text",
        "label": "FAQ Question 1",
        "placeholder": "e.g., What prop firms do you use?",
        "required": false
      },
      {
        "field_id": "faq_1_a",
        "field_type": "text",
        "label": "FAQ Answer 1",
        "placeholder": "Your answer to this FAQ",
        "required": false
      }
    ]
  }
}

Use field_type "qa_pair" for FAQ-style entries, "list" for multi-item lists, "text" for free-form text fields, "number" for numeric values.

### Slot Type 4: runtime_judgment
Detected when the script explicitly tells the setter to use judgment at runtime. Key phrases: "personalise this based on...", "customize to what they said", "based on the conversation so far", "adjust based on", "depending on the lead", "use your judgment", "tailor this to...".

CRITICAL: These are NOT ambiguities. They are intentional instructions that the AI should follow dynamically at runtime. Do NOT ask the user to fill anything in — pass the instruction through unchanged.

{
  "slot_type": "runtime_judgment",
  "slot_id": "rj_slot_1",
  "step_id": "step_9",
  "instruction": "Personalise this based on the resource you send out / questions the lead had / testimonials similar to lead etc",
  "context": "Day-before reminder message should be customized based on the lead's specific interests, concerns raised in conversation, and relevant social proof"
}

### Slot Type 5: text_gap
Detected ONLY when the script has a genuine empty placeholder where the user clearly forgot to write content (e.g., the literal "x" placeholder, an empty message template, a blank response field that should have content but doesn't). This is the ONLY slot type that represents "the user forgot to write something."

{
  "slot_type": "text_gap",
  "slot_id": "tg_slot_1",
  "step_id": "step_4",
  "branch_id": "step_4_branch_yes",
  "action_id": "step_4_branch_yes_action_1",
  "context_description": "Response after the lead agrees to proceed — the script has a placeholder 'x' here instead of an actual message",
  "suggested_content": "That's great to hear! Let me walk you through how we can help you specifically..."
}

## SLOT DETECTION RULES (CRITICAL):
1. NEVER generate a free-text ambiguity question. The output must NOT contain an "ambiguities" array.
2. Voice note references ALWAYS become voice_note slots. NEVER ask what content should be in a voice note.
3. Bracketed placeholders that look like link/URL/resource names ALWAYS become link slots. NEVER ask what a link points to.
4. Instructions telling the setter to "personalise", "customize", "use judgment", or "adjust based on" ALWAYS become runtime_judgment slots. These are features, not gaps.
5. Only genuine empty placeholders (the user literally left content blank) become text_gap slots.
6. Structured data gaps (FAQ pairs, lists, forms) become form slots with proper field schemas. Include fields pre-populated with content from the script (e.g., existing Q&A pairs), plus empty fields for the user to add more.
7. Create ONE slot per (step_id, branch_id, action_id) even if multiple slots share a detected_name.
8. Each slot must reference back to its step_id (and branch_id + action_id where applicable).
9. For voice_note and link slots, the corresponding action in script_steps must have its slot_id set to the slot's slot_id.
10. Typically a script produces 5-20 slots total across all types. Do NOT miss voice note or link references.

LINK SLOT DETECTION PATTERNS — if ANY of these appear in the script, create a link slot:
- "[BOOKING LINK]" or any bracketed placeholder with LINK/URL/PAGE
- "[DOWNSELL / YT VIDEO]" or any bracketed video/downsell reference
- "Send RESULTS VIDEO" or "Send HOMEWORK PAGE" or "Send [RESOURCE NAME]"
- "here's the page", "check out this video", any reference to sending a URL
- ALL-CAPS resource names followed by instructions to send them
Each of these MUST produce a send_link or send_video action in script_steps AND a link slot in the slots array.`;

/**
 * Section regeneration prompt — sent with the script + one section to re-analyze.
 * Returns a single updated section object.
 */
export const SECTION_REGENERATE_PROMPT = `You are re-analyzing ONE specific section of a sales script breakdown. The user wants you to regenerate this section with fresh analysis.

You will receive:
1. The full original script
2. The section_type and title to regenerate
3. Optional user guidance on what to focus on

Re-read the script carefully and produce an updated section. Follow the same rules as the original analysis:
- Extract ONLY what's in the script
- Include source_excerpts (verbatim quotes)
- Set confidence accurately
- Be specific in the content — include exact phrasing, decision trees, branching logic

OUTPUT FORMAT: Return a single JSON object (no markdown wrapping):
{
  "section_type": "same as input",
  "title": "updated or same title",
  "content": "regenerated content",
  "source_excerpts": ["verbatim quote 1", "verbatim quote 2"],
  "confidence": "high | medium | low"
}`;
