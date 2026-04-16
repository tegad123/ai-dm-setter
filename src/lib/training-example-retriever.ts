// ---------------------------------------------------------------------------
// training-example-retriever.ts
// ---------------------------------------------------------------------------
// Retrieves semantically similar few-shot examples from training data.
// Uses OpenAI text-embedding-3-small + cosine similarity (same pattern
// as voice-note-context-matcher.ts).
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
// Retrieve few-shot examples
// ---------------------------------------------------------------------------

/**
 * Find training conversations where Daniel responded to a semantically
 * similar lead message. Returns formatted few-shot block for injection
 * into the system prompt.
 *
 * Non-fatal — returns null on any error.
 */
export async function retrieveFewShotExamples(
  accountId: string,
  currentLeadMessage: string
): Promise<string | null> {
  try {
    const apiKey = await getOpenAIKey(accountId);
    if (!apiKey) {
      console.log('[few-shot] No OpenAI key — skipping retrieval');
      return null;
    }

    // Skip very short messages (not enough signal for embedding)
    if (currentLeadMessage.trim().length < 5) {
      return null;
    }

    // 1. Embed the current lead message
    const queryVector = await embedText(currentLeadMessage, apiKey);

    // 2. Fetch all embedded lead messages from training data
    //    Filter to good-outcome conversations (not HARD_NO or UNKNOWN)
    const embeddedMessages = await prisma.trainingMessage.findMany({
      where: {
        sender: 'LEAD',
        embeddingVector: { not: Prisma.JsonNull },
        text: { not: '' },
        conversation: {
          accountId,
          outcomeLabel: {
            notIn: ['HARD_NO', 'UNKNOWN']
          }
        }
      },
      select: {
        id: true,
        text: true,
        orderIndex: true,
        conversationId: true,
        embeddingVector: true,
        conversation: {
          select: {
            outcomeLabel: true,
            leadIdentifier: true,
            createdAt: true
          }
        }
      }
    });

    if (embeddedMessages.length === 0) {
      console.log('[few-shot] No embedded training messages found — skipping');
      return null;
    }

    // 3. Compute similarities
    const scored = embeddedMessages
      .map((msg) => ({
        id: msg.id,
        text: msg.text,
        orderIndex: msg.orderIndex,
        conversationId: msg.conversationId,
        outcomeLabel: msg.conversation.outcomeLabel,
        similarity: cosineSimilarity(
          queryVector,
          msg.embeddingVector as number[]
        )
      }))
      .filter((m) => m.similarity > 0.3)
      .sort((a, b) => b.similarity - a.similarity);

    if (scored.length === 0) {
      return null;
    }

    // 4. Take top 5 with deduplication (don't show 5 similar Daniel responses)
    const seen = new Set<string>();
    const topMatches: (typeof scored)[0][] = [];

    for (const match of scored) {
      if (topMatches.length >= 5) break;

      // Dedup by conversation (max 1 example per conversation)
      if (seen.has(match.conversationId)) continue;
      seen.add(match.conversationId);

      topMatches.push(match);
    }

    // 5. For each match, pull surrounding context (2-4 turns)
    const examples: FewShotExample[] = [];

    for (const match of topMatches) {
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

    // 6. Format as a prompt block
    return formatFewShotBlock(examples);
  } catch (err) {
    console.error('[few-shot] Retrieval failed (non-fatal):', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Format examples for prompt injection
// ---------------------------------------------------------------------------

function formatFewShotBlock(examples: FewShotExample[]): string {
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
These are REAL conversations from your training data. Your response MUST match this voice, vocabulary, and message length. Study the patterns: short messages, casual slang, no corporate speak, multiple short bubbles instead of long paragraphs.

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
