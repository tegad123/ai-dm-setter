/**
 * conversation-takeover-parser.ts
 *
 * Parses a raw pasted DM thread (copied from Instagram/Facebook app,
 * screenshot OCR, or plain text) into a structured list of messages the
 * importer can replay into the conversation. Uses Claude to handle the
 * messy, inconsistent formats that come out of copy-paste.
 */

import Anthropic from '@anthropic-ai/sdk';

export type ParsedSender = 'lead' | 'human';

export interface ParsedMessage {
  sender: ParsedSender;
  content: string;
  /** ISO string if detected, null otherwise */
  timestamp: string | null;
}

export interface TakeoverParseResult {
  messages: ParsedMessage[];
  /** Best-guess name for the lead (from conversation text), or null */
  detectedLeadName: string | null;
  /** Warnings the operator should read before importing */
  warnings: string[];
}

const PARSE_PROMPT = `You are parsing a copy-pasted DM thread so an AI sales assistant can resume it.

The thread may be from Instagram, Facebook, WhatsApp, or plain text. The format is inconsistent — timestamps may be missing, sender labels may use any name, and there may be OCR noise.

Your job:
1. Split the thread into individual messages in chronological order.
2. Classify each message as either "lead" (the person the business is talking to) or "human" (the business/setter/operator side).
3. Extract the message content, cleaning up obvious OCR/copy artifacts.
4. Extract a timestamp if present (output as ISO 8601 or null).
5. Note any warnings (ambiguous senders, garbled text, very short messages that might be reactions/emojis only, etc).

Rules:
- When in doubt about sender, default to "lead".
- Strip UI chrome like "Seen", "Delivered", reaction labels, "Active now", story reply indicators.
- Do NOT invent or paraphrase content — preserve the lead's exact words.
- If the thread has fewer than 2 messages or is clearly not a DM thread, set messages to [] and add a warning.

Respond with ONLY valid JSON matching this shape (no markdown fences):
{
  "messages": [
    { "sender": "lead" | "human", "content": "...", "timestamp": "ISO string or null" }
  ],
  "detectedLeadName": "string or null",
  "warnings": ["string", ...]
}`;

export async function parseTakeoverThread(
  rawText: string
): Promise<TakeoverParseResult> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${PARSE_PROMPT}\n\n---THREAD START---\n${rawText.slice(0, 12000)}\n---THREAD END---`
      }
    ]
  });

  const text =
    response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const parsed = JSON.parse(text) as TakeoverParseResult;
    // Normalise — ensure arrays exist
    parsed.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    parsed.warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
    return parsed;
  } catch {
    return {
      messages: [],
      detectedLeadName: null,
      warnings: [
        'Could not parse the thread — the AI returned an unexpected response. Try again or paste a cleaner copy of the thread.'
      ]
    };
  }
}
