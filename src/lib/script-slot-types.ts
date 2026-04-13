// ---------------------------------------------------------------------------
// Script Slot Types (Sprint 3)
// ---------------------------------------------------------------------------
// Type definitions for the five structured slot types that replace free-text
// ambiguities. Each slot type represents a different kind of configurable
// content detected by the script parser.
// ---------------------------------------------------------------------------

// ─── Slot Types ──────────────────────────────────────────────────────────

export const SLOT_TYPES = [
  'voice_note',
  'link',
  'form',
  'runtime_judgment',
  'text_gap'
] as const;

export type SlotType = (typeof SLOT_TYPES)[number];

export const SLOT_TYPE_LABELS: Record<SlotType, string> = {
  voice_note: 'Voice Note',
  link: 'Link / URL',
  form: 'Form',
  runtime_judgment: 'Runtime Judgment',
  text_gap: 'Text Content'
};

// ─── Slot Status ─────────────────────────────────────────────────────────

export const SLOT_STATUSES = [
  'unfilled',
  'filled',
  'bound',
  'partially_filled',
  'complete'
] as const;

export type SlotStatus = (typeof SLOT_STATUSES)[number];

// ─── Form Schema Types ──────────────────────────────────────────────────

export type FormFieldType = 'text' | 'number' | 'list' | 'qa_pair';

export interface FormField {
  field_id: string;
  field_type: FormFieldType;
  label: string;
  placeholder: string;
  required: boolean;
}

export interface FormSchema {
  fields: FormField[];
}

// ─── LLM Parser Output Slot Types ───────────────────────────────────────
// These interfaces match the JSON output from the rewritten parser prompt.

export interface ParsedVoiceNoteSlot {
  slot_type: 'voice_note';
  slot_id: string;
  step_id: string;
  branch_id: string;
  action_id: string;
  detected_name: string;
  context_description: string;
  suggested_trigger: Record<string, unknown> | null;
  suggested_fallback_text: string | null;
}

export interface ParsedLinkSlot {
  slot_type: 'link';
  slot_id: string;
  step_id: string;
  branch_id: string;
  action_id: string;
  detected_name: string;
  link_description: string;
}

export interface ParsedFormSlot {
  slot_type: 'form';
  slot_id: string;
  step_id: string;
  form_schema: FormSchema;
}

export interface ParsedRuntimeJudgmentSlot {
  slot_type: 'runtime_judgment';
  slot_id: string;
  step_id: string;
  instruction: string;
  context: string;
}

export interface ParsedTextGapSlot {
  slot_type: 'text_gap';
  slot_id: string;
  step_id: string;
  branch_id: string;
  action_id: string;
  context_description: string;
  suggested_content: string;
}

export type ParsedSlot =
  | ParsedVoiceNoteSlot
  | ParsedLinkSlot
  | ParsedFormSlot
  | ParsedRuntimeJudgmentSlot
  | ParsedTextGapSlot;

// ─── Client-Side Slot Interface ─────────────────────────────────────────
// Matches the Prisma ScriptSlot model shape returned by API routes.

export interface ScriptSlot {
  id: string;
  accountId: string;
  breakdownId: string;
  slotType: SlotType;
  stepId: string;
  branchId: string | null;
  actionId: string | null;
  detectedName: string | null;
  description: string | null;

  // Voice note specific
  suggestedTrigger: Record<string, unknown> | null;
  boundVoiceNoteId: string | null;

  // Link specific
  linkDescription: string | null;
  url: string | null;

  // Form specific
  formSchema: FormSchema | null;
  formValues: Record<string, unknown> | null;

  // Text gap specific
  suggestedContent: string | null;
  userContent: string | null;

  // Runtime judgment specific
  instruction: string | null;
  context: string | null;

  // Status
  status: SlotStatus;
  orderIndex: number;
  createdAt: string;
  updatedAt: string;

  // Populated relation (optional, included when fetched with voice note)
  boundVoiceNote?: {
    id: string;
    userLabel: string | null;
    audioFileUrl: string;
    durationSeconds: number;
    summary: string | null;
  } | null;
}

// ─── Updated Parser Output ──────────────────────────────────────────────
// The Sprint 3 parser outputs slots instead of ambiguities.

export interface ScriptAnalysisOutputV2 {
  methodology_summary: string;
  sections: Array<{
    section_type: string;
    title: string;
    content: string;
    source_excerpts: string[];
    confidence: 'high' | 'medium' | 'low';
  }>;
  gaps: string[];
  script_steps: import('./script-framework-types').ScriptStep[];
  slots: ParsedSlot[];
}

// ─── Script Binding ─────────────────────────────────────────────────────
// Stored in VoiceNoteLibraryItem.scriptBindings Json field.

export interface ScriptBinding {
  script_id: string; // PersonaBreakdown.id
  step_id: string;
  branch_id: string;
  action_id: string;
  slot_id: string; // ScriptSlot.id
  bound_at: string; // ISO8601
}

// ─── Slot Summary ───────────────────────────────────────────────────────
// Used for the slot status summary at the top of the persona page.

export interface SlotSummary {
  total: number;
  voiceNote: { total: number; bound: number; unfilled: number };
  link: { total: number; filled: number; unfilled: number };
  form: { total: number; complete: number; partial: number; unfilled: number };
  runtimeJudgment: number;
  textGap: { total: number; filled: number; unfilled: number };
}

export function computeSlotSummary(slots: ScriptSlot[]): SlotSummary {
  const vnSlots = slots.filter((s) => s.slotType === 'voice_note');
  const linkSlots = slots.filter((s) => s.slotType === 'link');
  const formSlots = slots.filter((s) => s.slotType === 'form');
  const rjSlots = slots.filter((s) => s.slotType === 'runtime_judgment');
  const tgSlots = slots.filter((s) => s.slotType === 'text_gap');

  return {
    total: slots.length,
    voiceNote: {
      total: vnSlots.length,
      bound: vnSlots.filter((s) => s.status === 'bound').length,
      unfilled: vnSlots.filter((s) => s.status === 'unfilled').length
    },
    link: {
      total: linkSlots.length,
      filled: linkSlots.filter((s) => s.status === 'filled').length,
      unfilled: linkSlots.filter((s) => s.status === 'unfilled').length
    },
    form: {
      total: formSlots.length,
      complete: formSlots.filter((s) => s.status === 'complete').length,
      partial: formSlots.filter((s) => s.status === 'partially_filled').length,
      unfilled: formSlots.filter((s) => s.status === 'unfilled').length
    },
    runtimeJudgment: rjSlots.length,
    textGap: {
      total: tgSlots.length,
      filled: tgSlots.filter((s) => s.status === 'filled').length,
      unfilled: tgSlots.filter((s) => s.status === 'unfilled').length
    }
  };
}
