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
  SYNTHESIS_PROMPT
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

      return msg.content[0].type === 'text' ? msg.content[0].text : '';
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
  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue to extraction
  }

  // 2. Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }

  // 3. Extract outermost JSON object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      // continue
    }
  }

  // 4. Log and throw
  console.error(
    '[training-analyzer] Failed to parse LLM response as JSON. First 500 chars:',
    text.slice(0, 500)
  );
  throw new Error('Failed to parse analyzer LLM response as JSON');
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
  const parsed = parseJSON(response) as unknown as CategoryResult;
  return {
    score: parsed.score ?? 0,
    metrics: parsed.metrics ?? {},
    gaps: parsed.gaps ?? []
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

  // Single chunk — one LLM call, return directly
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${conversations.length} conversations and classify each lead type.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as unknown as CategoryResult;
    return {
      score: parsed.score ?? 0,
      metrics: parsed.metrics ?? {},
      gaps: parsed.gaps ?? []
    };
  }

  // Multi-chunk: aggregate distributions then synthesize
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each lead type. Return JSON with lead_type_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.lead_type_distribution as Record<string, number>) || {};
    for (const [type, count] of Object.entries(dist)) {
      aggregatedDistribution[type] =
        (aggregatedDistribution[type] || 0) + (count || 0);
    }
  }

  const synthResponse = await callAnalyzerLLM(
    apiKey,
    LEAD_TYPE_ANALYSIS_PROMPT,
    `Here is the aggregated lead type distribution across all ${conversations.length} conversations:\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide gaps/recommendations. Total conversations: ${conversations.length}.`
  );
  const synthParsed = parseJSON(synthResponse) as unknown as CategoryResult;
  return {
    score: synthParsed.score ?? 0,
    metrics: {
      ...(synthParsed.metrics ?? {}),
      lead_type_distribution: aggregatedDistribution
    },
    gaps: synthParsed.gaps ?? []
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

  // Single chunk — one LLM call, return directly
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${conversations.length} conversations.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as unknown as CategoryResult;
    return {
      score: parsed.score ?? 0,
      metrics: parsed.metrics ?? {},
      gaps: parsed.gaps ?? []
    };
  }

  // Multi-chunk: aggregate then synthesize
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each message by pipeline stage. Return JSON with stage_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.stage_distribution as Record<string, number>) || {};
    for (const [stage, count] of Object.entries(dist)) {
      aggregatedDistribution[stage] =
        (aggregatedDistribution[stage] || 0) + (count || 0);
    }
  }

  const synthResponse = await callAnalyzerLLM(
    apiKey,
    STAGE_COVERAGE_ANALYSIS_PROMPT,
    `Aggregated stage distribution across ${conversations.length} conversations (${totalMessages} total messages):\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide gaps/recommendations.`
  );
  const synthParsed = parseJSON(synthResponse) as unknown as CategoryResult;
  return {
    score: synthParsed.score ?? 0,
    metrics: {
      ...(synthParsed.metrics ?? {}),
      stage_distribution: aggregatedDistribution
    },
    gaps: synthParsed.gaps ?? []
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

  // Single chunk — one LLM call, return directly
  if (chunks.length === 1) {
    const transcripts = conversations.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${conversations.length} conversations for objections.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as unknown as CategoryResult;
    return {
      score: parsed.score ?? 0,
      metrics: parsed.metrics ?? {},
      gaps: parsed.gaps ?? []
    };
  }

  // Multi-chunk: aggregate then synthesize
  const aggregatedDistribution: Record<string, number> = {};
  for (const chunk of chunks) {
    const transcripts = chunk.map(formatConversation).join('\n\n');
    const response = await callAnalyzerLLM(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${chunk.length} conversations for objection patterns. Classify each lead message by objection type. Return JSON with objection_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.objection_distribution as Record<string, number>) || {};
    for (const [type, count] of Object.entries(dist)) {
      aggregatedDistribution[type] =
        (aggregatedDistribution[type] || 0) + (count || 0);
    }
  }

  const synthResponse = await callAnalyzerLLM(
    apiKey,
    OBJECTION_COVERAGE_ANALYSIS_PROMPT,
    `Aggregated objection distribution across ${conversations.length} conversations:\n${JSON.stringify(aggregatedDistribution, null, 2)}\n\nScore this distribution and provide gaps/recommendations.`
  );
  const synthParsed = parseJSON(synthResponse) as unknown as CategoryResult;
  return {
    score: synthParsed.score ?? 0,
    metrics: {
      ...(synthParsed.metrics ?? {}),
      objection_distribution: aggregatedDistribution
    },
    gaps: synthParsed.gaps ?? []
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
 */
async function rescoreDistribution(
  apiKey: string,
  prompt: string,
  distributionKey: string,
  distribution: Record<string, number>,
  totalConversations: number
): Promise<CategoryResult> {
  const response = await callAnalyzerLLM(
    apiKey,
    prompt,
    `Here is the ${distributionKey} across ${totalConversations} conversations:\n${JSON.stringify(distribution, null, 2)}\n\nScore this distribution and provide gaps/recommendations. Total conversations: ${totalConversations}.`
  );
  const parsed = parseJSON(response) as unknown as CategoryResult;
  return {
    score: parsed.score ?? 0,
    metrics: { ...(parsed.metrics ?? {}), [distributionKey]: distribution },
    gaps: parsed.gaps ?? []
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
    const response = await callAnalyzerLLM(
      apiKey,
      LEAD_TYPE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each lead type. Return JSON with lead_type_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.lead_type_distribution as Record<string, number>) || {};
    for (const [type, count] of Object.entries(dist)) {
      newDistribution[type] = (newDistribution[type] || 0) + (count || 0);
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  return rescoreDistribution(
    apiKey,
    LEAD_TYPE_ANALYSIS_PROMPT,
    'lead_type_distribution',
    merged,
    totalConversations
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
    const response = await callAnalyzerLLM(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      `Analyze these ${chunk.length} conversations and classify each message by pipeline stage. Return JSON with stage_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.stage_distribution as Record<string, number>) || {};
    for (const [stage, count] of Object.entries(dist)) {
      newDistribution[stage] = (newDistribution[stage] || 0) + (count || 0);
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  const result = await rescoreDistribution(
    apiKey,
    STAGE_COVERAGE_ANALYSIS_PROMPT,
    'stage_distribution',
    merged,
    totalConversations
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
    const response = await callAnalyzerLLM(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      `Scan these ${chunk.length} conversations for objection patterns. Classify each lead message by objection type. Return JSON with objection_distribution counts.\n\n${transcripts}`
    );
    const parsed = parseJSON(response) as Record<string, unknown>;
    const dist =
      ((parsed.metrics as Record<string, unknown>)
        ?.objection_distribution as Record<string, number>) || {};
    for (const [type, count] of Object.entries(dist)) {
      newDistribution[type] = (newDistribution[type] || 0) + (count || 0);
    }
  }

  const merged = mergeDistributions(previousDistribution, newDistribution);

  return rescoreDistribution(
    apiKey,
    OBJECTION_COVERAGE_ANALYSIS_PROMPT,
    'objection_distribution',
    merged,
    totalConversations
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
  accountId: string
): Promise<AnalysisResult> {
  const { apiKey } = await resolveProvider(accountId);
  const conversations = await fetchTrainingData(accountId);
  const totalMessages = conversations.flatMap((c) => c.messages).length;
  const currentIds = conversations.map((c) => c.id);

  // ── Check for previous analysis (incremental support) ───────────
  const previousAnalysis = await prisma.trainingDataAnalysis.findFirst({
    where: { accountId, status: 'complete' },
    orderBy: { runAt: 'desc' },
    select: {
      analyzedConversationIds: true,
      categoryMetrics: true
    }
  });

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
      conversations.length
    );
    stageResult = await rescoreDistribution(
      apiKey,
      STAGE_COVERAGE_ANALYSIS_PROMPT,
      'stage_distribution',
      (previousMetrics.stage_coverage?.stage_distribution as Record<
        string,
        number
      >) || {},
      conversations.length
    );
    objectionResult = await rescoreDistribution(
      apiKey,
      OBJECTION_COVERAGE_ANALYSIS_PROMPT,
      'objection_distribution',
      (previousMetrics.objection_coverage?.objection_distribution as Record<
        string,
        number
      >) || {},
      conversations.length
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
  const synthesis = parseJSON(synthesisResponse) as Record<string, unknown>;

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
