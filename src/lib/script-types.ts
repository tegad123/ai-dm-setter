// ---------------------------------------------------------------------------
// Script Template System — Client-side Type Definitions
// ---------------------------------------------------------------------------
// Mirrors the Prisma models for Script, ScriptStep, ScriptBranch,
// ScriptAction, ScriptForm, ScriptFormField, and LeadScriptPosition.
// ---------------------------------------------------------------------------

export type ScriptActionType =
  | 'send_message'
  | 'ask_question'
  | 'send_voice_note'
  | 'send_link'
  | 'send_video'
  | 'form_reference'
  | 'runtime_judgment'
  | 'wait_for_response'
  | 'wait_duration';

export const SCRIPT_ACTION_TYPE_LABELS: Record<ScriptActionType, string> = {
  send_message: 'Send Message',
  ask_question: 'Ask Question',
  send_voice_note: 'Send Voice Note',
  send_link: 'Send Link',
  send_video: 'Send Video',
  form_reference: 'Form Reference',
  runtime_judgment: 'Runtime Judgment',
  wait_for_response: 'Wait for Response',
  wait_duration: 'Wait Duration'
};

export type ScriptCreatedVia = 'template' | 'blank' | 'upload_parsed';

export type ParserConfidence = 'high' | 'medium' | 'low';

export type ParserActionStatus = 'filled' | 'needs_review' | 'needs_user_input';

export type LeadScriptStatus = 'active' | 'completed' | 'stalled';

// ---------------------------------------------------------------------------
// Nested Types (deepest first)
// ---------------------------------------------------------------------------

export interface ScriptFormField {
  id: string;
  formId: string;
  fieldLabel: string;
  fieldValue: string | null;
  sortOrder: number;
}

export interface ScriptForm {
  id: string;
  scriptId: string;
  name: string;
  description: string | null;
  fields: ScriptFormField[];
}

export interface ScriptAction {
  id: string;
  stepId: string;
  branchId: string | null;
  actionType: ScriptActionType;
  content: string | null;
  voiceNoteId: string | null;
  bindingMode?: 'specific' | 'runtime_match';
  linkUrl: string | null;
  linkLabel: string | null;
  formId: string | null;
  waitDuration: number | null;
  sortOrder: number;
  parserConfidence?: ParserConfidence | null;
  parserStatus?: ParserActionStatus | null;
  userConfirmed?: boolean;
  // Populated relations
  voiceNote?: {
    id: string;
    userLabel: string | null;
    audioFileUrl: string;
    durationSeconds: number;
  } | null;
  form?: ScriptForm | null;
}

export interface ScriptBranch {
  id: string;
  stepId: string;
  branchLabel: string;
  conditionDescription: string | null;
  sortOrder: number;
  parserConfidence?: ParserConfidence | null;
  userConfirmed?: boolean;
  actions: ScriptAction[];
}

export interface ScriptStep {
  id: string;
  scriptId: string;
  stepNumber: number;
  title: string;
  description: string | null;
  objective: string | null;
  stateKey?: string | null;
  requiredDataPoints?: unknown;
  recoveryActionType?: string | null;
  canonicalQuestion?: string | null;
  artifactField?: string | null;
  routingRules?: unknown;
  completionRule?: unknown;
  parserConfidence?: ParserConfidence | null;
  userConfirmed?: boolean;
  branches: ScriptBranch[];
  actions: ScriptAction[]; // direct actions (branchId = null)
}

export interface Script {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdVia: ScriptCreatedVia;
  originalUploadText: string | null;
  lastParsedAt: string | null;
  parseWarnings: string[] | null;
  steps: ScriptStep[];
  forms: ScriptForm[];
  createdAt: string;
  updatedAt: string;
}

export interface ScriptListItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  createdVia: ScriptCreatedVia;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}
