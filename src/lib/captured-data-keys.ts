// Canonical names for capturedDataPoints that can be emitted by multiple
// extraction paths. Keep this small and semantic: aliases collapse fields that
// represent the same operator intent, not merely values that look similar.

const CAPTURED_DATA_KEY_ALIASES: Record<string, string[]> = {
  workBackground: [
    'work_background',
    'job',
    'occupation',
    'field',
    'theirField',
    'their_field',
    'theirJob',
    'their_job'
  ],
  monthlyIncome: ['monthly_income', 'incomeMonthly', 'income_monthly'],
  workDuration: [
    'work_duration',
    'jobTenure',
    'job_tenure',
    'workTenure',
    'work_tenure',
    'jobDuration',
    'job_duration',
    'workExperienceDuration',
    'work_experience_duration',
    'tenureInYears',
    'tenure_in_years'
  ],
  tradingExperienceDuration: [
    'trading_experience_duration',
    'tradingExperience',
    'trading_experience',
    'marketExperience',
    'market_experience',
    'marketsExperience',
    'markets_experience',
    'experienceDuration',
    'experience_duration'
  ],
  replaceOrSupplement: ['replace_or_supplement'],
  incomeGoal: [
    'income_goal',
    'desiredIncome',
    'desired_income',
    'tradingIncomeGoal',
    'trading_income_goal',
    'incomeTarget',
    'income_target',
    'targetIncome',
    'target_income'
  ],
  deep_why: [
    'deepWhy',
    'deep_emotional_why',
    'deepEmotionalWhy',
    'deep_motivation',
    'deepMotivation',
    'emotional_why',
    'emotionalWhy',
    'personal_why',
    'personalWhy',
    'desiredOutcome',
    'desired_outcome',
    'why'
  ],
  beliefBreakDelivered: ['belief_break_delivered'],
  buyInConfirmed: ['buy_in_confirmed'],
  callInterestConfirmed: ['call_interest_confirmed'],
  callProposalAccepted: ['call_proposal_accepted']
};

function normalizeCapturedDataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const NORMALIZED_TO_CANONICAL_KEY = new Map<string, string>();

for (const [canonical, aliases] of Object.entries(CAPTURED_DATA_KEY_ALIASES)) {
  NORMALIZED_TO_CANONICAL_KEY.set(normalizeCapturedDataKey(canonical), canonical);
  for (const alias of aliases) {
    NORMALIZED_TO_CANONICAL_KEY.set(normalizeCapturedDataKey(alias), canonical);
  }
}

export function canonicalCapturedDataPointKey(key: string): string {
  return NORMALIZED_TO_CANONICAL_KEY.get(normalizeCapturedDataKey(key)) ?? key;
}

export function equivalentCapturedDataPointKeys(key: string): string[] {
  const canonical = canonicalCapturedDataPointKey(key);
  const aliases = CAPTURED_DATA_KEY_ALIASES[canonical] ?? [];
  return Array.from(new Set([key, canonical, ...aliases]));
}

function hasUsableCapturedValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value === true;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return 'value' in record ? hasUsableCapturedValue(record.value) : true;
  }
  return Boolean(value);
}

export function canonicalizeCapturedDataPointRecord<
  T extends Record<string, unknown>
>(points: T): T {
  const canonicalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(points)) {
    const canonicalKey = canonicalCapturedDataPointKey(key);
    const existing = canonicalized[canonicalKey];
    if (
      existing === undefined ||
      (!hasUsableCapturedValue(existing) && hasUsableCapturedValue(value)) ||
      key === canonicalKey
    ) {
      canonicalized[canonicalKey] = value;
    }
  }

  return canonicalized as T;
}
