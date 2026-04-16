// ---------------------------------------------------------------------------
// training-data-analyzer.ts (Sprint 4)
// ---------------------------------------------------------------------------
// 6-category training data adequacy analyzer.
// Uses production prompts from training-analyzer-prompts.ts.
//
// Self-contained LLM call logic — mirrors resolveProvider() pattern from
// script-parser.ts. Does NOT import from ai-engine.ts.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import {
  QUANTITY_ANALYSIS_PROMPT,
  VOICE_STYLE_ANALYSIS_PROMPT,
  LEAD_TYPE_ANALYSIS_PROMPT,
  STAGE_COVERAGE_ANALYSIS_PROMPT,
  OUTCOME_COVERAGE_ANALYSIS_PROMPT,
  OBJECTION_COVERAGE_ANALYSIS_PROMPT,
  SYNTHESIS_PROMPT,
  CONVERSATION_METADATA_PROMPT,
  LEAD_TYPE_ENUM,
  STAGE_ENUM,
  OBJECTION_ENUM
} from '@/lib/training-analyzer-prompts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryResult {
  score: number;
  metrics: Record<string, unknown>;
  gaps: Array<{
    severity: 'high' | 'medium' | 'low';
    description: string;
    recommendation: string;
    evidence?: string;
  }>;
}

export interface AnalysisResult {
  overallScore: number;
  categoryScores: {
    quantity: number;
    voice_style: number;
    lead_type_coverage: number;
    stage_coverage: number;
    outcome_coverage: number;
    objection_coverage: number;
  };
  totalConversations: number;
  totalMessages: number;
  recommendations: Array<{
    category: string;
    severity: 'high' | 'medium' | 'low';
    description: string;
    recommendation: string;
    evidence?: string;
  }>;
  summary: string;
  analyzedConversationIds: string[];
  categoryMetrics: Record<string, Record<string, unknown>>;
}

export interface CostEstimate {
  estimatedCostDollars: string;
  estimatedTokens: number;
  totalConversations: number;
  totalMessages: number;
}

// ---------------------------------------------------------------------------
// Provider Resolution (mirrors script-parser.ts)
// ---------------------------------------------------------------------------

const ANALYZER_MODEL = 'claude-haiku-4-5-20251001';

async function resolveProvider(accountId: string): Promise<{
  provider: 'anthropic';
  apiKey: string;
  model: string;
}> {
  // Prefer env key for analyzer — it's a platform cost, not user's key
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    return {
      provider: 'anthropic',
      apiKey: envKey,
      model: ANALYZER_MODEL
    };
  }

  // Fallback to per-account Anthropic credentials
  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: ANALYZER_MODEL
    };
  }

  throw new Error(
    'Anthropic API key required for training data analysis. Add it in Settings → Integrations.'
  );
}

// ---------------------------------------------------------------------------
// LLM Call Helper
// ---------------------------------------------------------------------------

async function callAnalyzerLLM(
  apiKey: string,
  systemPrompt: string,
  userContent: string
): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const msg = await client.messages.create({
        model: ANALYZER_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content:
              userContent +
              '\n\nRespond with valid JSON only. No markdown fences, no explanation.'
          }
        ]
      });

      const response =
        msg.content[0].type === 'text' ? msg.content[0].text : '';
      console.log(
        `[training-analyzer] LLM response length=${response.length}, stop_reason=${msg.stop_reason}, first 500 chars: ${response.slice(0, 500)}`
      );
      // Flag potential truncation — if stop_reason is 'max_tokens', the JSON is cut off
      if (msg.stop_reason === 'max_tokens') {
        console.warn(
          `[training-analyzer] ⚠ RESPONSE TRUNCATED (hit max_tokens). Last 200 chars: ...${response.slice(-200)}`
        );
      }
      return response;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 429 && attempt < maxRetries - 1) {
        const waitMs = (attempt + 1) * 15_000; // 15s, 30s
        console.log(
          `[training-analyzer] Rate limited, waiting ${waitMs / 1000}s before retry ${attempt + 2}/${maxRetries}`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('callAnalyzerLLM: exhausted retries');
}

function parseJSON(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  // 1. Direct parse (works if response is clean JSON)
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue to extraction
  }

  // 2. Strip markdown code fences — Haiku wraps in ```json ... ``` on ~100% of calls.
  //    Handle all variants: ```json, ```, trailing whitespace, missing close fence.
  //    Use greedy match from first { to last } inside fences for robustness.
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Fence content wasn't valid JSON — try extracting {} from inside it
      const innerObj = fenced[1].match(/\{[\s\S]*\}/);
      if (innerObj) {
        try {
          return JSON.parse(innerObj[0]);
        } catch {
          // continue
        }
      }
    }
  }

  // 3. Extract outermost JSON object (handles preamble/postamble text around JSON)
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }

  // 4. Last resort: strip everything before first { and after last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      // continue
    }
  }

  // 4. Log full response and throw
  console.error(
    `[training-analyzer] parseJSON: ALL extraction methods failed.\n` +
      `  Response length: ${text.length}\n` +
      `  Starts with: ${JSON.stringify(text.slice(0, 100))}\n` +
      `  Ends with: ${JSON.stringify(text.slice(-100))}\n` +
      `  FULL RAW RESPONSE:\n---START---\n${text}\n---END---`
  );
  throw new Error('Failed to parse analyzer LLM response as JSON');
}

// ---------------------------------------------------------------------------
// Schema Validation (Layer 3) + Validated LLM Call (Layer 2 + 3)
// ---------------------------------------------------------------------------
// Strict schema validation for LLM-classified categories (3, 4, 6).
// Replaces extractDistribution — with strict prompt contracts, distribution
// is always at response.distribution with all enum keys present.
// ---------------------------------------------------------------------------

interface ValidatedCategoryResponse {
  status: 'success' | 'analysis_failed';
  score: number;
  distribution: Record<string, number>;
  missingCategories: string[];
  analysis: string;
  recommendations: string[];
  rawErrors?: string[];
}

/**
 * Validate that a parsed LLM response matches the strict category schema.
 * Checks: score (int 0-100), distribution (all enum keys), missing_categories,
 * analysis, recommendations.
 */
function validateCategoryResponse(
  parsed: Record<string, unknown>,
  expectedEnumValues: readonly string[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // score: integer 0-100
  if (typeof parsed.score !== 'number') {
    errors.push(`"score" must be a number, got ${typeof parsed.score}`);
  } else if (parsed.score < 0 || parsed.score > 100) {
    errors.push(`"score" must be 0-100, got ${parsed.score}`);
  }

  // distribution: object with ALL enum keys present
  if (
    !parsed.distribution ||
    typeof parsed.distribution !== 'object' ||
    parsed.distribution === null
  ) {
    errors.push(
      `"distribution" must be an object, got ${parsed.distribution === null ? 'null' : typeof parsed.distribution}`
    );
  } else {
    const dist = parsed.distribution as Record<string, unknown>;
    for (const key of expectedEnumValues) {
      if (!(key in dist)) {
        errors.push(`"distribution" missing required key "${key}"`);
      } else if (typeof dist[key] !== 'number') {
        errors.push(
          `"distribution.${key}" must be a number, got ${typeof dist[key]}`
        );
      }
    }
  }

  // missing_categories: array
  if (!Array.isArray(parsed.missing_categories)) {
    errors.push(
      `"missing_categories" must be an array, got ${typeof parsed.missing_categories}`
    );
  }

  // analysis: string
  if (typeof parsed.analysis !== 'string') {
    errors.push(`"analysis" must be a string, got ${typeof parsed.analysis}`);
  }

  // recommendations: array
  if (!Array.isArray(parsed.recommendations)) {
    errors.push(
      `"recommendations" must be an array, got ${typeof parsed.recommendations}`
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Convert a ValidatedCategoryResponse into CategoryResult gaps.
 */
function validatedToGaps(
  result: ValidatedCategoryResponse
): CategoryResult['gaps'] {
  if (result.status === 'analysis_failed') {
    return [
      {
        severity: 'high',
        description: result.analysis,
        recommendation:
          result.recommendations[0] ||
          'Re-run analysis. If this persists, contact support.'
      }
    ];
  }

  const gaps: CategoryResult['gaps'] = [];

  if (result.missingCategories.length > 0) {
    gaps.push({
      severity: result.missingCategories.length > 5 ? 'high' : 'medium',
      description: `Missing or zero coverage: ${result.missingCategories.join(', ')}`,
      recommendation:
        result.recommendations[0] ||
        `Add training data covering: ${result.missingCategories.join(', ')}`
    });
  }

  // Additional recommendations as separate gap entries
  const startIdx = result.missingCategories.length > 0 ? 1 : 0;
  for (let i = startIdx; i < result.recommendations.length; i++) {
    gaps.push({
      severity: 'low',
      description: result.analysis,
      recommendation: result.recommendations[i]
    });
  }

  return gaps;
}

/**
 * Call the analyzer LLM with JSON parse retry (Layer 2) and schema
 * validation with retry (Layer 3). Returns a validated response or
 * analysis_failed status — never throws, never returns score 0 silently.
 *
 * Retry budget: 1 retry (2 total attempts). On parse/validation failure,
 * the retry includes the specific error feedback so Haiku can self-correct.
 */
async function callAnalyzerLLMValidated(
  apiKey: string,
  systemPrompt: string,
  userContent: string,
  expectedEnumValues: readonly string[],
  categoryName: string
): Promise<ValidatedCategoryResponse> {
  const MAX_RETRIES = 1; // 1 retry = 2 total attempts
  let lastErrors: string[] = [];
  let augmentedContent = userContent;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 1. Call LLM
    let rawResponse: string;
    try {
      rawResponse = await callAnalyzerLLM(
        apiKey,
        systemPrompt,
        augmentedContent
      );
    } catch (err) {
      console.error(
        `[training-analyzer] ${categoryName}: LLM call failed on attempt ${attempt + 1}:`,
        err
      );
      lastErrors = [
        `LLM call failed: ${err instanceof Error ? err.message : String(err)}`
      ];
      continue;
    }

    // 2. Parse JSON (Layer 2)
    let parsed: Record<string, unknown>;
    try {
      parsed = parseJSON(rawResponse);
    } catch {
      console.error(
        `[training-analyzer] ${categoryName}: JSON parse FAILED on attempt ${attempt + 1}/${MAX_RETRIES + 1}.\n` +
          `  Response length: ${rawResponse.length}\n` +
          `  FULL RAW RESPONSE:\n---START---\n${rawResponse}\n---END---`
      );
      lastErrors = [
        `JSON parse failure. Response length=${rawResponse.length}. First 500 chars: "${rawResponse.slice(0, 500)}"`
      ];
      if (attempt < MAX_RETRIES) {
        augmentedContent =
          userContent +
          `\n\n[CORRECTION: Your previous response was not valid JSON. Respond with ONLY a valid JSON object matching the required schema. No markdown, no commentary, no code fences. Start with { and end with }.]`;
      }
      continue;
    }

    // 3. Validate schema (Layer 3)
    const validation = validateCategoryResponse(parsed, expectedEnumValues);
    if (validation.valid) {
      if (attempt > 0) {
        console.log(
          `[training-analyzer] ${categoryName}: Validation passed on retry ${attempt}`
        );
      }
      return {
        status: 'success',
        score: Math.round(parsed.score as number),
        distribution: parsed.distribution as Record<string, number>,
        missingCategories: parsed.missing_categories as string[],
        analysis: parsed.analysis as string,
        recommendations: parsed.recommendations as string[]
      };
    }

    // Validation failed
    console.error(
      `[training-analyzer] ${categoryName}: Schema validation FAILED on attempt ${attempt + 1}/${MAX_RETRIES + 1}.\n` +
        `  Errors: ${JSON.stringify(validation.errors)}\n` +
        `  Parsed keys: ${JSON.stringify(Object.keys(parsed))}\n` +
        `  score type=${typeof parsed.score} value=${JSON.stringify(parsed.score)}\n` +
        `  distribution type=${typeof parsed.distribution} keys=${parsed.distribution && typeof parsed.distribution === 'object' ? JSON.stringify(Object.keys(parsed.distribution as object)) : 'N/A'}\n` +
        `  FULL RAW RESPONSE:\n---START---\n${rawResponse}\n---END---`
    );
    lastErrors = validation.errors;

    if (attempt < MAX_RETRIES) {
      augmentedContent =
        userContent +
        `\n\n[CORRECTION: Your previous response had these validation errors:\n${validation.errors.join('\n')}\n\nFix ALL of these issues. Every allowed enum value MUST appear as a key in "distribution", even if count is 0. The "score" MUST be an integer 0-100. "missing_categories" MUST be an array. "analysis" MUST be a string. "recommendations" MUST be an array. Respond with ONLY valid JSON.]`;
    }
  }

  // All attempts exhausted — return analysis_failed, NOT score 0
  console.error(
    `[training-analyzer] ${categoryName}: Analysis failed after ${MAX_RETRIES + 1} attempts. Last errors:`,
    lastErrors
  );

  const zeroDist = Object.fromEntries(expectedEnumValues.map((k) => [k, 0]));

  return {
    status: 'analysis_failed',
    score: 0,
    distribution: zeroDist,
    missingCategories: [...expectedEnumValues],
    analysis: `Analysis failed for ${categoryName}: LLM response did not match required schema after ${MAX_RETRIES + 1} attempts.`,
    recommendations: [
      `Re-run analysis for ${categoryName}. If this persists, contact support.`
    ],
    rawErrors: lastErrors
  };
}

// ---------------------------------------------------------------------------
// Fetch Training Data
// ---------------------------------------------------------------------------

interface ConversationData {
  id: string;
  outcomeLabel: string | null;
  messages: Array<{
    sender: string;
    content: string;
    orderIndex: number;
  }>;
}

async function fetchTrainingData(
  accountId: string
): Promise<ConversationData[]> {
  const conversations = await prisma.trainingConversation.findMany({
    where: { accountId },
    select: {
      id: true,
      outcomeLabel: true,
      messages: {
        select: {
          sender: true,
          text: true,
          orderIndex: true
        },
        orderBy: { orderIndex: 'asc' }
      }
    }
  });

  // Map text → content for internal consistency
  return conversations.map((c) => ({
    id: c.id,
    outcomeLabel: c.outcomeLabel,
    messages: c.messages.map((m) => ({
      sender: m.sender,
      content: m.text || '',
      orderIndex: m.orderIndex
    }))
  }));
}

// ---------------------------------------------------------------------------
// Chunking Helper
// ---------------------------------------------------------------------------

function chunkConversations(
  conversations: ConversationData[],
  totalMessages: number
): ConversationData[][] {
  let batchSize: number;
  if (totalMessages < 5000) {
    return [conversations]; // Single batch
  } else if (totalMessages <= 20000) {
    batchSize = 50;
  } else {
    batchSize = 25;
  }

  const chunks: ConversationData[][] = [];
  for (let i = 0; i < conversations.length; i += batchSize) {
    chunks.push(conversations.slice(i, i + batchSize));
  }
  return chunks;
}

function formatConversation(conv: ConversationData): string {
  const msgs = conv.messages.map((m) => `${m.sender}: ${m.content}`).join('\n');
  return `--- Conversation ${conv.id} ---\n${msgs}\n--- End ---`;
}

// ---------------------------------------------------------------------------
// Category 1: Quantity (Pure DB — no LLM)
// ---------------------------------------------------------------------------

function analyzeQuantity(conversations: ConversationData[]): CategoryResult {
  const totalConversations = conversations.length;
  const allMessages = conversations.flatMap((c) => c.messages);
  const closerMessages = allMessages.filter(
    (m) => m.sender === 'CLOSER' || m.sender === 'AI'
  );
  const leadMessages = allMessages.filter((m) => m.sender === 'LEAD');
  const avgLength =
    totalConversations > 0 ? allMessages.length / totalConversations : 0;

  // Score from conversation count
  let convScore: number;
  if (totalConversations === 0) convScore = 0;
  else if (totalConversations < 10)
    convScore = Math.round((totalConversations / 10) * 25);
  else if (totalConversations < 20)
    convScore = 25 + Math.round(((totalConversations - 10) / 10) * 35);
  else if (totalConversations < 30)
    convScore = 60 + Math.round(((totalConversations - 20) / 10) * 15);
  else if (totalConversations < 50)
    convScore = 75 + Math.round(((totalConversations - 30) / 20) * 15);
  else convScore = 90 + Math.min(10, Math.round((totalConversations - 50) / 5));

  // Cap from closer message count
  let messageCap = 100;
  if (closerMessages.length < 200) messageCap = 40;
  else if (closerMessages.length < 500) messageCap = 70;

  const score = Math.min(convScore, messageCap);

  const gaps: CategoryResult['gaps'] = [];

  if (totalConversations === 0) {
    gaps.push({
      severity: 'high',
      description: 'No training data uploaded.',
      recommendation:
        'Upload at least 20 closed conversations before activating your AI.'
    });
  } else if (totalConversations < 20) {
    gaps.push({
      severity: 'high',
      description: `Only ${totalConversations} conversations uploaded. Below the 20-conversation minimum.`,
      recommendation: `Upload ${20 - totalConversations} more conversations to reach the minimum baseline of 20.`
    });
  } else if (totalConversations < 50) {
    gaps.push({
      severity: 'low',
      description: `${totalConversations} conversations — good but not high-confidence.`,
      recommendation: `Adding ${50 - totalConversations} more conversations would push you to high-confidence territory.`
    });
  }

  if (closerMessages.length < 200 && totalConversations > 0) {
    gaps.push({
      severity: 'high',
      description: `You have ${totalConversations} conversations but only ${closerMessages.length} messages from you.`,
      recommendation:
        'Upload longer conversations or more conversations with substantial back-and-forth from your side. The AI cannot learn your voice from short interactions.'
    });
  }

  return {
    score,
    metrics: {
      total_conversations: totalConversations,
      total_closer_messages: closerMessages.length,
      total_lead_messages: leadMessages.length,
      avg_conversation_length: Math.round(avgLength * 10) / 10
    },
    gaps
  };
}

// ---------------------------------------------------------------------------
// Category 2: Voice/Style (Sample 20 closer messages + LLM)
// ---------------------------------------------------------------------------

async function analyzeVoiceStyle(
  conversations: ConversationData[],
  apiKey: string
): Promise<CategoryResult> {
  const allCloserMessages = conversations
    .flatMap((c) => c.messages)
    .filter((m) => m.sender === 'CLOSER' || m.sender === 'AI');

  if (allCloserMessages.length === 0) {
    return {
      score: 0,
      metrics: {
        closer_message_count: 0,
        average_message_length: 0,
        message_length_variance: 0
      },
      gaps: [
        {
          severity: 'high',
          description: 'No closer messages found in training data.',
          recommendation:
            'Upload conversations that include your messages (not just lead messages).'
        }
      ]
    };
  }

  // Sample 20 random messages
  const shuffled = [...allCloserMessages].sort(() => Math.random() - 0.5);
  const sample = shuffled.slice(0, 20);

  // Compute stats
  const lengths = allCloserMessages.map((m) => m.content.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = Math.sqrt(
    lengths.reduce((sum, l) => sum + (l - avgLength) ** 2, 0) / lengths.length
  );

  const userContent = JSON.stringify({
    closer_message_count: allCloserMessages.length,
    average_message_length: Math.round(avgLength),
    message_length_variance: Math.round(variance),
    sample_messages: sample.map((m) => m.content)
  });

  const response = await callAnalyzerLLM(
    apiKey,
    VOICE_STYLE_ANALYSIS_PROMPT,
    userContent
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJSON(response);
  } catch {
    console.error(
      `[training-analyzer] voice_style: JSON parse FAILED.\n` +
        `  Response length: ${response.length}\n` +
        `  FULL RAW RESPONSE:\n---START---\n${response}\n---END---`
    );
    return {
      score: 0,
      metrics: {
        closer_message_count: allCloserMessages.length,
        parse_error: true
      },
      gaps: [
        {
          severity: 'high' as const,
          description:
            'Voice style analysis failed: LLM returned unparseable response.',
          recommendation: 'Re-run analysis. If this persists, contact support.'
        }
      ]
    };
  }

  return {
    score: typeof parsed.score === 'number' ? parsed.score : 0,
    metrics: (parsed.metrics as Record<string, unknown>) ?? {},
    gaps: Array.isArray(parsed.gaps)
      ? (parsed.gaps as CategoryResult['gaps'])
      : []
  };
}

// ---------------------------------------------------------------------------
// Category 3: Lead Type Coverage (Full scan, chunked + LLM)
// ---------------------------------------------------------------------------

async function analyzeLeadTypeCoverage(
  conversations: ConversationData[],
  totalMessages: number,
  apiKey: string
): Promise<CategoryResult> {
  if (conversations.length === 0) {
    return {
      score: 0,
      metrics: { lead_type_distribution: {} },
      gaps: [
        {
          severity: 'high',
          description: 'No conversations to analyze.',
          recommendation: 'Upload training conversations first.'
        }
      ]
    };
  }

  const chunks = chunkConversations(conversations, totalMessages);

  // Single chunk — one validated LLM call
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const result = await callAnalyzerLLMValidated(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${conversations.length} conversations and classify each lead type.\n\n${transcripts}`,
      LEAD_TYPE_ENUM,
      'lead_type_coverage'
    );
    return {
      score: result.score,
      metrics: { lead_type_distribution: result.distribution },
      gaps: validatedToGaps(result)
    };
  }

  // Multi-chunk: validated call per chunk, aggregate distributions, then rescore
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each lead type.\n\n${transcripts}`,
      LEAD_TYPE_ENUM,
      'lead_type_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [type, count] of Object.entries(chunkResult.distribution)) {
        aggregatedDistribution[type] =
          (aggregatedDistribution[type] || 0) + (count || 0);
      }
    }
  }

  const synthResult = await callAnalyzerLLMValidated(
    apiKey,
    LEAD_TYPE_ANALYSIS_PROMPT,
    `Here is the aggregated lead type distribution across all ${conversations.length} conversations:\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide analysis/recommendations. Total conversations: ${conversations.length}.`,
    LEAD_TYPE_ENUM,
    'lead_type_coverage'
  );
  return {
    score: synthResult.score,
    metrics: { lead_type_distribution: aggregatedDistribution },
    gaps: validatedToGaps(synthResult)
  };
}

// ---------------------------------------------------------------------------
// Category 4: Stage Coverage (Full scan, chunked + LLM)
// ---------------------------------------------------------------------------

async function analyzeStageCoverage(
  conversations: ConversationData[],
  totalMessages: number,
  apiKey: string
): Promise<CategoryResult> {
  if (conversations.length === 0) {
    return {
      score: 0,
      metrics: { stage_distribution: {} },
      gaps: [
        {
          severity: 'high',
          description: 'No conversations to analyze.',
          recommendation: 'Upload training conversations first.'
        }
      ]
    };
  }

  const chunks = chunkConversations(conversations, totalMessages);

  // Single chunk — one validated LLM call
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const result = await callAnalyzerLLMValidated(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${conversations.length} conversations.\n\n${transcripts}`,
      STAGE_ENUM,
      'stage_coverage'
    );
    return {
      score: result.score,
      metrics: {
        stage_distribution: result.distribution,
        total_messages: totalMessages
      },
      gaps: validatedToGaps(result)
    };
  }

  // Multi-chunk: validated call per chunk, aggregate, then rescore
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each message by pipeline stage.\n\n${transcripts}`,
      STAGE_ENUM,
      'stage_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [stage, count] of Object.entries(chunkResult.distribution)) {
        aggregatedDistribution[stage] =
          (aggregatedDistribution[stage] || 0) + (count || 0);
      }
    }
  }

  const synthResult = await callAnalyzerLLMValidated(
    apiKey,
    STAGE_COVERAGE_ANALYSIS_PROMPT,
    `Aggregated stage distribution across ${conversations.length} conversations (${totalMessages} total messages):\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide analysis/recommendations.`,
    STAGE_ENUM,
    'stage_coverage'
  );
  return {
    score: synthResult.score,
    metrics: {
      stage_distribution: aggregatedDistribution,
      total_messages: totalMessages
    },
    gaps: validatedToGaps(synthResult)
  };
}

// ---------------------------------------------------------------------------
// Category 5: Outcome Coverage (Pure DB — no LLM)
// ---------------------------------------------------------------------------

function analyzeOutcomeCoverage(
  conversations: ConversationData[]
): CategoryResult {
  const distribution: Record<string, number> = {};
  for (const conv of conversations) {
    const outcome = conv.outcomeLabel || 'unclear';
    distribution[outcome] = (distribution[outcome] || 0) + 1;
  }

  const total = conversations.length;
  if (total === 0) {
    return {
      score: 0,
      metrics: { outcome_distribution: {} },
      gaps: [
        {
          severity: 'high',
          description: 'No conversations to analyze.',
          recommendation: 'Upload training conversations first.'
        }
      ]
    };
  }

  const wins = distribution['CLOSED_WIN'] || 0;
  const winRate = wins / total;
  const lossTypes = ['GHOSTED', 'OBJECTION_LOST', 'HARD_NO', 'BOOKED_NO_SHOW'];
  const lossCount = lossTypes.reduce(
    (sum, type) => sum + (distribution[type] || 0),
    0
  );
  const lossRate = lossCount / total;

  let score: number;
  const gaps: CategoryResult['gaps'] = [];

  if (winRate >= 0.95 && lossCount === 0) {
    // Win-only dataset — cap at 40
    score = Math.min(40, Math.round(winRate * 40));
    gaps.push({
      severity: 'high',
      description: `All ${wins} of your conversations are closed wins. This is the single biggest problem in your training data.`,
      recommendation: `Upload at least: 5-10 ghosted conversations (leads who stopped responding), 3-5 hard-no conversations (leads who explicitly declined), 2-3 no-show conversations (leads who booked but didn't show). These 'failure' conversations are MORE valuable for AI training than another 10 wins.`,
      evidence: `Win rate: ${Math.round(winRate * 100)}%, Loss/ghost data: 0 conversations`
    });
  } else if (winRate > 0.9) {
    score = Math.round(60 + (lossRate / 0.1) * 20);
    gaps.push({
      severity: 'medium',
      description: `${Math.round(winRate * 100)}% win rate with only ${lossCount} non-win conversations.`,
      recommendation: `Upload ${Math.max(5, 10 - lossCount)} more loss/ghost/no-show conversations to give the AI contrast data.`
    });
  } else if (winRate > 0.7) {
    score = Math.round(60 + (1 - winRate) * 100);
    if (lossRate < 0.15) {
      gaps.push({
        severity: 'low',
        description:
          'Moderate outcome diversity but could use more loss examples.',
        recommendation: `Upload ${Math.max(3, Math.round(total * 0.15) - lossCount)} more non-win conversations.`
      });
    }
  } else {
    // Healthy mix
    score = Math.min(100, 80 + Math.round(lossRate * 50));
  }

  // Check for missing specific outcome types
  for (const type of lossTypes) {
    if (!distribution[type] || distribution[type] === 0) {
      const labels: Record<string, string> = {
        GHOSTED: 'ghosted conversations (leads who stopped responding)',
        OBJECTION_LOST: 'conversations where leads declined after objections',
        HARD_NO: 'hard-no conversations (explicit rejections)',
        BOOKED_NO_SHOW:
          'no-show conversations (leads who booked but missed the call)'
      };
      gaps.push({
        severity: 'medium',
        description: `No ${type.toLowerCase().replace('_', ' ')} conversations in training data.`,
        recommendation: `Upload 3-5 ${labels[type] || type.toLowerCase()} to improve AI handling of this outcome.`
      });
    }
  }

  return {
    score: Math.min(100, Math.max(0, score)),
    metrics: {
      outcome_distribution: distribution,
      win_rate: Math.round(winRate * 100),
      loss_visibility: Math.round(lossRate * 100)
    },
    gaps
  };
}

// ---------------------------------------------------------------------------
// Category 6: Objection Coverage (Full scan, chunked + LLM)
// ---------------------------------------------------------------------------

async function analyzeObjectionCoverage(
  conversations: ConversationData[],
  totalMessages: number,
  apiKey: string
): Promise<CategoryResult> {
  if (conversations.length === 0) {
    return {
      score: 0,
      metrics: { objection_distribution: {} },
      gaps: [
        {
          severity: 'high',
          description: 'No conversations to analyze.',
          recommendation: 'Upload training conversations first.'
        }
      ]
    };
  }

  const chunks = chunkConversations(conversations, totalMessages);

  // Single chunk — one validated LLM call
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const result = await callAnalyzerLLMValidated(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${conversations.length} conversations for objections.\n\n${transcripts}`,
      OBJECTION_ENUM,
      'objection_coverage'
    );
    return {
      score: result.score,
      metrics: { objection_distribution: result.distribution },
      gaps: validatedToGaps(result)
    };
  }

  // Multi-chunk: validated call per chunk, aggregate, then rescore
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${chunk.length} conversations for objection patterns. Classify each lead message by objection type.\n\n${transcripts}`,
      OBJECTION_ENUM,
      'objection_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [type, count] of Object.entries(chunkResult.distribution)) {
        aggregatedDistribution[type] =
          (aggregatedDistribution[type] || 0) + (count || 0);
      }
    }
  }

  const synthResult = await callAnalyzerLLMValidated(
    apiKey,
    OBJECTION_COVERAGE_ANALYSIS_PROMPT,
    `Aggregated objection distribution across ${conversations.length} conversations:\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide analysis/recommendations.`,
    OBJECTION_ENUM,
    'objection_coverage'
  );
  return {
    score: synthResult.score,
    metrics: { objection_distribution: aggregatedDistribution },
    gaps: validatedToGaps(synthResult)
  };
}

// ---------------------------------------------------------------------------
// Incremental helpers: merge new LLM results with previous distributions
// ---------------------------------------------------------------------------

/**
 * Merge two distribution maps by summing counts.
 */
function mergeDistributions(
  prev: Record<string, number>,
  curr: Record<string, number>
): Record<string, number> {
  const merged = { ...prev };
  for (const [key, count] of Object.entries(curr)) {
    merged[key] = (merged[key] || 0) + (count || 0);
  }
  return merged;
}

/**
 * Re-score an existing distribution without re-scanning conversations.
 * Used when no new data was added — just recalculates the score.
 * Uses validated LLM call to ensure schema compliance.
 */
async function rescoreDistribution(
  apiKey: string,
  prompt: string,
  distributionKey: string,
  distribution: Record<string, number>,
  totalConversations: number,
  expectedEnumValues: readonly string[],
  categoryName: string
): Promise<CategoryResult> {
  const result = await callAnalyzerLLMValidated(
    apiKey,
    prompt,
    `Here is the ${distributionKey} across ${totalConversations} conversations:\n${JSON.stringify(distribution, null, 2)}\n\nScore this distribution and provide analysis/recommendations. Total conversations: ${totalConversations}.`,
    expectedEnumValues,
    categoryName
  );
  return {
    score: result.score,
    metrics: { [distributionKey]: distribution }, // Keep original distribution
    gaps: validatedToGaps(result)
  };
}

/**
 * Incremental lead type analysis: scan only new conversations, merge with previous.
 */
async function analyzeLeadTypeCoverageIncremental(
  newConversations: ConversationData[],
  newMessages: number,
  previousDistribution: Record<string, number>,
  totalConversations: number,
  apiKey: string
): Promise<CategoryResult> {
  const chunks = chunkConversations(newConversations, newMessages);
  const newDistribution: Record<string, number> = {};

  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each lead type.\n\n${transcripts}`,
      LEAD_TYPE_ENUM,
      'lead_type_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [type, count] of Object.entries(chunkResult.distribution)) {
        newDistribution[type] = (newDistribution[type] || 0) + (count || 0);
      }
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  return rescoreDistribution(
    apiKey,
    LEAD_TYPE_ANALYSIS_PROMPT,
    'lead_type_distribution',
    merged,
    totalConversations,
    LEAD_TYPE_ENUM,
    'lead_type_coverage'
  );
}

/**
 * Incremental stage coverage analysis.
 */
async function analyzeStageCoverageIncremental(
  newConversations: ConversationData[],
  newMessages: number,
  previousDistribution: Record<string, number>,
  totalConversations: number,
  totalMessages: number,
  apiKey: string
): Promise<CategoryResult> {
  const chunks = chunkConversations(newConversations, newMessages);
  const newDistribution: Record<string, number> = {};

  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each message by pipeline stage.\n\n${transcripts}`,
      STAGE_ENUM,
      'stage_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [stage, count] of Object.entries(chunkResult.distribution)) {
        newDistribution[stage] = (newDistribution[stage] || 0) + (count || 0);
      }
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  const result = await rescoreDistribution(
    apiKey,
    STAGE_COVERAGE_ANALYSIS_PROMPT,
    'stage_distribution',
    merged,
    totalConversations,
    STAGE_ENUM,
    'stage_coverage'
  );
  // Preserve total messages in metrics
  result.metrics.total_messages = totalMessages;
  return result;
}

/**
 * Incremental objection coverage analysis.
 */
async function analyzeObjectionCoverageIncremental(
  newConversations: ConversationData[],
  newMessages: number,
  previousDistribution: Record<string, number>,
  totalConversations: number,
  apiKey: string
): Promise<CategoryResult> {
  const chunks = chunkConversations(newConversations, newMessages);
  const newDistribution: Record<string, number> = {};

  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const chunkResult = await callAnalyzerLLMValidated(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${chunk.length} conversations for objection patterns. Classify each lead message by objection type.\n\n${transcripts}`,
      OBJECTION_ENUM,
      'objection_coverage'
    );
    if (chunkResult.status === 'success') {
      for (const [type, count] of Object.entries(chunkResult.distribution)) {
        newDistribution[type] = (newDistribution[type] || 0) + (count || 0);
      }
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  return rescoreDistribution(
    apiKey,
    OBJECTION_COVERAGE_ANALYSIS_PROMPT,
    'objection_distribution',
    merged,
    totalConversations,
    OBJECTION_ENUM,
    'objection_coverage'
  );
}

// ---------------------------------------------------------------------------
// Cost Estimation
// ---------------------------------------------------------------------------

export async function estimateAnalysisCost(
  accountId: string
): Promise<
  CostEstimate & { newConversations: number; isIncremental: boolean }
> {
  const conversations = await fetchTrainingData(accountId);
  const totalMessages = conversations.flatMap((c) => c.messages).length;
  const totalConversations = conversations.length;

  // Check for previous analysis to determine incremental scope
  const previousAnalysis = await prisma.trainingDataAnalysis.findFirst({
    where: { accountId, status: 'complete' },
    orderBy: { runAt: 'desc' },
    select: { analyzedConversationIds: true }
  });

  const previousIds = new Set<string>(
    (previousAnalysis?.analyzedConversationIds as string[] | null) || []
  );
  const currentIds = conversations.map((c) => c.id);
  const deletedIds = Array.from(previousIds).filter(
    (id) => !currentIds.includes(id)
  );
  const isIncremental = previousIds.size > 0 && deletedIds.length === 0;

  // Determine which conversations the LLM needs to process
  let llmConversations: ConversationData[];
  if (isIncremental) {
    llmConversations = conversations.filter((c) => !previousIds.has(c.id));
  } else {
    llmConversations = conversations;
  }

  const llmMessages = llmConversations.flatMap((c) => c.messages).length;

  // Estimate token count: ~4 tokens per word, ~10 words per message
  const avgTokensPerMessage = 40;
  const llmInputTokens = llmMessages * avgTokensPerMessage;

  if (llmConversations.length === 0 && isIncremental) {
    // No new data — only re-run DB categories + voice style + synthesis
    return {
      estimatedCostDollars: '$0.01',
      estimatedTokens: 2000,
      totalConversations,
      totalMessages,
      newConversations: 0,
      isIncremental: true
    };
  }

  // Count LLM calls:
  // Cat 2: 1 call (20 messages sample from ALL data)
  // Cat 3, 4, 6: chunked scan on NEW conversations only (if incremental)
  const chunks = chunkConversations(llmConversations, llmMessages);
  const numChunks = chunks.length;
  const fullScanCalls = numChunks * 3; // 3 categories
  // + 3 synthesis calls (one per category to re-score merged distributions)
  const synthesisCalls = isIncremental ? 3 : 0;
  const totalCalls = 1 + fullScanCalls + synthesisCalls + 1; // voice/style + scans + merges + final synthesis

  // Haiku pricing: ~$0.25 / 1M input tokens, ~$1.25 / 1M output tokens
  const inputCost = (llmInputTokens * fullScanCalls * 0.25) / 1_000_000;
  const outputCost = (totalCalls * 500 * 1.25) / 1_000_000;
  const totalCost = inputCost + outputCost;

  return {
    estimatedCostDollars: `$${Math.max(0.01, totalCost).toFixed(2)}`,
    estimatedTokens: llmInputTokens * fullScanCalls + totalCalls * 500,
    totalConversations,
    totalMessages,
    newConversations: llmConversations.length,
    isIncremental
  };
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export async function runTrainingAnalysis(
  accountId: string,
  options?: { forceFullRun?: boolean }
): Promise<AnalysisResult> {
  const { apiKey } = await resolveProvider(accountId);
  const conversations = await fetchTrainingData(accountId);
  const totalMessages = conversations.flatMap((c) => c.messages).length;
  const currentIds = conversations.map((c) => c.id);

  // ── Check for previous analysis (incremental support) ───────────
  let previousAnalysis = null;
  if (!options?.forceFullRun) {
    previousAnalysis = await prisma.trainingDataAnalysis.findFirst({
      where: { accountId, status: 'complete' },
      orderBy: { runAt: 'desc' },
      select: {
        analyzedConversationIds: true,
        categoryMetrics: true
      }
    });
  }

  if (options?.forceFullRun) {
    console.log(
      `[training-analyzer] Force full run requested — ignoring previous analysis`
    );
  }

  const previousIds = new Set<string>(
    (previousAnalysis?.analyzedConversationIds as string[] | null) || []
  );
  const previousMetrics =
    (previousAnalysis?.categoryMetrics as Record<
      string,
      Record<string, unknown>
    >) || null;

  // Determine new vs deleted conversations
  const newConversations = conversations.filter((c) => !previousIds.has(c.id));
  const deletedIds = Array.from(previousIds).filter(
    (id) => !currentIds.includes(id)
  );

  // If conversations were deleted, distributions are stale → full re-run
  const canDoIncremental =
    previousIds.size > 0 && deletedIds.length === 0 && previousMetrics !== null;

  const isIncremental = canDoIncremental && newConversations.length >= 0;
  const hasNewData = newConversations.length > 0;

  if (isIncremental && !hasNewData) {
    console.log(
      `[training-analyzer] No new conversations since last analysis — re-running DB categories only`
    );
  } else if (isIncremental) {
    console.log(
      `[training-analyzer] Incremental: ${newConversations.length} new conversations (${previousIds.size} already analyzed)`
    );
  } else if (deletedIds.length > 0) {
    console.log(
      `[training-analyzer] ${deletedIds.length} conversations deleted since last run — full re-analysis`
    );
  }

  // ── Cat 1 & 5: Always re-run on ALL data (pure DB, free) ─────
  const quantityResult = analyzeQuantity(conversations);
  const outcomeResult = analyzeOutcomeCoverage(conversations);

  // ── Cat 2: Voice/Style — always re-run (1 LLM call, samples from all data) ──
  const voiceStyleResult = await analyzeVoiceStyle(conversations, apiKey);

  // ── Cat 3, 4, 6: Full-scan LLM categories — incremental if possible ──
  let leadTypeResult: CategoryResult;
  let stageResult: CategoryResult;
  let objectionResult: CategoryResult;

  if (isIncremental && !hasNewData) {
    // No new data — reuse previous LLM metrics, just re-score distributions
    leadTypeResult = await rescoreDistribution(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      'lead_type_distribution',
      (previousMetrics.lead_type_coverage?.lead_type_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      LEAD_TYPE_ENUM,
      'lead_type_coverage'
    );
    stageResult = await rescoreDistribution(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      'stage_distribution',
      (previousMetrics.stage_coverage?.stage_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      STAGE_ENUM,
      'stage_coverage'
    );
    objectionResult = await rescoreDistribution(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      'objection_distribution',
      (previousMetrics.objection_coverage?.objection_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      OBJECTION_ENUM,
      'objection_coverage'
    );
  } else if (isIncremental && hasNewData) {
    // Incremental: LLM-analyze only new conversations, merge with previous
    const newMessages = newConversations.flatMap((c) => c.messages).length;

    leadTypeResult = await analyzeLeadTypeCoverageIncremental(
      newConversations,
      newMessages,
      (previousMetrics.lead_type_coverage?.lead_type_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      apiKey
    );
    stageResult = await analyzeStageCoverageIncremental(
      newConversations,
      newMessages,
      (previousMetrics.stage_coverage?.stage_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      totalMessages,
      apiKey
    );
    objectionResult = await analyzeObjectionCoverageIncremental(
      newConversations,
      newMessages,
      (previousMetrics.objection_coverage?.objection_distribution as Record<
        string,
        number
      >) || {},
      conversations.length,
      apiKey
    );
  } else {
    // Full analysis (no previous, or deletions detected)
    leadTypeResult = await analyzeLeadTypeCoverage(
      conversations,
      totalMessages,
      apiKey
    );
    stageResult = await analyzeStageCoverage(
      conversations,
      totalMessages,
      apiKey
    );
    objectionResult = await analyzeObjectionCoverage(
      conversations,
      totalMessages,
      apiKey
    );
  }

  // ── Collect all category results ─────────────────────────────
  const categoryScores = {
    quantity: quantityResult.score,
    voice_style: voiceStyleResult.score,
    lead_type_coverage: leadTypeResult.score,
    stage_coverage: stageResult.score,
    outcome_coverage: outcomeResult.score,
    objection_coverage: objectionResult.score
  };

  // Save per-category metrics for future incremental merges
  const categoryMetrics: Record<string, Record<string, unknown>> = {
    quantity: quantityResult.metrics,
    voice_style: voiceStyleResult.metrics,
    lead_type_coverage: leadTypeResult.metrics,
    stage_coverage: stageResult.metrics,
    outcome_coverage: outcomeResult.metrics,
    objection_coverage: objectionResult.metrics
  };

  // ── Synthesis ────────────────────────────────────────────────
  const allGaps = [
    ...quantityResult.gaps.map((g) => ({ ...g, category: 'quantity' })),
    ...voiceStyleResult.gaps.map((g) => ({ ...g, category: 'voice_style' })),
    ...leadTypeResult.gaps.map((g) => ({
      ...g,
      category: 'lead_type_coverage'
    })),
    ...stageResult.gaps.map((g) => ({ ...g, category: 'stage_coverage' })),
    ...outcomeResult.gaps.map((g) => ({
      ...g,
      category: 'outcome_coverage'
    })),
    ...objectionResult.gaps.map((g) => ({
      ...g,
      category: 'objection_coverage'
    }))
  ];

  const synthesisInput = JSON.stringify({
    category_scores: categoryScores,
    all_gaps: allGaps,
    metrics: categoryMetrics
  });

  const synthesisResponse = await callAnalyzerLLM(
    apiKey,
    SYNTHESIS_PROMPT,
    synthesisInput
  );

  let synthesis: Record<string, unknown>;
  try {
    synthesis = parseJSON(synthesisResponse);
  } catch {
    console.error(
      `[training-analyzer] synthesis: JSON parse FAILED.\n` +
        `  Response length: ${synthesisResponse.length}\n` +
        `  FULL RAW RESPONSE:\n---START---\n${synthesisResponse}\n---END---`
    );
    synthesis = {};
  }

  // Calculate weighted overall score
  const weights = {
    quantity: 0.15,
    voice_style: 0.2,
    lead_type_coverage: 0.15,
    stage_coverage: 0.15,
    outcome_coverage: 0.2,
    objection_coverage: 0.15
  };

  const overallScore = Math.round(
    Object.entries(weights).reduce(
      (sum, [key, weight]) =>
        sum +
        (categoryScores[key as keyof typeof categoryScores] || 0) * weight,
      0
    )
  );

  // Use synthesis summary or generate one
  let summary = (synthesis.summary as string) || '';
  if (!summary) {
    if (overallScore < 50) {
      summary = `Your training data is insufficient for a high-confidence AI. Score: ${overallScore}/100.`;
    } else if (overallScore < 80) {
      summary = `Your training data is adequate but has specific gaps. Score: ${overallScore}/100.`;
    } else {
      summary = `Your training data is comprehensive. Score: ${overallScore}/100.`;
    }
  }

  // Take top 5-7 gaps ranked by severity
  const rankedGaps = allGaps
    .sort((a, b) => {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      return (
        (severityOrder[a.severity] ?? 2) - (severityOrder[b.severity] ?? 2)
      );
    })
    .slice(0, 7);

  // ── Write-back metadata to training data (non-fatal) ────────────
  try {
    const conversationsToClassify =
      options?.forceFullRun || !isIncremental
        ? conversations
        : hasNewData
          ? newConversations
          : [];

    if (conversationsToClassify.length > 0) {
      await writeBackConversationMetadata(conversationsToClassify, apiKey);
    }
  } catch (err) {
    console.error(
      '[training-analyzer] Metadata write-back failed (non-fatal):',
      err
    );
  }

  return {
    overallScore,
    categoryScores,
    totalConversations: conversations.length,
    totalMessages,
    recommendations: rankedGaps,
    summary,
    analyzedConversationIds: currentIds,
    categoryMetrics
  };
}

// ---------------------------------------------------------------------------
// Metadata Write-Back: Classify conversations and persist to DB
// ---------------------------------------------------------------------------

interface ConversationMetadata {
  leadType: string;
  dominantStage: string;
  objections: Array<{ messageIndex: number; type: string }>;
}

async function classifyConversationMetadata(
  conversations: ConversationData[],
  apiKey: string
): Promise<Map<string, ConversationMetadata>> {
  const result = new Map<string, ConversationMetadata>();
  const chunks = chunkConversations(
    conversations,
    conversations.flatMap((c) => c.messages).length
  );

  for (const chunk of chunks) {
    const transcripts = chunk
      .map((conv) => {
        const msgs = conv.messages
          .map((m) => `${m.sender}: ${m.content}`)
          .join('\n');
        return `--- Conversation ${conv.id} ---\n${msgs}\n--- End ---`;
      })
      .join('\n\n');

    const response = await callAnalyzerLLM(
      apiKey,
      CONVERSATION_METADATA_PROMPT,
      `Classify these ${chunk.length} conversations:\n\n${transcripts}`
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = parseJSON(response);
    } catch {
      console.error(
        `[training-analyzer] metadata_classification: JSON parse FAILED.\n` +
          `  Chunk size: ${chunk.length} conversations\n` +
          `  Response length: ${response.length}\n` +
          `  FULL RAW RESPONSE:\n---START---\n${response}\n---END---`
      );
      continue; // Skip this chunk, try next
    }
    const convList =
      (parsed.conversations as Array<Record<string, unknown>>) || [];

    for (const item of convList) {
      const id = item.id as string;
      if (!id) continue;

      result.set(id, {
        leadType: (item.lead_type as string) || 'other',
        dominantStage: (item.dominant_stage as string) || 'intro',
        objections: Array.isArray(item.objections)
          ? (
              item.objections as Array<{ message_index: number; type: string }>
            ).map((o) => ({
              messageIndex:
                typeof o.message_index === 'number' ? o.message_index : 0,
              type: o.type || 'other'
            }))
          : []
      });
    }

    // Small delay between chunks to avoid rate limits
    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return result;
}

async function writeBackConversationMetadata(
  conversations: ConversationData[],
  apiKey: string
): Promise<void> {
  console.log(
    `[training-analyzer] Classifying ${conversations.length} conversations for metadata write-back...`
  );

  const metadata = await classifyConversationMetadata(conversations, apiKey);

  let updated = 0;
  for (const [convId, meta] of Array.from(metadata.entries())) {
    // Update conversation-level metadata
    await prisma.trainingConversation.update({
      where: { id: convId },
      data: {
        leadType: meta.leadType,
        dominantStage: meta.dominantStage,
        primaryObjectionType: meta.objections[0]?.type || null,
        analyzedAt: new Date()
      }
    });

    // Find the conversation's lead messages for objection tagging
    const conv = conversations.find((c) => c.id === convId);
    if (conv) {
      // Set stage on all messages based on dominant stage
      await prisma.trainingMessage.updateMany({
        where: { conversationId: convId },
        data: { stage: meta.dominantStage }
      });

      // Set objectionType on specific lead messages
      const leadMessages = conv.messages
        .filter((m) => m.sender === 'LEAD')
        .sort((a, b) => a.orderIndex - b.orderIndex);

      for (const obj of meta.objections) {
        const leadMsg = leadMessages[obj.messageIndex];
        if (leadMsg) {
          await prisma.trainingMessage.updateMany({
            where: {
              conversationId: convId,
              orderIndex: leadMsg.orderIndex,
              sender: 'LEAD'
            },
            data: { objectionType: obj.type }
          });
        }
      }
    }

    updated++;
  }

  console.log(
    `[training-analyzer] Wrote metadata for ${updated} conversations`
  );
}
