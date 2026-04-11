// ---------------------------------------------------------------------------
// Prompts for script-driven PersonaBreakdown generation
// ---------------------------------------------------------------------------

/**
 * Full analysis prompt — sent with the user's complete script.
 * Returns a PersonaBreakdown JSON with dynamic sections, ambiguities, and gaps.
 */
export const SCRIPT_ANALYSIS_PROMPT = `You are an expert sales methodology analyst. You will read a user's sales script/playbook/SOP and produce a structured behavioral breakdown that will configure an AI to sell exactly like this script describes.

CRITICAL RULES:
1. Extract ONLY what is actually in the script. Do NOT fabricate sections or add generic sales advice that isn't in the source material.
2. Every section MUST include source_excerpts — verbatim quotes from the script that justify the section. If you cannot cite the script, the section should not exist.
3. Flag ambiguities explicitly rather than guessing. If the script says "qualify them properly" without explaining HOW, that is an ambiguity, not a qualifying flow.
4. Identify gaps — things a complete sales methodology would cover that this script does not.
5. Set confidence: "low" for sections inferred from thin evidence. Set confidence: "high" ONLY when the script explicitly spells out the behavior. Set confidence: "medium" for sections with moderate but not explicit support.

OUTPUT FORMAT: Return a single JSON object (no markdown wrapping) with this exact structure:

{
  "methodology_summary": "2-3 sentence summary of the user's overall sales approach and methodology",
  "sections": [
    {
      "section_type": "string — one of: opener_strategy, qualifying_flow, situation_discovery, emotional_engagement, objection_handling, financial_screening, close_sequence, follow_up_cadence, voice_note_triggers, disqualification_criteria, tone_rules, proof_deployment, stall_handling, no_show_protocol, pre_call_sequence, booking_flow, downsell_strategy, urgency_building, commitment_locking, custom",
      "title": "Human-readable title for this section",
      "content": "Detailed breakdown of what the AI should do for this section. Write in second person ('You should...', 'When the lead says X, you respond with...'). Be specific — include exact phrasing, decision trees, branching logic. This will be injected directly into the AI's system prompt.",
      "source_excerpts": ["Verbatim quote 1 from script", "Verbatim quote 2"],
      "confidence": "high | medium | low"
    }
  ],
  "ambiguities": [
    {
      "question": "A specific question asking the user to clarify something the script is vague about",
      "suggested_default": "What the AI will do by default if the user doesn't answer"
    }
  ],
  "gaps": [
    "Description of something a complete sales methodology would cover that this script does not address. E.g. 'Your script does not specify how to handle leads who say they need to ask their spouse.'"
  ]
}

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

IMPORTANT: Generate between 3-15 sections depending on how detailed the script is. A simple script might only have 4-5 sections. A comprehensive SOP might have 12-15. Do NOT pad with thin sections.`;

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
