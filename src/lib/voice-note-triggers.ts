// ---------------------------------------------------------------------------
// Voice Note Structured Triggers — type definitions, validation, helpers
// ---------------------------------------------------------------------------

// ─── Content Intent Enum ──────────────────────────────────────────────────

export const CONTENT_INTENTS = [
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

export type ContentIntent = (typeof CONTENT_INTENTS)[number];

export const CONTENT_INTENT_LABELS: Record<ContentIntent, string> = {
  price_objection: 'Price Objection',
  time_concern: 'Time Concern',
  skepticism_or_scam_concern: 'Skepticism / Scam Concern',
  past_failure: 'Past Failure',
  complexity_concern: 'Complexity Concern',
  need_to_think: 'Need to Think',
  not_interested: 'Not Interested',
  ready_to_buy: 'Ready to Buy',
  budget_question: 'Budget Question',
  experience_question: 'Experience Question',
  timeline_question: 'Timeline Question'
};

// ─── Trigger Type Interfaces ──────────────────────────────────────────────

export interface StageTransitionTrigger {
  type: 'stage_transition';
  from_stage: string; // LeadStage value or "any"
  to_stage: string; // LeadStage value
}

export interface ContentIntentTrigger {
  type: 'content_intent';
  intent: ContentIntent;
}

export interface CooldownConfig {
  type: 'messages' | 'conversation' | 'time';
  value: number;
}

export interface ConversationalMoveTrigger {
  type: 'conversational_move';
  suggested_moments: string[];
  required_pipeline_stages: string[]; // LeadStage values
  cooldown: CooldownConfig;
}

export type VoiceNoteTrigger =
  | StageTransitionTrigger
  | ContentIntentTrigger
  | ConversationalMoveTrigger;

// ─── Constants ────────────────────────────────────────────────────────────

export const GLOBAL_VOICE_NOTE_FREQUENCY_CAP = 3; // Min messages between any library VN sends
export const INTENT_CONFIDENCE_THRESHOLD = 0.6; // Min confidence to fire content_intent trigger

// Valid LeadStage values (matches prisma enum — kept as strings to avoid
// importing from Prisma client in frontend code)
const VALID_STAGES = new Set([
  'NEW_LEAD',
  'ENGAGED',
  'QUALIFYING',
  'QUALIFIED',
  'CALL_PROPOSED',
  'BOOKED',
  'SHOWED',
  'NO_SHOWED',
  'RESCHEDULED',
  'CLOSED_WON',
  'CLOSED_LOST',
  'UNQUALIFIED',
  'GHOSTED',
  'NURTURE'
]);

// ─── Validation ───────────────────────────────────────────────────────────

function isValidStageOrAny(value: unknown): value is string {
  return (
    typeof value === 'string' && (value === 'any' || VALID_STAGES.has(value))
  );
}

function isValidStage(value: unknown): value is string {
  return typeof value === 'string' && VALID_STAGES.has(value);
}

function isValidIntent(value: unknown): value is ContentIntent {
  return (
    typeof value === 'string' &&
    CONTENT_INTENTS.includes(value as ContentIntent)
  );
}

function validateSingleTrigger(t: unknown): VoiceNoteTrigger {
  if (!t || typeof t !== 'object') {
    throw new Error('Trigger must be an object');
  }

  const obj = t as Record<string, unknown>;

  switch (obj.type) {
    case 'stage_transition': {
      if (!isValidStageOrAny(obj.from_stage)) {
        throw new Error(`Invalid from_stage: ${obj.from_stage}`);
      }
      if (!isValidStage(obj.to_stage)) {
        throw new Error(`Invalid to_stage: ${obj.to_stage}`);
      }
      return {
        type: 'stage_transition',
        from_stage: obj.from_stage,
        to_stage: obj.to_stage
      };
    }

    case 'content_intent': {
      if (!isValidIntent(obj.intent)) {
        throw new Error(`Invalid intent: ${obj.intent}`);
      }
      return {
        type: 'content_intent',
        intent: obj.intent
      };
    }

    case 'conversational_move': {
      const moments = obj.suggested_moments;
      if (!Array.isArray(moments) || moments.length === 0) {
        throw new Error(
          'conversational_move requires at least one suggested_moment'
        );
      }
      const stages = obj.required_pipeline_stages;
      if (!Array.isArray(stages) || stages.length === 0) {
        throw new Error(
          'conversational_move requires at least one required_pipeline_stage'
        );
      }
      for (const s of stages) {
        if (!isValidStage(s)) {
          throw new Error(`Invalid pipeline stage: ${s}`);
        }
      }
      const cooldown = obj.cooldown as Record<string, unknown> | undefined;
      if (
        !cooldown ||
        typeof cooldown !== 'object' ||
        !['messages', 'conversation', 'time'].includes(
          cooldown.type as string
        ) ||
        typeof cooldown.value !== 'number' ||
        cooldown.value < 0
      ) {
        throw new Error(
          'conversational_move requires a valid cooldown: { type, value }'
        );
      }
      return {
        type: 'conversational_move',
        suggested_moments: moments.map(String),
        required_pipeline_stages: stages as string[],
        cooldown: {
          type: cooldown.type as 'messages' | 'conversation' | 'time',
          value: cooldown.value
        }
      };
    }

    default:
      throw new Error(`Unknown trigger type: ${obj.type}`);
  }
}

/**
 * Validate an array of unknown objects into typed VoiceNoteTrigger[].
 * Throws on any invalid trigger.
 */
export function validateTriggers(triggers: unknown[]): VoiceNoteTrigger[] {
  if (!Array.isArray(triggers)) throw new Error('Triggers must be an array');
  return triggers.map((t, i) => {
    try {
      return validateSingleTrigger(t);
    } catch (err) {
      throw new Error(
        `Trigger[${i}]: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

/**
 * Safely parse triggers from Prisma Json field.
 * Returns empty array on null/invalid instead of throwing.
 */
export function parseTriggerJson(json: unknown): VoiceNoteTrigger[] {
  if (!json) return [];
  if (!Array.isArray(json)) return [];
  try {
    return validateTriggers(json);
  } catch {
    return [];
  }
}

// ─── Description Generation ───────────────────────────────────────────────

function formatStage(stage: string): string {
  if (stage === 'any') return 'any stage';
  return stage
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

function formatCooldown(cooldown: CooldownConfig): string {
  switch (cooldown.type) {
    case 'messages':
      return `every ${cooldown.value} messages`;
    case 'conversation':
      return `at most ${cooldown.value}× per conversation`;
    case 'time':
      if (cooldown.value >= 3600) {
        const hours = Math.round(cooldown.value / 3600);
        return `at most once every ${hours}h`;
      }
      return `at most once every ${cooldown.value}s`;
  }
}

function describeTrigger(trigger: VoiceNoteTrigger): string {
  switch (trigger.type) {
    case 'stage_transition':
      return `lead moves from ${formatStage(trigger.from_stage)} → ${formatStage(trigger.to_stage)}`;

    case 'content_intent':
      return `AI detects ${CONTENT_INTENT_LABELS[trigger.intent] ?? trigger.intent}`;

    case 'conversational_move': {
      const moment = trigger.suggested_moments[0] || 'a relevant moment';
      const stages = trigger.required_pipeline_stages
        .map(formatStage)
        .join(', ');
      const cd = formatCooldown(trigger.cooldown);
      return `AI judges moment for "${moment}" (in ${stages}, ${cd})`;
    }
  }
}

/**
 * Generate a human-readable summary of all triggers.
 * E.g. "Fires when: lead moves from Booked → No Showed, OR AI detects Price Objection"
 */
export function generateTriggerDescription(
  triggers: VoiceNoteTrigger[]
): string {
  if (!triggers.length) return '';
  const parts = triggers.map(describeTrigger);
  if (parts.length === 1) return `Fires when: ${parts[0]}`;
  return `Fires when: ${parts.join('; OR ')}`;
}
