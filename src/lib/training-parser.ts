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
 * Tries multiple header patterns commonly found in DM exports, then
 * falls back to smart text splitting if no pattern matches.
 */
export function detectConversationBoundaries(rawText: string): string[] {
  const lines = rawText.split('\n');

  // ── Pattern -1: Categorized export with Folder: lines ─────
  // Matches headers like:
  //   [Hard No (Explicit Rejection)] Hdee Mclaren
  //   Folder: hdeemclaren_xxx | 65 messages (30 you / 35 lead)
  const folderLineTest = (line: string): boolean =>
    /^Folder:\s*\S+.*\|\s*\d+\s+messages?/i.test(line.trim());

  const folderLineCount = lines.filter((l) => folderLineTest(l)).length;

  if (folderLineCount >= 2) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      // A conversation starts at the line BEFORE a Folder: line
      // (that line is the [Category] Name header)
      const nextIsFolderLine =
        i + 1 < lines.length && folderLineTest(lines[i + 1]);

      if (nextIsFolderLine && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [lines[i]];
      } else {
        currentChunk.push(lines[i]);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Pattern -0.5: Outcome: line boundaries ───────────────
  // Matches headers like:
  //   JACK GA■TSBY SKVORTSOV
  //   Outcome: Ghosted Conversations | 102 messages (47 you / 55 lead)
  const outcomeLineTest = (line: string): boolean =>
    /^Outcome:\s*.+\|\s*\d+\s+messages?/i.test(line.trim());

  const outcomeLineCount = lines.filter((l) => outcomeLineTest(l)).length;

  if (outcomeLineCount >= 1) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      // A conversation starts at the line BEFORE an Outcome: line
      // (that line is the lead name)
      const nextIsOutcomeLine =
        i + 1 < lines.length && outcomeLineTest(lines[i + 1]);

      if (nextIsOutcomeLine && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [lines[i]];
      } else {
        currentChunk.push(lines[i]);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Header test functions ──────────────────────────────────
  // Pattern 0: ## CONVERSATION headers
  const convoHeaderTest = (line: string): boolean =>
    /^#{1,3}\s*CONVERSATION\s+\d+/i.test(line.trim());

  // Pattern 1: @username headers
  const atHeaderTest = (line: string): boolean =>
    /^@[\w._]+(\s*$|\s+[—\-|:(])/.test(line.trim());

  const convoHeaderCount = lines.filter((l) => convoHeaderTest(l)).length;
  const atHeaderCount = lines.filter((l) => atHeaderTest(l)).length;

  // ── Mixed format: both @username AND ## CONVERSATION headers present ──
  // Split on BOTH header types so neither format gets lumped together
  if (convoHeaderCount >= 2 && atHeaderCount >= 2) {
    const isAnyHeader = (line: string): boolean =>
      convoHeaderTest(line) || atHeaderTest(line);

    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (isAnyHeader(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Pattern 0: ## CONVERSATION headers only ──────────────
  if (convoHeaderCount >= 2) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (convoHeaderTest(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 1) return filtered;
  }

  // ── Pattern 1: @username headers only ─────────────────────
  if (atHeaderCount >= 2) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (atHeaderTest(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    // Keep chunks with at least 3 non-empty lines (a header + 2 messages)
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Pattern 2: "Display name:" headers ────────────────────
  const displayNameTest = (line: string): boolean =>
    /^Display name:.*\|\s*\d+\s*messages/i.test(line.trim());

  if (lines.some((l) => displayNameTest(l))) {
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (displayNameTest(line) && currentChunk.length > 0) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [line];
      } else {
        currentChunk.push(line);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Pattern 3: "X messages" count lines ───────────────────
  // Some exports have standalone "N messages" lines between conversations
  const msgCountTest = (line: string): boolean =>
    /^\d+\s+messages?\s*$/i.test(line.trim());

  if (lines.filter((l) => msgCountTest(l)).length >= 2) {
    // Split one line BEFORE each "N messages" line (the username is above it)
    const chunks: string[] = [];
    let currentChunk: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      // Look ahead: if the NEXT line (or line after next) is a "N messages" line,
      // and current line looks like a name/username, start new chunk
      const nextIsCount = i + 1 < lines.length && msgCountTest(lines[i + 1]);
      const nextNextIsCount =
        i + 2 < lines.length && msgCountTest(lines[i + 2]);

      const looksLikeHeader =
        /^@[\w._]+/.test(lines[i].trim()) ||
        (lines[i].trim().length > 0 &&
          lines[i].trim().length < 40 &&
          (nextIsCount || nextNextIsCount));

      if (
        looksLikeHeader &&
        (nextIsCount || nextNextIsCount) &&
        currentChunk.length > 0
      ) {
        chunks.push(currentChunk.join('\n'));
        currentChunk = [lines[i]];
      } else {
        currentChunk.push(lines[i]);
      }
    }
    if (currentChunk.length > 0) {
      chunks.push(currentChunk.join('\n'));
    }
    const filtered = chunks.filter(
      (c) => c.split('\n').filter((l) => l.trim()).length >= 3
    );
    if (filtered.length >= 2) return filtered;
  }

  // ── Fallback: split on 2+ blank lines ────────────────────
  const blankLineChunks = rawText
    .split(/\n{3,}/)
    .filter((c) => c.trim().length > 100);
  if (blankLineChunks.length >= 2) {
    return blankLineChunks;
  }

  // ── Last resort: smart split into manageable chunks ───────
  return smartSplitText(rawText);
}

/**
 * Splits large text into manageable chunks at paragraph boundaries.
 * Used when conversation boundary detection fails, so the LLM gets
 * pieces small enough to reliably extract all conversations.
 *
 * Each chunk targets ~30K tokens (~120K chars) with ~2K char overlap
 * so conversations at boundaries aren't lost.
 */
export function smartSplitText(
  rawText: string,
  maxChars: number = 120_000
): string[] {
  if (rawText.length <= maxChars) {
    return [rawText];
  }

  const chunks: string[] = [];
  // Split at paragraph boundaries (double newlines)
  const paragraphs = rawText.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current);
      // Overlap: carry the last ~2000 chars into the next chunk so
      // conversations that straddle a boundary are seen by both calls
      const overlap = current.slice(-2000);
      current = overlap + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [rawText];
}

// ---------------------------------------------------------------------------
// Rule-based conversation parser (no LLM needed)
// ---------------------------------------------------------------------------

const TIMESTAMP_RE =
  /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4},?\s+\d{1,2}:\d{2}\s*(am|pm)/i;

/**
 * Parses raw conversation text into structured conversations without any LLM.
 * Uses timestamp lines as anchors: sender is one line above, text is below.
 */
export function parseConversationsFromText(
  rawText: string
): ParsedConversation[] {
  const chunks = detectConversationBoundaries(rawText);
  const conversations: ParsedConversation[] = [];
  const dropped: string[] = [];

  for (const chunk of chunks) {
    const conv = parseSingleConversation(chunk);
    if (conv && conv.messages.length >= 2) {
      conversations.push(conv);
    } else {
      // Log what was dropped for debugging
      const firstLine =
        chunk
          .split('\n')
          .find((l) => l.trim())
          ?.trim() || '(empty)';
      const msgCount = conv?.messages.length ?? 0;
      dropped.push(`"${firstLine.slice(0, 60)}" (${msgCount} msgs)`);
    }
  }

  console.log(
    `[training-parser] Boundary detection found ${chunks.length} chunks → ${conversations.length} valid conversations, ${dropped.length} dropped`
  );
  if (dropped.length > 0) {
    console.log(`[training-parser] Dropped chunks: ${dropped.join(' | ')}`);
  }

  return conversations;
}

// ---------------------------------------------------------------------------
// Sender line detection for timestamp-based formats
// ---------------------------------------------------------------------------

/**
 * Detects if a line is a sender/name line (e.g. "DaeTradez (You):" or "Thomas:").
 * Returns { isCloser: true/false } or null if not a sender line.
 */
function detectSenderLine(line: string): { isCloser: boolean } | null {
  const trimmed = line.trim();

  // Must end with ':'
  if (!trimmed.endsWith(':')) return null;

  // Must be reasonably short
  if (trimmed.length > 60) return null;

  // Must NOT be a timestamp
  if (TIMESTAMP_RE.test(trimmed)) return null;

  // Has (You) marker → definitely closer
  if (/\(You\)\s*:?\s*$/i.test(trimmed)) return { isCloser: true };

  // Extract name before the colon
  const beforeColon = trimmed.slice(0, -1).trim();
  if (beforeColon.length < 1 || beforeColon.length > 55) return null;

  // Skip URLs
  if (/https?:\/\//i.test(beforeColon)) return null;

  // Skip lines that look like sentences (start with common English words)
  if (
    /^(I |I'm|You |He |She |We |They |It |The |A |An |My |Your |How |What |Why |When |Where |Which |Do |Did |Will |Would |Can |Could |Should |Is |Are |Was |Were |Has |Have |Had |Not |No |Yes |Yeah |Yep |Nah |Sure |Ok |Bet |Nice |Damn |Just |But |And |So |If |Let |Look )/i.test(
      beforeColon
    )
  )
    return null;

  // Skip lines ending with sentence-final punctuation before the colon
  if (/[.!?]$/.test(beforeColon)) return null;

  return { isCloser: false };
}

// ---------------------------------------------------------------------------
// Classify message type
// ---------------------------------------------------------------------------

function classifyMessageType(msgText: string): ParsedMessage['messageType'] {
  if (/voice\s*(message|note)|click for audio|audio call/i.test(msgText))
    return 'VOICE_NOTE';
  if (/liked a message|reacted.*to your message/i.test(msgText))
    return 'REACTION';
  if (
    /missed (video|voice) call|call started|shared a (post|reel|story)/i.test(
      msgText
    )
  )
    return 'SYSTEM';
  if (/^https?:\/\/\S+$/i.test(msgText.trim())) return 'URL_DROP';
  return 'TEXT';
}

// ---------------------------------------------------------------------------
// Parse timestamp string
// ---------------------------------------------------------------------------

function parseTimestamp(tsLine: string): Date | null {
  try {
    const tsClean = tsLine.trim().replace(/,/g, '');
    const d = new Date(tsClean);
    if (!isNaN(d.getTime())) return d;
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Format B timestamp parser: sender → text → timestamp
// ---------------------------------------------------------------------------

/**
 * Parses conversations where the format is:
 *   SenderName (You):
 *   Message text (one or more lines)
 *   Jan 19, 2026 10:10 am
 *
 * The sender persists until a new sender line appears.
 * This is the format used by Instagram DM exports.
 */
function parseTimestampFormatB(
  lines: string[],
  leadIdentifier: string
): ParsedConversation | null {
  const messages: ParsedMessage[] = [];
  let currentSender: 'CLOSER' | 'LEAD' | null = null;
  let currentTextLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Skip header lines
    if (
      /^\[.+?\]\s+\S/.test(trimmed) &&
      !/^\[(YOU|LEAD|CLOSER|SETTER)\]/i.test(trimmed)
    )
      continue;
    if (/^Folder:/i.test(trimmed)) continue;
    if (/^Outcome:\s*.+\|\s*\d+\s+messages?/i.test(trimmed)) continue;

    // Check if it's a sender line
    const sender = detectSenderLine(trimmed);
    if (sender) {
      // New sender — discard any accumulated text without a timestamp
      currentSender = sender.isCloser ? 'CLOSER' : 'LEAD';
      currentTextLines = [];
      continue;
    }

    // Check if it's a timestamp line
    if (TIMESTAMP_RE.test(trimmed)) {
      if (currentSender && currentTextLines.length > 0) {
        const msgText = currentTextLines.join('\n').trim();
        if (msgText) {
          messages.push({
            sender: currentSender,
            text: msgText,
            timestamp: parseTimestamp(trimmed),
            messageType: classifyMessageType(msgText),
            orderIndex: messages.length
          });
        }
      }
      currentTextLines = [];
      continue;
    }

    // Regular text line — accumulate
    currentTextLines.push(trimmed);
  }

  if (messages.length < 2) return null;

  // If messages are in reverse chronological order, reverse them
  const validTs = messages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp!.getTime());
  if (validTs.length >= 2 && validTs[0] > validTs[validTs.length - 1]) {
    messages.reverse();
    messages.forEach((m, i) => (m.orderIndex = i));
  }

  const closerMsgs = messages.filter((m) => m.sender === 'CLOSER');
  const leadMsgs = messages.filter((m) => m.sender === 'LEAD');
  const voiceNotes = messages.filter((m) => m.messageType === 'VOICE_NOTE');
  const timestamps = messages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp!);

  return {
    leadIdentifier,
    messages,
    messageCount: messages.length,
    closerMessageCount: closerMsgs.length,
    leadMessageCount: leadMsgs.length,
    voiceNoteCount: voiceNotes.length,
    contentHash: computeContentHash(messages),
    startedAt: timestamps.length > 0 ? timestamps[0] : null,
    endedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null
  };
}

// ---------------------------------------------------------------------------
// Single conversation parser
// ---------------------------------------------------------------------------

function parseSingleConversation(text: string): ParsedConversation | null {
  const lines = text.split('\n');

  // Extract lead identifier from header
  let leadIdentifier = 'Unknown';
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const atMatch = lines[i]?.trim().match(/^@([\w._]+)/);
    if (atMatch) {
      leadIdentifier = '@' + atMatch[1];
      break;
    }
    // "Display name: Foo | N messages" headers
    const dnMatch = lines[i]?.trim().match(/^Display name:\s*(.+?)\s*\|/i);
    if (dnMatch) {
      leadIdentifier = dnMatch[1].trim();
      break;
    }
    // "## CONVERSATION N: Name" headers
    const convoMatch = lines[i]
      ?.trim()
      .match(/^#{1,3}\s*CONVERSATION\s+\d+[:\s]*(.+)?$/i);
    if (convoMatch && convoMatch[1]) {
      leadIdentifier = convoMatch[1].trim().replace(/\s*\(.*\)$/, '');
      break;
    }
    // [Category] Name headers (e.g. "[Hard No (Explicit Rejection)] Hdee Mclaren")
    const categoryMatch = lines[i]?.trim().match(/^\[.+?\]\s+(.+)$/);
    if (
      categoryMatch &&
      !/^\[(YOU|LEAD|CLOSER|SETTER)\]/i.test(lines[i]?.trim() || '')
    ) {
      leadIdentifier = categoryMatch[1].trim();
      break;
    }
    // "Name\nOutcome: Category | N messages" — name is the line BEFORE Outcome:
    if (
      /^Outcome:\s*.+\|\s*\d+\s+messages?/i.test(lines[i]?.trim() || '') &&
      i > 0
    ) {
      const nameLine = lines[i - 1]?.trim();
      if (nameLine && nameLine.length < 60 && !TIMESTAMP_RE.test(nameLine)) {
        leadIdentifier = nameLine;
      }
      break;
    }
  }

  // ── Check for [YOU]/[LEAD] labeled format (no timestamps) ──
  const labeledLineRe = /^\[(YOU|LEAD|CLOSER|SETTER)\]:\s*(.+)/i;
  const labeledLines = lines.filter((l) => labeledLineRe.test(l.trim()));

  if (labeledLines.length >= 2) {
    return parseLabeledConversation(lines, leadIdentifier);
  }

  // Find all timestamp line indices
  const tsIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (TIMESTAMP_RE.test(lines[i].trim())) {
      tsIndices.push(i);
    }
  }

  if (tsIndices.length < 2) return null;

  // ── Detect format ────────────────────────────────────────────
  // Format A: sender line is immediately before timestamp
  // Format B: sender → text → timestamp (Instagram DM export style)
  //
  // Check if the line before the first timestamp is a sender line.
  // If NOT, it's Format B (the text is between sender and timestamp).
  const firstTsIdx = tsIndices[0];
  const lineBeforeTs = firstTsIdx > 0 ? lines[firstTsIdx - 1].trim() : '';
  const senderBeforeTs = detectSenderLine(lineBeforeTs);

  if (!senderBeforeTs) {
    // Likely Format B — try it first
    const result = parseTimestampFormatB(lines, leadIdentifier);
    if (result && result.messages.length >= 2) return result;
  }

  // ── Format A fallback (sender → timestamp → text) ────────────
  const messages: ParsedMessage[] = [];

  for (let t = 0; t < tsIndices.length; t++) {
    const tsIdx = tsIndices[t];
    const senderIdx = tsIdx - 1;

    if (senderIdx < 0) continue;
    const senderLine = lines[senderIdx].trim();
    if (!senderLine) continue;

    const isCloser = /\(You\)/i.test(senderLine);

    // Text: from line after timestamp up to next sender line (or end)
    const textEndIdx =
      t + 1 < tsIndices.length ? tsIndices[t + 1] - 1 : lines.length;

    const textLines: string[] = [];
    for (let j = tsIdx + 1; j < textEndIdx; j++) {
      textLines.push(lines[j]);
    }
    const msgText = textLines.join('\n').trim();

    messages.push({
      sender: isCloser ? 'CLOSER' : 'LEAD',
      text: msgText || null,
      timestamp: parseTimestamp(lines[tsIdx]),
      messageType: classifyMessageType(msgText),
      orderIndex: messages.length
    });
  }

  if (messages.length < 2) return null;

  // If messages are in reverse chronological order, reverse them
  const validTs = messages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp!.getTime());
  if (validTs.length >= 2 && validTs[0] > validTs[validTs.length - 1]) {
    messages.reverse();
    messages.forEach((m, i) => (m.orderIndex = i));
  }

  const closerMsgs = messages.filter((m) => m.sender === 'CLOSER');
  const leadMsgs = messages.filter((m) => m.sender === 'LEAD');
  const voiceNotes = messages.filter((m) => m.messageType === 'VOICE_NOTE');
  const timestamps = messages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp!);

  return {
    leadIdentifier,
    messages,
    messageCount: messages.length,
    closerMessageCount: closerMsgs.length,
    leadMessageCount: leadMsgs.length,
    voiceNoteCount: voiceNotes.length,
    contentHash: computeContentHash(messages),
    startedAt: timestamps.length > 0 ? timestamps[0] : null,
    endedAt: timestamps.length > 0 ? timestamps[timestamps.length - 1] : null
  };
}

// ---------------------------------------------------------------------------
// Labeled conversation parser ([YOU]/[LEAD] format)
// ---------------------------------------------------------------------------

/**
 * Parses conversations in [YOU]/[LEAD] labeled format (no timestamps).
 * Each line is: [YOU]: message text  or  [LEAD]: message text
 * Also handles [CLOSER], [SETTER] as closer labels.
 */
function parseLabeledConversation(
  lines: string[],
  leadIdentifier: string
): ParsedConversation | null {
  const labeledLineRe = /^\[(YOU|LEAD|CLOSER|SETTER)\]:\s*(.*)/i;
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(labeledLineRe);
    if (!match) continue;

    const label = match[1].toUpperCase();
    const msgText = match[2].trim();

    if (!msgText) continue;

    const isCloser =
      label === 'YOU' || label === 'CLOSER' || label === 'SETTER';

    // Handle bracketed content — could be annotation or message-type indicator
    if (/^\[.*\]$/.test(msgText)) {
      // Voice note indicators → classify as VOICE_NOTE
      if (/VOICE\s*(MESSAGE|NOTE)/i.test(msgText)) {
        messages.push({
          sender: isCloser ? 'CLOSER' : 'LEAD',
          text: msgText,
          timestamp: null,
          messageType: 'VOICE_NOTE',
          orderIndex: messages.length
        });
        continue;
      }
      // Shared content → classify as SYSTEM
      if (/SHARED\s+A\s+(POST|REEL|STORY)/i.test(msgText)) {
        messages.push({
          sender: isCloser ? 'CLOSER' : 'LEAD',
          text: msgText,
          timestamp: null,
          messageType: 'SYSTEM',
          orderIndex: messages.length
        });
        continue;
      }
      // Everything else in brackets (LEFT ON READ, OPENING MESSAGE, etc.) → skip
      continue;
    }

    // Skip bare known annotations (without brackets) — must be exact match
    if (
      /^(LEFT ON READ|OPENING MESSAGE|LEAD CONTACT INFO|SETTER LEFT ON READ|SETTER LEFT)$/i.test(
        msgText
      )
    ) {
      continue;
    }

    let messageType: ParsedMessage['messageType'] = 'TEXT';
    if (/voice\s*(message|note)|click for audio|audio call/i.test(msgText)) {
      messageType = 'VOICE_NOTE';
    } else if (/liked a message|reacted.*to your message/i.test(msgText)) {
      messageType = 'REACTION';
    } else if (
      /missed (video|voice) call|call started|shared a (post|reel|story)/i.test(
        msgText
      )
    ) {
      messageType = 'SYSTEM';
    } else if (/^https?:\/\/\S+$/i.test(msgText)) {
      messageType = 'URL_DROP';
    }

    messages.push({
      sender: isCloser ? 'CLOSER' : 'LEAD',
      text: msgText,
      timestamp: null,
      messageType,
      orderIndex: messages.length
    });
  }

  if (messages.length < 2) return null;

  const closerMsgs = messages.filter((m) => m.sender === 'CLOSER');
  const leadMsgs = messages.filter((m) => m.sender === 'LEAD');
  const voiceNotes = messages.filter((m) => m.messageType === 'VOICE_NOTE');

  return {
    leadIdentifier,
    messages,
    messageCount: messages.length,
    closerMessageCount: closerMsgs.length,
    leadMessageCount: leadMsgs.length,
    voiceNoteCount: voiceNotes.length,
    contentHash: computeContentHash(messages),
    startedAt: null,
    endedAt: null
  };
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
