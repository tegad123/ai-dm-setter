export type Sender = 'AI' | 'LEAD';

export interface FixtureMessage {
  sender: Sender;
  content: string;
}

export type AssertionType =
  | 'FORBIDDEN_PHRASE_ABSENT'
  | 'REQUIRED_URL_PRESENT'
  | 'URL_ALLOWLIST_CHECK'
  | 'STAGE_CHECK'
  | 'DATA_POINT_CAPTURED'
  | 'STAGE_ADVANCE'
  | 'CONVERSATION_CONTINUES'
  | 'RESPONSE_GENERATED'
  | 'TOPIC_ACKNOWLEDGED'
  | 'BURST_ACKNOWLEDGED'
  | 'CORRECT_ROUTE'
  | 'PREREQUISITE_GATE_ENFORCED'
  | 'ACCEPTANCE_HONORED'
  | 'INTENT_DEDUP_ENFORCED'
  | 'POSITIVE_ACKNOWLEDGED'
  | 'MANYCHAT_STAGE_SKIP_BLOCKED';

export interface FixturePersonaConfig {
  freeValueLink?: string | null;
  downsellLink?: string | null;
  minimumCapitalRequired?: number | null;
  bookingTypeformUrl?: string | null;
}

export interface FixtureAssertion {
  type: AssertionType;
  forbiddenPhrases?: string[];
  forbiddenPatterns?: RegExp[];
  requiredUrlField?: 'freeValueLink' | 'downsellLink';
  allowedUrlFields?: Array<
    'freeValueLink' | 'downsellLink' | 'bookingTypeformUrl'
  >;
  expectedStage?: string;
  forbiddenStages?: string[];
  expectedDataPoint?: { key: string; equals?: unknown; notNull?: boolean };
  topicKeywords?: string[];
  expectedRoute?:
    | 'downsell'
    | 'application'
    | 'booking'
    | 'continue-qualifying';
  forbiddenRoutePhrases?: string[];
  positiveAcknowledgmentRequired?: boolean;
  intentMatchPatterns?: RegExp[];
  acceptanceMustDeliverField?: 'freeValueLink' | 'downsellLink';
  notes?: string;
}

export interface ConversationFixture {
  id: string;
  bug: number;
  slug: string;
  description: string;
  bugFoundDate: string;
  fixReference: string;
  source?: 'INBOUND' | 'MANYCHAT' | 'MANUAL_UPLOAD';
  aiMessageCount?: number;
  conversationHistory: FixtureMessage[];
  lastLeadMessage: string;
  recordedAssistantReply?: string;
  blockedDraftReply?: string;
  capturedDataPoints?: Record<string, unknown>;
  capitalAsked?: boolean;
  systemStage?: string;
  currentScriptStep?: number;
  personaConfig?: FixturePersonaConfig;
  expectedBehavior: string;
  forbiddenBehavior: string;
  assertion: FixtureAssertion;
}

export interface AssertionResult {
  passed: boolean;
  evidence: string;
}
