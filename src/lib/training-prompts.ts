// ---------------------------------------------------------------------------
// LLM Prompts for Training Data Ingestion Pipeline
// ---------------------------------------------------------------------------

/**
 * Pre-flight prompt — sent to Claude Haiku with the first ~2000 chars of
 * extracted PDF text. Cheap sanity check before the expensive structuring call.
 */
export const PREFLIGHT_PROMPT = `You are validating whether a document is a social media DM conversation export (Instagram, Facebook Messenger, or similar).

Analyze the text below. Respond with ONLY a JSON object:

{
  "isConversationExport": true | false,
  "reason": "Brief explanation",
  "estimatedConversations": <number or 0>,
  "closerName": "<name of the person whose messages are marked with '(You)' or similar, or null>"
}

Rules:
- true if the text contains multiple messages between two or more people, with timestamps and sender labels
- false if it is a sales script, SOP document, article, resume, or any non-conversation document
- estimatedConversations: count distinct conversation threads/sections visible in the sample (0 if not a conversation export)
- closerName: the name or handle associated with "(You)" messages, or null if unclear

Return ONLY valid JSON. No explanation.`;

/**
 * Structuring prompt — sent to Claude Sonnet with the full PDF (native
 * document type) or extracted text chunks. Converts raw conversation text
 * into the normalized ParsedConversation[] schema.
 */
export const STRUCTURING_PROMPT = `You are a conversation structuring engine. Parse DM conversations from a conversation export into structured JSON.

## INPUT
You will receive either a PDF document or extracted text containing Instagram/Facebook DM conversations. Each conversation typically has:
- A header identifying the lead (e.g. @username, display name, message counts)
- Messages labeled with sender names — the account owner's messages are typically marked with "(You)"
- Timestamps on most messages (e.g. "Jan 14, 2026 10:09 am")
- Messages may be in REVERSE chronological order within each conversation — you MUST output them in FORWARD chronological order (oldest first)

## OUTPUT FORMAT
Return a JSON object with this exact structure:

{
  "conversations": [
    {
      "leadIdentifier": "@username or Display Name",
      "messages": [
        {
          "sender": "CLOSER",
          "text": "message text here",
          "timestamp": "2026-01-14T10:09:00.000Z",
          "messageType": "TEXT",
          "orderIndex": 0
        }
      ]
    }
  ],
  "closerName": "Name of the account owner"
}

## SENDER VALUES
- "CLOSER" — messages from the account owner (the person marked with "(You)" or equivalent)
- "LEAD" — messages from everyone else

## MESSAGE TYPE VALUES
- "TEXT" — normal text messages, media placeholders like "[Media/No text]"
- "VOICE_NOTE" — audio/voice message placeholders ("Click for audio", "Voice message", audio call references)
- "SYSTEM" — missed call notifications, call-started events, shared posts/reels
- "REACTION" — "Liked a message", "Reacted X to your message"
- "URL_DROP" — messages that are ONLY a URL with no other text

## RULES

1. **CRITICAL — Extract ALL conversations**: You MUST extract every distinct conversation in the input. Do NOT stop after the first few. If the input contains 20+ conversations, output all 20+. Each unique participant/lead is a separate conversation.
2. **CRITICAL — Message ordering**: Output messages in FORWARD chronological order (oldest message first, orderIndex 0). Many exports list messages newest-first — reverse them.
3. **Sender detection**: Messages from the account owner (marked "(You)" or similar) → "CLOSER". All other participants → "LEAD".
4. **Timestamp parsing**: Convert to ISO 8601 format (e.g. "2026-01-14T10:09:00.000Z"). If a timestamp is ambiguous or missing, use null.
5. **Corrupted characters**: The PDF may render emoji as ■ or □. Keep these characters as-is. Do not guess original emoji.
6. **Multi-message handling**: Do NOT merge consecutive messages from the same sender. Keep each message as a separate entry.
7. **orderIndex**: Sequential integer starting at 0 for each conversation independently. 0 = oldest/first message.
8. **Skip tiny conversations**: Omit conversations with fewer than 2 total messages.
9. **Duplicate messages**: If the same message text appears twice consecutively from the same sender (common with edited/resent messages), keep only one.
10. **Voice note text**: For voice notes, set text to null and messageType to "VOICE_NOTE".
11. **Reaction text**: For reactions, keep the reaction text (e.g. "Liked a message") and set messageType to "REACTION".
12. **Partial conversations**: If the input starts or ends mid-conversation (text was split), still extract whatever messages you can. Use the available context to determine the leadIdentifier.

Return ONLY valid JSON. No markdown code blocks. No explanation before or after.`;
