// ---------------------------------------------------------------------------
// training-example-retriever.ts
// ---------------------------------------------------------------------------
// Retrieves semantically similar few-shot examples from training data.
// Uses OpenAI text-embedding-3-small + cosine similarity with metadata-
// filtered 3-tier retrieval (exact match → relaxed → vector fallback).
//
// Called before every AI response generation. Non-fatal — if retrieval
// fails, the system continues without few-shot examples.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { getCredentials } from '@/lib/credential-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FewShotExample {
  leadMessage: string;
  closerResponses: string[];
  contextBefore: string[]; // 1-2 messages before for context
  outcome: string;
  similarity: number;
}

export interface RetrievalContext {
  accountId: string;
  currentLeadMessage: string;
  leadStage?: string; // From lead.stage (LeadStage enum: NEW_LEAD, QUALIFYING, etc.)
  leadExperience?: string; // From lead.experience (beginner, intermediate, experienced)
  detectedIntent?: string; // From content-intent-classifier (price_objection, etc.)
  conversationHistory?: string[]; // Last 3-5 messages for context
}

// ---------------------------------------------------------------------------
// Cosine similarity (same as voice-note-context-matcher)
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
// Metadata Mapping Helpers
// ---------------------------------------------------------------------------

/**
 * Map live LeadStage enum values to training data stage taxonomy.
 */
function mapLeadStageToTrainingStage(leadStage: string): string | null {
  const mapping: Record<string, string> = {
    NEW_LEAD: 'intro',
    ENGAGED: 'intro',
    QUALIFYING: 'qualification',
    QUALIFIED: 'education',
    CALL_PROPOSED: 'call_proposal',
    BOOKED: 'booking',
    SHOWED: 'post_booking_confirmation',
    NO_SHOWED: 'follow_up',
    RESCHEDULED: 'call_reminders',
    CLOSED_WON: 'post_booking_confirmation',
    CLOSED_LOST: 'objection_handling',
    UNQUALIFIED: 'qualification',
    GHOSTED: 'follow_up',
    NURTURE: 'follow_up'
  };
  return mapping[leadStage] || null;
}

/**
 * Map live lead.experience values to training lead type taxonomy.
 */
function mapExperienceToLeadType(experience?: string): string | null {
  if (!experience) return null;
  const mapping: Record<string, string> = {
    beginner: 'beginner',
    intermediate: 'intermediate',
    experienced: 'experienced_with_results'
  };
  return mapping[experience] || null;
}

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

async function getOpenAIKey(accountId: string): Promise<string | null> {
  // Prefer env key (platform cost)
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;

  // Per-account fallback
  const creds = await getCredentials(accountId, 'OPENAI');
  return (creds?.apiKey as string) || null;
}

async function embedText(text: string, apiKey: string): Promise<number[]> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  // Truncate to ~8000 chars for safety
  const input = text.slice(0, 8000);

  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input
  });

  return res.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Shared select shape for training message queries
// ---------------------------------------------------------------------------

const TRAINING_MESSAGE_SELECT = {
  id: true,
  text: true,
  orderIndex: true,
  conversationId: true,
  embeddingVector: true,
  conversation: {
    select: {
      outcomeLabel: true,
      leadIdentifier: true,
      leadType: true,
      dominantStage: true,
      primaryObjectionType: true,
      createdAt: true
    }
  }
} as const;

type EmbeddedMessage = Prisma.TrainingMessageGetPayload<{
  select: typeof TRAINING_MESSAGE_SELECT;
}>;

// ---------------------------------------------------------------------------
// Score + deduplicate helper
// ---------------------------------------------------------------------------

interface ScoredMatch {
  id: string;
  text: string | null;
  orderIndex: number;
  conversationId: string;
  outcomeLabel: string | null;
  similarity: number;
}

function scoreAndDedup(
  messages: EmbeddedMessage[],
  queryVector: number[],
  seenConversations: Set<string>,
  maxResults: number
): ScoredMatch[] {
  const scored = messages
    .map((msg) => ({
      id: msg.id,
      text: msg.text,
      orderIndex: msg.orderIndex,
      conversationId: msg.conversationId,
      outcomeLabel: msg.conversation.outcomeLabel,
      similarity: cosineSimilarity(queryVector, msg.embeddingVector as number[])
    }))
    .filter((m) => m.similarity > 0.3)
    .sort((a, b) => b.similarity - a.similarity);

  const results: ScoredMatch[] = [];
  for (const match of scored) {
    if (results.length >= maxResults) break;
    if (seenConversations.has(match.conversationId)) continue;
    seenConversations.add(match.conversationId);
    results.push(match);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Retrieve few-shot examples (3-tier metadata-filtered)
// ---------------------------------------------------------------------------

/**
 * Find training conversations where the closer responded to a semantically
 * similar lead message, filtered by metadata context when available.
 *
 * 3-tier retrieval:
 *   Tier 1: Exact metadata match (leadType + stage)
 *   Tier 2: Relaxed (any 1 metadata match)
 *   Tier 3: Vector fallback (pure similarity, current behavior)
 *
 * Non-fatal — returns null on any error.
 */
export async function retrieveFewShotExamples(
  context: RetrievalContext
): Promise<string | null> {
  try {
    const apiKey = await getOpenAIKey(context.accountId);
    if (!apiKey) {
      console.log('[few-shot] No OpenAI key — skipping retrieval');
      return null;
    }

    // Skip very short messages (not enough signal for embedding)
    if (context.currentLeadMessage.trim().length < 5) {
      return null;
    }

    // 1. Embed the current lead message
    const queryVector = await embedText(context.currentLeadMessage, apiKey);

    // 2. Resolve metadata filters
    const mappedStage = context.leadStage
      ? mapLeadStageToTrainingStage(context.leadStage)
      : null;
    const mappedLeadType = mapExperienceToLeadType(context.leadExperience);
    const detectedIntent = context.detectedIntent || null;

    const hasMetadata = !!(mappedStage || mappedLeadType || detectedIntent);

    // Track seen conversations across tiers (dedup)
    const seenConversations = new Set<string>();
    const allMatches: ScoredMatch[] = [];
    let tierUsed = 3; // default fallback

    // Base filter — always applied
    const baseWhere = {
      sender: 'LEAD' as const,
      embeddingVector: { not: Prisma.JsonNull },
      text: { not: '' }
    };

    // ── Tier 1: Exact metadata match ────────────────────────────
    if (hasMetadata && mappedLeadType && mappedStage) {
      const tier1Messages = await prisma.trainingMessage.findMany({
        where: {
          ...baseWhere,
          conversation: {
            accountId: context.accountId,
            outcomeLabel: { notIn: ['HARD_NO', 'UNKNOWN'] },
            leadType: mappedLeadType,
            dominantStage: mappedStage
          }
        },
        select: TRAINING_MESSAGE_SELECT
      });

      if (tier1Messages.length > 0) {
        const tier1Results = scoreAndDedup(
          tier1Messages,
          queryVector,
          seenConversations,
          5
        );
        allMatches.push(...tier1Results);

        if (allMatches.length >= 3) {
          tierUsed = 1;
          console.log(
            `[few-shot] Tier 1 (exact): ${allMatches.length} examples (leadType=${mappedLeadType}, stage=${mappedStage})`
          );
        }
      }
    }

    // ── Tier 2: Relaxed — any 1 metadata match ─────────────────
    if (allMatches.length < 3 && hasMetadata) {
      const orConditions: Prisma.TrainingConversationWhereInput[] = [];
      if (mappedLeadType) orConditions.push({ leadType: mappedLeadType });
      if (mappedStage) orConditions.push({ dominantStage: mappedStage });
      if (detectedIntent)
        orConditions.push({ primaryObjectionType: detectedIntent });

      if (orConditions.length > 0) {
        const tier2Messages = await prisma.trainingMessage.findMany({
          where: {
            ...baseWhere,
            conversation: {
              accountId: context.accountId,
              outcomeLabel: { notIn: ['HARD_NO', 'UNKNOWN'] },
              OR: orConditions
            }
          },
          select: TRAINING_MESSAGE_SELECT
        });

        if (tier2Messages.length > 0) {
          const tier2Results = scoreAndDedup(
            tier2Messages,
            queryVector,
            seenConversations,
            5 - allMatches.length
          );
          allMatches.push(...tier2Results);

          if (allMatches.length >= 3 && tierUsed === 3) {
            tierUsed = 2;
            console.log(
              `[few-shot] Tier 2 (relaxed): ${allMatches.length} total examples (leadType=${mappedLeadType}, stage=${mappedStage}, intent=${detectedIntent})`
            );
          }
        }
      }
    }

    // ── Tier 3: Vector fallback (original behavior) ─────────────
    if (allMatches.length < 3) {
      const tier3Messages = await prisma.trainingMessage.findMany({
        where: {
          ...baseWhere,
          conversation: {
            accountId: context.accountId,
            outcomeLabel: { notIn: ['HARD_NO', 'UNKNOWN'] }
          }
        },
        select: TRAINING_MESSAGE_SELECT
      });

      if (tier3Messages.length > 0) {
        const tier3Results = scoreAndDedup(
          tier3Messages,
          queryVector,
          seenConversations,
          5 - allMatches.length
        );
        allMatches.push(...tier3Results);
      }

      if (tierUsed === 3) {
        console.log(
          `[few-shot] Tier 3 (vector fallback): ${allMatches.length} examples`
        );
      }
    }

    if (allMatches.length === 0) {
      console.log('[few-shot] No matching training examples found');
      return null;
    }

    // 3. For each match, pull surrounding context (2-4 turns)
    const examples: FewShotExample[] = [];

    for (const match of allMatches) {
      const surroundingMessages = await prisma.trainingMessage.findMany({
        where: {
          conversationId: match.conversationId,
          orderIndex: {
            gte: Math.max(0, match.orderIndex - 2),
            lte: match.orderIndex + 3
          }
        },
        orderBy: { orderIndex: 'asc' },
        select: {
          sender: true,
          text: true,
          orderIndex: true
        }
      });

      // Split into context-before, the lead message, and closer responses
      const contextBefore: string[] = [];
      const closerResponses: string[] = [];

      for (const msg of surroundingMessages) {
        if (!msg.text) continue;
        if (msg.orderIndex < match.orderIndex) {
          contextBefore.push(
            `${msg.sender === 'CLOSER' ? 'You' : 'Lead'}: ${msg.text}`
          );
        } else if (
          msg.orderIndex > match.orderIndex &&
          msg.sender === 'CLOSER'
        ) {
          closerResponses.push(msg.text);
        }
      }

      examples.push({
        leadMessage: match.text!,
        closerResponses,
        contextBefore,
        outcome: match.outcomeLabel || 'unknown',
        similarity: match.similarity
      });
    }

    if (examples.length === 0) return null;

    // 4. Format as a prompt block with tier context
    const tierLabels: Record<number, string> = {
      1: 'exact lead type + stage match',
      2: 'partial metadata match',
      3: 'similar message content'
    };

    return formatFewShotBlock(
      examples,
      tierLabels[tierUsed] || 'similar message content'
    );
  } catch (err) {
    console.error('[few-shot] Retrieval failed (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format examples for prompt injection
// ---------------------------------------------------------------------------

function formatFewShotBlock(
  examples: FewShotExample[],
  tierLabel: string
): string {
  const formatted = examples
    .map((ex, i) => {
      const parts: string[] = [];

      // Context before (if any)
      if (ex.contextBefore.length > 0) {
        parts.push(ex.contextBefore.join('\n'));
      }

      // The lead message that matched
      parts.push(`Lead: "${ex.leadMessage}"`);

      // Daniel's actual responses (multiple bubbles)
      if (ex.closerResponses.length > 0) {
        ex.closerResponses.forEach((r) => {
          parts.push(`You: "${r}"`);
        });
      }

      return `Example ${i + 1}:\n${parts.join('\n')}`;
    })
    .join('\n\n');

  return `<few_shot_examples>
These are REAL conversations from your training data, selected because they match the current conversation context (${tierLabel}).
Model the voice, slang, rhythm, and message length — short messages, casual texting, no corporate speak, multiple short bubbles instead of long paragraphs.

DO NOT copy whole sentences verbatim from these examples. Reuse vocabulary and tone, NOT exact phrasing. A lead who sees the same canned line twice (e.g. an opener like "gotchu bro" followed by an identical analogy across two turns) immediately flags you as a bot. Vary your wording every turn, even when the lead's message is similar to a prior one.

${formatted}
</few_shot_examples>`;
}

// ---------------------------------------------------------------------------
// Batch embed training messages (for backfill + new uploads)
// ---------------------------------------------------------------------------

/**
 * Embed all LEAD messages in training data that don't have embeddings yet.
 * Skips messages shorter than 10 chars (not useful for matching).
 *
 * Call this after uploading new training data or as a one-time backfill.
 */
export async function embedTrainingMessagesForAccount(
  accountId: string
): Promise<{ embedded: number; skipped: number }> {
  const apiKey = await getOpenAIKey(accountId);
  if (!apiKey) {
    throw new Error('OpenAI API key required for embedding generation');
  }

  // Find all lead messages without embeddings
  const messages = await prisma.trainingMessage.findMany({
    where: {
      sender: 'LEAD',
      embeddingVector: { equals: Prisma.DbNull },
      conversation: { accountId }
    },
    select: {
      id: true,
      text: true
    }
  });

  let embedded = 0;
  let skipped = 0;

  // Process in batches of 50 to avoid rate limits
  const batchSize = 50;
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const textsToEmbed: { id: string; text: string }[] = [];

    for (const msg of batch) {
      if (!msg.text || msg.text.trim().length < 10) {
        skipped++;
        continue;
      }
      textsToEmbed.push({ id: msg.id, text: msg.text });
    }

    if (textsToEmbed.length === 0) continue;

    // Batch embed via OpenAI
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: textsToEmbed.map((t) => t.text.slice(0, 8000))
    });

    // Save embeddings
    for (let j = 0; j < res.data.length; j++) {
      await prisma.trainingMessage.update({
        where: { id: textsToEmbed[j].id },
        data: { embeddingVector: res.data[j].embedding as unknown as object }
      });
      embedded++;
    }

    // Small delay between batches to avoid rate limits
    if (i + batchSize < messages.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(
    `[few-shot] Embedded ${embedded} lead messages, skipped ${skipped}`
  );
  return { embedded, skipped };
}
