// Persona harness public types. Reuses assertion vocabulary from
// tests/conversation-fixtures so the two suites speak the same language
// without sharing code. If you add new assertion types here, also
// document them in tests/persona-harness/README.md.

export type AssertionType =
  | 'STAGE_IS'
  | 'STAGE_ADVANCED'
  | 'FORBIDDEN_PHRASE_ABSENT'
  | 'PHRASE_PRESENT'
  | 'PHRASE_ABSENT'
  | 'PHRASE_MATCHES'
  | 'CAPTURED_DATA_HAS'
  | 'CAPTURED_DATA_EQUALS'
  | 'LEAD_INTENT_TAG'
  | 'OUTCOME_IS'
  | 'AI_REPLY_NOT_EMPTY'
  | 'AI_REPLY_MAX_CHARS'
  | 'SCHEDULED_REPLY_EXISTS'
  | 'NOTIFICATION_CREATED'
  | 'INBOUND_QUALIFICATION_WRITTEN';

export interface Assertion {
  type: AssertionType;
  value?: unknown;
  // For PHRASE_MATCHES: regex source string
  pattern?: string;
  // For CAPTURED_DATA_*: data point key
  key?: string;
  // Optional descriptive label for output
  label?: string;
}

export type Turn =
  | { role: 'lead'; content: string }
  | { role: 'assertions'; expect: Assertion[] };

export interface Scenario {
  id: string;
  description?: string;
  fastPath?: boolean; // default true
  expected?: 'pass' | 'fail';
  turns: Turn[];
}

// Subset of AIPersona fields the harness will use to seed. Anything not
// listed becomes default/null.
export interface PersonaSeedConfig {
  personaName: string;
  fullName: string;
  companyName?: string;
  tone?: string;
  systemPrompt: string;
  rawScript?: string;
  qualificationFlow?: string;
  objectionHandling?: string;
  voiceNoteDecisionPrompt?: string;
  qualityScoringPrompt?: string;
  promptConfig?: Record<string, unknown>;
  downsellConfig?: Record<string, unknown>;
  minimumCapitalRequired?: number;
  freeValueLink?: string;
  customPhrases?: Record<string, string>;
  styleAnalysis?: Record<string, unknown>;
  financialWaterfall?: Record<string, unknown>;
  knowledgeAssets?: Record<string, unknown>;
}

export interface PersonaScenario {
  slug: string;
  description?: string;
  personaConfig: PersonaSeedConfig;
  scenarios: Scenario[];
}

export type ScenarioResultStatus =
  | 'PASS'
  | 'FAIL'
  | 'EXPECTED_FAIL'
  | 'RATE_LIMIT_EXHAUSTED'
  | 'HARNESS_ERROR';

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  message: string;
}

export interface TurnResult {
  index: number;
  leadContent: string;
  aiReply: string | null;
  assertions: AssertionResult[];
}

export interface ScenarioResult {
  scenarioId: string;
  status: ScenarioResultStatus;
  elapsedMs: number;
  turns: TurnResult[];
  llmCalls: number;
  costUsd: number;
  error?: string;
}

export interface PersonaResult {
  slug: string;
  scenarios: ScenarioResult[];
  totalElapsedMs: number;
  totalLlmCalls: number;
  totalCostUsd: number;
  providerBreakdown: Record<string, { calls: number; usd: number }>;
}
