// ─── AI Messaging Engine — Structured JSON Response (BYOK) ─────────────────
// Core AI engine that generates replies using per-account AI personas.
// The new master template instructs the AI to return structured JSON with
// format, message, stage, and suggested_tag — one call instead of three.

import type {
  MessageSender,
  LeadStatus,
  Platform,
  TriggerType
} from '@prisma/client';
import {
  buildDynamicSystemPrompt,
  getQualityScoringPrompt
} from '@/lib/ai-prompts';
import { getCredentials } from '@/lib/credential-store';
import prisma from '@/lib/prisma';

// ─── Types ──────────────────────────────────────────────

export interface Message {
  id: string;
  conversationId: string;
  sender: MessageSender;
  content: string;
  isVoiceNote: boolean;
  voiceNoteUrl: string | null;
  sentByUserId: string | null;
  timestamp: Date;
}

export interface LeadContext {
  leadName: string;
  handle: string;
  platform: Platform;
  status: LeadStatus;
  triggerType: TriggerType;
  triggerSource: string | null;
  qualityScore: number;
}

export interface AIReplyResult {
  reply: string;
  shouldVoiceNote: boolean;
  qualityScore: number;
  suggestedDelay: number; // milliseconds
  suggestedTag: string | null; // Lead status suggestion from AI
  suggestedTags: string[]; // Multiple auto-tags (Phase 2)
  stage: string | null; // Current conversation stage
}

/** Structured response the AI returns per the master template */
interface AIStructuredResponse {
  format: 'text' | 'voice_note';
  message: string;
  stage: string;
  suggested_tag: string;
  suggested_tags: string[]; // Multiple auto-tags with Phase 2 tagging system
}

type AIProvider = 'openai' | 'anthropic';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Per-Account Credential Resolution ─────────────────

async function resolveAICredentials(
  accountId: string
): Promise<{ provider: AIProvider; apiKey: string; model?: string }> {
  const openaiCreds = await getCredentials(accountId, 'OPENAI');
  if (openaiCreds?.apiKey) {
    return {
      provider: 'openai',
      apiKey: openaiCreds.apiKey,
      model: openaiCreds.model || undefined
    };
  }

  const anthropicCreds = await getCredentials(accountId, 'ANTHROPIC');
  if (anthropicCreds?.apiKey) {
    return {
      provider: 'anthropic',
      apiKey: anthropicCreds.apiKey,
      model: anthropicCreds.model || undefined
    };
  }

  const envProvider = (
    process.env.AI_PROVIDER || 'openai'
  ).toLowerCase() as AIProvider;
  const envKey =
    envProvider === 'anthropic'
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

  if (!envKey) {
    throw new Error(
      'No AI provider configured. Please add your OpenAI or Anthropic API key in Settings → Integrations.'
    );
  }

  return {
    provider: envProvider,
    apiKey: envKey,
    model: process.env.AI_MODEL || undefined
  };
}

// ─── Provider Implementations ───────────────────────────

async function callOpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  temperature: number = 0.85,
  maxTokens: number = 500
): Promise<string> {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: 'system', content: systemPrompt }, ...messages]
  });

  return response.choices[0]?.message?.content?.trim() || '';
}

async function callAnthropic(
  systemPrompt: string,
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  temperature: number = 0.85,
  maxTokens: number = 500
): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const anthropicMessages = messages.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.content
  }));

  const response = await client.messages.create({
    model,
    system: systemPrompt,
    temperature,
    max_tokens: maxTokens,
    messages: anthropicMessages
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock?.text?.trim() || '';
}

async function callAI(
  accountId: string,
  systemPrompt: string,
  messages: ChatMessage[],
  temperature: number = 0.85,
  maxTokens: number = 500
): Promise<string> {
  const { provider, apiKey, model } = await resolveAICredentials(accountId);
  const resolvedModel =
    model || (provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

  if (provider === 'anthropic') {
    return callAnthropic(
      systemPrompt,
      messages,
      apiKey,
      resolvedModel,
      temperature,
      maxTokens
    );
  }
  return callOpenAI(
    systemPrompt,
    messages,
    apiKey,
    resolvedModel,
    temperature,
    maxTokens
  );
}

// ─── Response Parsing ───────────────────────────────────

/**
 * Parse the AI's structured JSON response.
 * The master template instructs the AI to respond with:
 * { "format": "text|voice_note", "message": "...", "stage": "...", "suggested_tag": "..." }
 *
 * Falls back gracefully if the AI doesn't return valid JSON.
 */
function parseStructuredResponse(raw: string): AIStructuredResponse {
  // Try to extract JSON from the response (may be wrapped in markdown code blocks)
  let jsonStr = raw;

  // Strip markdown code block wrapper if present
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      format: parsed.format === 'voice_note' ? 'voice_note' : 'text',
      message: typeof parsed.message === 'string' ? parsed.message : raw,
      stage: typeof parsed.stage === 'string' ? parsed.stage : '',
      suggested_tag:
        typeof parsed.suggested_tag === 'string' ? parsed.suggested_tag : '',
      suggested_tags: Array.isArray(parsed.suggested_tags)
        ? parsed.suggested_tags.filter(
            (t: unknown) => typeof t === 'string' && t.length > 0
          )
        : []
    };
  } catch {
    // AI didn't return valid JSON — treat the whole response as a text message
    return {
      format: 'text',
      message: raw,
      stage: '',
      suggested_tag: '',
      suggested_tags: []
    };
  }
}

// ─── Conversation History Formatting ────────────────────

function formatConversationHistory(messages: Message[]): ChatMessage[] {
  return messages.map((msg) => ({
    role: msg.sender === 'LEAD' ? ('user' as const) : ('assistant' as const),
    content: msg.isVoiceNote ? `[Voice Note] ${msg.content}` : msg.content
  }));
}

// ─── Response Delay Logic (per-account configurable) ────

function calculateSuggestedDelay(
  conversationHistory: Message[],
  reply: string,
  delayMinMs: number = 300 * 1000,
  delayMaxMs: number = 600 * 1000
): number {
  const messageCount = conversationHistory.length;

  // First reply: use the lower range of configured delay
  if (messageCount <= 1) {
    return randomBetween(delayMinMs, Math.round((delayMinMs + delayMaxMs) / 2));
  }

  // Active back-and-forth: check if lead is replying fast
  const recentMessages = conversationHistory.slice(-4);
  const timeDiffs = [];
  for (let i = 1; i < recentMessages.length; i++) {
    const diff =
      new Date(recentMessages[i].timestamp).getTime() -
      new Date(recentMessages[i - 1].timestamp).getTime();
    timeDiffs.push(diff);
  }
  const avgResponseTime =
    timeDiffs.length > 0
      ? timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length
      : delayMaxMs;

  // If lead is replying fast, use the lower end of the delay range
  if (avgResponseTime < delayMinMs) {
    return randomBetween(Math.round(delayMinMs * 0.5), delayMinMs);
  }

  // Normal flow: use configured range with typing simulation
  const typingFactor = Math.min(reply.length / 100, 1);
  const baseDelay = randomBetween(delayMinMs, delayMaxMs);
  const typingDelay = Math.round(
    typingFactor * (delayMaxMs - delayMinMs) * 0.3
  );

  return Math.round(baseDelay + typingDelay);
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Exported Functions ─────────────────────────────────

/**
 * Generate a reply using the account's AI persona and master prompt template.
 * Now returns structured data: the AI's response includes format (text/voice_note),
 * message, stage, and suggested_tag — all from a SINGLE AI call.
 * Quality score is still a separate lightweight call for analytics.
 */
export async function generateReply(
  accountId: string,
  conversationHistory: Message[],
  leadContext: LeadContext
): Promise<AIReplyResult> {
  // Fetch persona settings for delay config and voice note toggle
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true },
    select: {
      responseDelayMin: true,
      responseDelayMax: true,
      voiceNotesEnabled: true
    }
  });

  const delayMinMs = (persona?.responseDelayMin ?? 300) * 1000;
  const delayMaxMs = (persona?.responseDelayMax ?? 600) * 1000;
  const voiceNotesEnabled = persona?.voiceNotesEnabled ?? true;

  const systemPrompt = await buildDynamicSystemPrompt(accountId, {
    leadName: leadContext.leadName,
    handle: leadContext.handle,
    platform: leadContext.platform,
    status: leadContext.status,
    triggerType: leadContext.triggerType,
    triggerSource: leadContext.triggerSource,
    qualityScore: leadContext.qualityScore
  });

  const chatMessages = formatConversationHistory(conversationHistory);

  // Single AI call — the template instructs JSON output with format + message + stage + tag
  const [rawReply, qualityScore] = await Promise.all([
    callAI(accountId, systemPrompt, chatMessages, 0.85, 500),
    calculateLeadQualityScore(
      accountId,
      conversationHistory,
      leadContext.status
    )
  ]);

  // Parse structured response
  const structured = parseStructuredResponse(rawReply);

  // Use per-account delay settings
  const suggestedDelay = calculateSuggestedDelay(
    conversationHistory,
    structured.message,
    delayMinMs,
    delayMaxMs
  );

  // Respect the voice notes toggle — if disabled, force text
  const shouldVoiceNote =
    voiceNotesEnabled && structured.format === 'voice_note';

  return {
    reply: structured.message,
    shouldVoiceNote,
    qualityScore,
    suggestedDelay,
    suggestedTag: structured.suggested_tag || null,
    suggestedTags: structured.suggested_tags || [],
    stage: structured.stage || null
  };
}

/**
 * Calculate a 0-100 quality score for the lead based on conversation signals.
 * This is still a separate call — used for analytics/scoring dashboards.
 */
export async function calculateLeadQualityScore(
  accountId: string,
  conversationHistory: Message[],
  leadStatus: LeadStatus | string
): Promise<number> {
  if (conversationHistory.length < 2) {
    return 20;
  }

  const scoringPrompt = await getQualityScoringPrompt(accountId);
  const chatMessages = formatConversationHistory(conversationHistory);

  chatMessages.push({
    role: 'user' as const,
    content: `Score this lead. Their current status is: ${leadStatus}. Respond with ONLY a number 0-100.`
  });

  const result = await callAI(accountId, scoringPrompt, chatMessages, 0.2, 10);

  const score = parseInt(result.replace(/\D/g, ''), 10);
  if (isNaN(score)) return 30;
  return Math.max(0, Math.min(100, score));
}

/**
 * @deprecated Use generateReply() which now includes voice note decisions.
 * Kept for backward compatibility.
 */
export async function shouldSendVoiceNote(
  _accountId: string,
  _message: string,
  conversationHistory: Message[]
): Promise<boolean> {
  if (conversationHistory.length < 4) return false;
  return false; // Now handled by structured JSON response in generateReply
}
