// ---------------------------------------------------------------------------
// voice-note-context-matcher.ts (Sprint 4)
// ---------------------------------------------------------------------------
// Runtime matching of voice notes from the library to conversation context.
// Uses embedding similarity + LLM judgment to find the best voice note for
// the current conversation moment.
//
// Self-contained — does NOT import from ai-engine.ts or webhook-processor.ts.
// ---------------------------------------------------------------------------

import { getCredentials } from '@/lib/credential-store';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatchInput {
  accountId: string;
  conversationContext: string; // last 5 messages formatted as "sender: content"
  leadStage: string;
  lastLeadMessage: string;
  actionContent: string; // script action content/description
}

export interface MatchResult {
  voiceNoteId: string;
  audioFileUrl: string;
  confidence: number;
  matchReason: string;
}

interface VNCandidate {
  id: string;
  audioFileUrl: string;
  userLabel: string | null;
  summary: string | null;
  useCases: string[];
  conversationStages: string[];
  triggerConditionsNatural: string | null;
  embeddingVector: number[];
  similarity: number;
}

// ---------------------------------------------------------------------------
// Resolve Provider (mirrors script-parser.ts pattern)
// ---------------------------------------------------------------------------

async function resolveProvider(accountId: string): Promise<{
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}> {
  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey as string,
      model: 'gpt-4o'
    };
  }

  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey as string,
      model: 'claude-sonnet-4-20250514'
    };
  }

  const envProvider = (process.env.AI_PROVIDER || 'openai').toLowerCase();
  const provider = envProvider === 'anthropic' ? 'anthropic' : 'openai';
  const apiKey =
    provider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  const model =
    provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';

  if (!apiKey) {
    throw new Error('No AI provider configured for voice note matching.');
  }

  return { provider: provider as 'openai' | 'anthropic', apiKey, model };
}

// ---------------------------------------------------------------------------
// Cosine Similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Generate Context Embedding
// ---------------------------------------------------------------------------

async function generateEmbedding(
  text: string,
  accountId: string
): Promise<number[]> {
  // Always use OpenAI for embeddings (text-embedding-3-small) — same model
  // used during VN processing for consistency
  let openaiKey = process.env.OPENAI_API_KEY || '';
  try {
    const cred = await getCredentials(accountId, 'OPENAI');
    if (cred?.apiKey) openaiKey = cred.apiKey as string;
  } catch {
    /* use env fallback */
  }

  if (!openaiKey) {
    throw new Error('OpenAI API key required for embedding generation.');
  }

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: openaiKey });

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000) // truncate to fit embedding model
  });

  return response.data[0].embedding;
}

// ---------------------------------------------------------------------------
// LLM Judgment Pass
// ---------------------------------------------------------------------------

const JUDGMENT_PROMPT = `You are selecting the best voice note to send in a sales DM conversation.

CONVERSATION CONTEXT (last messages):
{{CONTEXT}}

LEAD STAGE: {{STAGE}}
SCRIPT ACTION: {{ACTION}}

VOICE NOTE CANDIDATES:
{{CANDIDATES}}

For each candidate, evaluate:
1. Does the voice note's purpose match the current conversation moment?
2. Is the lead stage appropriate for this voice note?
3. Would sending this voice note feel natural and timely?

Return ONLY a JSON object:
{
  "best_match_id": "candidate ID or null if none are good fits",
  "confidence": 0.0-1.0,
  "reason": "1 sentence why this is the best match (or why none match)"
}

If no candidate is a genuinely good fit for this moment, return best_match_id: null with confidence: 0.
Be conservative — a poorly-timed voice note is worse than no voice note.`;

async function judgeCandidates(
  input: MatchInput,
  candidates: VNCandidate[]
): Promise<{ id: string | null; confidence: number; reason: string }> {
  const { provider, apiKey } = await resolveProvider(input.accountId);

  const candidateText = candidates
    .map(
      (c, i) =>
        `[${i + 1}] ID: ${c.id}
    Label: ${c.userLabel || 'Untitled'}
    Summary: ${c.summary || 'No summary'}
    Use cases: ${c.useCases.join(', ') || 'none'}
    Stages: ${c.conversationStages.join(', ') || 'any'}
    Trigger conditions: ${c.triggerConditionsNatural || 'none'}
    Embedding similarity: ${c.similarity.toFixed(3)}`
    )
    .join('\n\n');

  const prompt = JUDGMENT_PROMPT.replace(
    '{{CONTEXT}}',
    input.conversationContext
  )
    .replace('{{STAGE}}', input.leadStage)
    .replace('{{ACTION}}', input.actionContent)
    .replace('{{CANDIDATES}}', candidateText);

  let responseText: string;

  if (provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }]
    });
    responseText = msg.content[0].type === 'text' ? msg.content[0].text : '';
  } else {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 256,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });
    responseText = response.choices[0]?.message?.content || '';
  }

  try {
    const parsed = JSON.parse(responseText);
    return {
      id: parsed.best_match_id || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: parsed.reason || ''
    };
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        id: parsed.best_match_id || null,
        confidence:
          typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reason: parsed.reason || ''
      };
    }
    console.error(
      '[voice-note-context-matcher] Failed to parse judgment response'
    );
    return { id: null, confidence: 0, reason: 'Parse failure' };
  }
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export async function findBestVoiceNoteMatch(
  input: MatchInput
): Promise<MatchResult | null> {
  // 1. Build context string for embedding
  const contextString = [
    `Lead stage: ${input.leadStage}`,
    `Script action: ${input.actionContent}`,
    `Recent conversation:\n${input.conversationContext}`
  ].join('\n\n');

  // 2. Generate embedding for conversation context
  const contextEmbedding = await generateEmbedding(
    contextString,
    input.accountId
  );

  // 3. Fetch all active VNs with embeddings for this account
  const voiceNotes = await prisma.voiceNoteLibraryItem.findMany({
    where: {
      accountId: input.accountId,
      active: true,
      embeddingVector: { not: null as unknown as undefined }
    },
    select: {
      id: true,
      audioFileUrl: true,
      userLabel: true,
      summary: true,
      useCases: true,
      conversationStages: true,
      triggerConditionsNatural: true,
      embeddingVector: true
    }
  });

  if (voiceNotes.length === 0) return null;

  // 4. Compute cosine similarity, take top 5 above threshold
  const SIMILARITY_THRESHOLD = 0.3;
  const candidates: VNCandidate[] = voiceNotes
    .map((vn) => ({
      ...vn,
      embeddingVector: vn.embeddingVector as unknown as number[],
      similarity: cosineSimilarity(
        contextEmbedding,
        vn.embeddingVector as unknown as number[]
      )
    }))
    .filter((vn) => vn.similarity >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  if (candidates.length === 0) return null;

  // 5. LLM judgment pass on top 3 candidates
  const topCandidates = candidates.slice(0, 3);
  const judgment = await judgeCandidates(input, topCandidates);

  // 6. Return best match if confidence > 0.7
  if (!judgment.id || judgment.confidence < 0.7) return null;

  const match = topCandidates.find((c) => c.id === judgment.id);
  if (!match) return null;

  return {
    voiceNoteId: match.id,
    audioFileUrl: match.audioFileUrl,
    confidence: judgment.confidence,
    matchReason: judgment.reason
  };
}
