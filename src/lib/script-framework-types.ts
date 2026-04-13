// ---------------------------------------------------------------------------
// Script Framework Types
// ---------------------------------------------------------------------------
// Pure type definitions for the scriptSteps JSON column on PersonaBreakdown
// and voice note slot detection output from the LLM parser.
// ---------------------------------------------------------------------------

export interface ScriptStep {
  step_id: string;
  step_number: number;
  title: string;
  branches: ScriptBranch[];
  user_edited: boolean;
  user_approved: boolean;
}

export interface ScriptBranch {
  branch_id: string;
  condition: string; // "default" or condition description (e.g. "Lead is a beginner")
  actions: ScriptAction[];
}

export type ScriptActionType =
  | 'send_message'
  | 'send_voice_note'
  | 'send_link'
  | 'send_video'
  | 'ask_question'
  | 'wait_for_response'
  | 'trigger_followup'
  | 'branch_decision';

export interface ScriptAction {
  action_id: string;
  action_type: ScriptActionType;
  content: string | null;
  voice_note_slot_id: string | null;
  /** Sprint 3: Reference to ScriptSlot.id for any slot type */
  slot_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Voice note detection output from the LLM parser.
 * The `ref_id` is a temporary ID used to link back to script_steps actions.
 * After DB insertion, the real VoiceNoteSlot.id replaces the ref_id in the
 * scriptSteps JSON.
 */
export interface VoiceNoteDetection {
  ref_id: string;
  slot_name: string;
  description: string;
  trigger_condition_natural_language: string;
  trigger_condition_structured: {
    step_id: string;
    branch_id: string;
    action_id: string;
  };
  detection_type: 'explicit' | 'implicit';
  suggested_fallback_text: string | null;
}

/**
 * Full LLM parser output shape (extends existing output with new fields).
 */
export interface ScriptAnalysisOutput {
  methodology_summary: string;
  sections: Array<{
    section_type: string;
    title: string;
    content: string;
    source_excerpts: string[];
    confidence: 'high' | 'medium' | 'low';
  }>;
  ambiguities: Array<{
    question: string;
    suggested_default: string;
  }>;
  gaps: string[];
  script_steps: ScriptStep[];
  voice_note_detections: VoiceNoteDetection[];
}
