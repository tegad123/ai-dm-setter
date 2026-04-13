// ---------------------------------------------------------------------------
// Voice Note Library — LLM labeling prompt
// ---------------------------------------------------------------------------

export const VOICE_NOTE_LABELING_PROMPT = `You are an AI assistant that analyzes voice note transcripts from sales professionals (DM setters / appointment setters). Your job is to generate structured metadata so this voice note can be automatically matched to the right conversation moments.

Analyze the transcript below and return a JSON object with these fields:

{
  "summary": "1-2 sentence description of what the speaker says and the intent behind it",
  "use_cases": ["array of 1-4 use case tags"],
  "lead_types": ["array of 1-3 lead type tags"],
  "conversation_stages": ["array of 1-3 conversation stage tags"],
  "emotional_tone": "single tone descriptor",
  "trigger_conditions_natural": "Plain English description of when this voice note should be sent. E.g. 'When a beginner lead expresses fear about risk and seems nervous about losing money'",
  "suggested_label": "Short user-friendly name for this voice note, like 'Risk Management Pep Talk' or 'Success Story - Sarah'",
  "structured_triggers": [
    // Array of 1-3 trigger objects. Pick from these types:
    // { "type": "stage_transition", "from_stage": "any" or LeadStage, "to_stage": LeadStage }
    // { "type": "content_intent", "intent": one of: price_objection, time_concern, skepticism_or_scam_concern, past_failure, complexity_concern, need_to_think, not_interested, ready_to_buy, budget_question, experience_question, timeline_question }
    // { "type": "conversational_move", "suggested_moments": ["moment description"], "required_pipeline_stages": [LeadStages], "cooldown": { "type": "messages", "value": 5 } }
  ]
}

FIELD GUIDELINES:

use_cases — pick from this list (or create a similar custom tag if none fit):
  social_proof, objection_handling, origin_story, testimonial, rapport_building,
  closing_push, follow_up, pre_call_hype, educational, motivational,
  pricing_explanation, risk_reassurance, introduction, time_sensitivity

lead_types — pick from this list:
  beginner, experienced, price_sensitive, high_intent, skeptical,
  returning, warm_inbound, cold_outreach, no_results_yet

conversation_stages — pick from this list:
  opener, qualifying, situation_discovery, objection_handling,
  financial_screening, closing, booking, follow_up, post_booking

emotional_tone — pick ONE from:
  confident, empathetic, urgent, casual, serious, motivational,
  storytelling, educational, direct, reassuring

structured_triggers — create 1-3 trigger objects. Pick the most appropriate type:
  - stage_transition: when the voice note clearly responds to a pipeline event (e.g. no-show, booking)
  - content_intent: when it responds to a specific objection or intent
  - conversational_move: when it's situational/contextual (social proof, motivation, rapport)
  For conversational_move, required_pipeline_stages should be the stages where this voice note
  is relevant. LeadStage values: NEW_LEAD, ENGAGED, QUALIFYING, QUALIFIED, CALL_PROPOSED,
  BOOKED, SHOWED, NO_SHOWED, RESCHEDULED, CLOSED_WON, CLOSED_LOST, UNQUALIFIED, GHOSTED, NURTURE
  Default cooldown: { "type": "messages", "value": 5 }

RULES:
- Be conservative: 2 accurate tags are better than 8 noisy ones
- Output ONLY valid JSON — no markdown, no explanation
- Do NOT invent data that isn't in the transcript
- trigger_conditions_natural should describe the conversation MOMENT, not just restate the content
- suggested_label should be short (2-5 words), memorable, and descriptive

TRANSCRIPT:
---
{{TRANSCRIPT}}
---`;
