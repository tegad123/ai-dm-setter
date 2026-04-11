import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedMessage {
  sender: 'CLOSER' | 'LEAD';
  text: string | null;
  timestamp: Date | null;
  messageType: 'TEXT' | 'VOICE_NOTE' | 'SYSTEM' | 'REACTION' | 'URL_DROP';
  orderIndex: number;
}

export interface ParsedConversation {
  leadIdentifier: string;
  messages: ParsedMessage[];
  messageCount: number;
  closerMessageCount: number;
  leadMessageCount: number;
  voiceNoteCount: number;
  contentHash: string;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface PreflightResult {
  isConversationExport: boolean;
  reason: string;
  estimatedConversations: number;
  closerName: string | null;
}

export interface TokenEstimate {
  inputTokens: number;
  estimatedCostCents: number;
  requiresConfirmation: boolean;
}

export interface ValidationReport {
  valid: boolean;
  conversationCount: number;
  errors: { conversationIndex: number; message: string }[];
  warnings: { conversationIndex: number; message: string }[];
}

// ---------------------------------------------------------------------------
// File hash — upload-level dedup
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of the raw PDF bytes (from base64 input).
 * Used to detect duplicate file uploads per account.
 */
export function computeFileHash(base64Data: string): string {
  const buffer = Buffer.from(base64Data, 'base64');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// Content hash — conversation-level dedup
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of normalized message text within a conversation.
 * Used to deduplicate conversations across different uploads.
 *
 * Normalization: lowercase, trim whitespace, strip corrupted emoji (■□),
 * join by newline in orderIndex order.
 */
export function computeContentHash(messages: ParsedMessage[]): string {
  const sorted = [...messages].sort((a, b) => a.orderIndex - b.orderIndex);
  const normalized = sorted
    .map((m) => {
      if (!m.text) return '';
      return m.text
        .toLowerCase()
        .trim()
        .replace(/[\u25a0\u25a1\u2588\u2591-\u2593\u25aa\u25ab]/g, ''); // strip corrupted emoji blocks
    })
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

// Sonnet pricing: $3/MTok input, $15/MTok output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

/**
 * Rough token estimate from raw text. ~1 token per 4 characters (conservative).
 * Output estimate: ~60% of input (structured JSON is dense).
 * Flags requiresConfirmation if input > 50K tokens.
 */
export function estimateTokens(text: string): TokenEstimate {
  const inputTokens = Math.ceil(text.length / 4);
  const outputTokens = Math.ceil(inputTokens * 0.6);
  const costDollars =
    inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
  const estimatedCostCents = Math.ceil(costDollars * 100);

  return {
    inputTokens,
    estimatedCostCents,
    requiresConfirmation: inputTokens > 50_000
  };
}

// ---------------------------------------------------------------------------
// Conversation boundary detection
// ---------------------------------------------------------------------------

/**
 * Splits extracted PDF text into chunks, one per conversation.
 *
 * Looks for `@username` header patterns commonly found in DM exports.
 * Falls back to splitting on 3+ consecutive blank lines if no header
 * pattern is detected.
 */
export function detectConversationBoundaries(rawText: string): string[] {
  // Pattern 1: @username headers (e.g. "\n@adrianmiranda07\n")
  const atHeaderPattern = /^@[\w.]+\s*$/m;
  const lines = rawText.split('\n');

  if (atHeaderPattern.test(rawText)) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (/^@[\w.]+\s*$/.test(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    // Filter out chunks that are likely headers/metadata (< 5 lines)
    return chunks.filter((c) => c.split('\n').length > 5);
  }

  // Pattern 2: "Display name:" headers with pipe separators
  const displayNamePattern = /^Display name:.*\|\s*\d+\s*messages/m;
  if (displayNamePattern.test(rawText)) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (
        /^Display name:.*\|\s*\d+\s*messages/.test(line) &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    return chunks.filter((c) => c.split('\n').length > 5);
  }

  // Fallback: split on 3+ blank lines
  const fallbackChunks = rawText
    .split(/\n{4,}/)
    .filter((c) => c.trim().length > 100);
  if (fallbackChunks.length > 1) {
    return fallbackChunks;
  }

  // No boundaries detected — return the full text as one chunk
  return [rawText];
}

// ---------------------------------------------------------------------------
// LLM call chunking
// ---------------------------------------------------------------------------

/**
 * Groups conversation text chunks so each batch fits within the LLM's
 * token limit. Never splits a single conversation across batches.
 */
export function chunkForLLM(
  conversationTexts: string[],
  maxTokens: number = 80_000
): string[][] {
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const text of conversationTexts) {
    const tokens = Math.ceil(text.length / 4);

    // If a single conversation exceeds the limit, it gets its own batch
    if (tokens > maxTokens) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([text]);
      continue;
    }

    if (currentTokens + tokens > maxTokens) {
      batches.push(currentBatch);
      currentBatch = [text];
      currentTokens = tokens;
    } else {
      currentBatch.push(text);
      currentTokens += tokens;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

// ---------------------------------------------------------------------------
// Post-parse validation
// ---------------------------------------------------------------------------

/**
 * Validates structured conversations after LLM parsing.
 *
 * Checks:
 * 1. Chronological timestamp ordering (monotonically ascending)
 * 2. Both CLOSER and LEAD messages present
 * 3. Minimum 2 messages per conversation
 * 4. Voice note gap warnings
 * 5. Content hash uniqueness within the batch
 */
export function validateConversations(
  conversations: ParsedConversation[]
): ValidationReport {
  const errors: ValidationReport['errors'] = [];
  const warnings: ValidationReport['warnings'] = [];
  const seenHashes = new Set<string>();

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];

    // Min message count
    if (conv.messages.length < 2) {
      errors.push({
        conversationIndex: i,
        message: `Conversation with ${conv.leadIdentifier} has only ${conv.messages.length} message(s) — minimum is 2`
      });
      continue;
    }

    // Both speakers present
    const senders = new Set(conv.messages.map((m) => m.sender));
    if (!senders.has('CLOSER')) {
      errors.push({
        conversationIndex: i,
        message: `Conversation with ${conv.leadIdentifier} has no CLOSER messages`
      });
    }
    if (!senders.has('LEAD')) {
      errors.push({
        conversationIndex: i,
        message: `Conversation with ${conv.leadIdentifier} has no LEAD messages`
      });
    }

    // Chronological order check (only where timestamps exist)
    const timestampedMessages = conv.messages.filter((m) => m.timestamp);
    for (let j = 1; j < timestampedMessages.length; j++) {
      const prev = timestampedMessages[j - 1].timestamp!;
      const curr = timestampedMessages[j].timestamp!;
      if (curr < prev) {
        warnings.push({
          conversationIndex: i,
          message: `Conversation with ${conv.leadIdentifier} has non-chronological timestamps at message ${timestampedMessages[j].orderIndex}`
        });
        break; // One warning per conversation is enough
      }
    }

    // Voice note gaps
    if (conv.voiceNoteCount > 0) {
      warnings.push({
        conversationIndex: i,
        message: `Conversation with ${conv.leadIdentifier} has ${conv.voiceNoteCount} voice note(s) with no transcript`
      });
    }

    // Duplicate content hash within batch
    if (seenHashes.has(conv.contentHash)) {
      warnings.push({
        conversationIndex: i,
        message: `Conversation with ${conv.leadIdentifier} is a duplicate within this upload`
      });
    }
    seenHashes.add(conv.contentHash);
  }

  return {
    valid: errors.length === 0,
    conversationCount: conversations.length,
    errors,
    warnings
  };
}

// ---------------------------------------------------------------------------
// LLM response → ParsedConversation[] hydration
// ---------------------------------------------------------------------------

/**
 * Converts the raw LLM JSON output into fully computed ParsedConversation[].
 * Adds contentHash, counts, and date bounds.
 */
export function hydrateConversations(
  rawConversations: Array<{
    leadIdentifier: string;
    messages: Array<{
      sender: string;
      text: string | null;
      timestamp: string | null;
      messageType: string;
      orderIndex: number;
    }>;
  }>
): ParsedConversation[] {
  return rawConversations.map((raw) => {
    const messages: ParsedMessage[] = raw.messages.map((m) => ({
      sender: m.sender === 'CLOSER' ? 'CLOSER' : 'LEAD',
      text: m.text || null,
      timestamp: m.timestamp ? new Date(m.timestamp) : null,
      messageType: ([
        'TEXT',
        'VOICE_NOTE',
        'SYSTEM',
        'REACTION',
        'URL_DROP'
      ].includes(m.messageType)
        ? m.messageType
        : 'TEXT') as ParsedMessage['messageType'],
      orderIndex: m.orderIndex
    }));

    // Sort by orderIndex to ensure correct order
    messages.sort((a, b) => a.orderIndex - b.orderIndex);

    const closerMessages = messages.filter((m) => m.sender === 'CLOSER');
    const leadMessages = messages.filter((m) => m.sender === 'LEAD');
    const voiceNotes = messages.filter((m) => m.messageType === 'VOICE_NOTE');

    const timestamps = messages
      .map((m) => m.timestamp)
      .filter((t): t is Date => t !== null);

    return {
      leadIdentifier: raw.leadIdentifier || 'Unknown',
      messages,
      messageCount: messages.length,
      closerMessageCount: closerMessages.length,
      leadMessageCount: leadMessages.length,
      voiceNoteCount: voiceNotes.length,
      contentHash: computeContentHash(messages),
      startedAt: timestamps.length > 0 ? timestamps[0] : null,
      endedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null
    };
  });
}
