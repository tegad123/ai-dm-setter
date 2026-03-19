// ─── Voice Profile Generator — Auto-analyze conversation style ─────────────
// Analyzes the last N human-sent messages to build a communication profile
// that makes the AI sound exactly like the user.

import prisma from '@/lib/prisma';

export interface VoiceProfile {
  // Message style
  avgMessageLength: number; // average chars per message
  shortMessageRate: number; // % of messages under 50 chars
  longMessageRate: number; // % of messages over 200 chars
  avgWordsPerMessage: number;

  // Tone indicators
  emojiFrequency: number; // emojis per 100 words
  questionFrequency: number; // % of messages that contain a question
  exclamationFrequency: number; // % of messages with !
  allCapsWordRate: number; // % of words in ALL CAPS

  // Vocabulary
  topPhrases: string[]; // most common 2-3 word phrases
  commonGreetings: string[]; // how they start messages
  commonClosings: string[]; // how they end messages
  slangWords: string[]; // informal/slang detected

  // Cadence
  avgResponseTimeMinutes: number | null; // how fast they typically reply
  peakActivityHours: number[]; // most active hours (0-23)

  // Summary
  toneLabel: string; // e.g. "Casual & Direct", "Professional & Warm"
  styleDescription: string; // 2-3 sentence description
  messageCount: number; // how many messages analyzed
  generatedAt: string; // ISO timestamp
}

// ─── Emoji detection ────────────────────────────────────────────────────

// Simple emoji detection — counts common emoji-like patterns
function countEmojis(text: string): number {
  // Match surrogate pairs and common emoji ranges without the 'u' flag
  const matches = text.match(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|[\uFE00-\uFEFF]/g
  );
  return matches ? matches.length : 0;
}

// ─── Main Analyzer ──────────────────────────────────────────────────────

export async function generateVoiceProfile(
  accountId: string,
  maxMessages: number = 500
): Promise<VoiceProfile> {
  // Fetch human-sent messages for this account
  const messages = await prisma.message.findMany({
    where: {
      sender: 'HUMAN',
      conversation: {
        lead: { accountId }
      }
    },
    select: {
      content: true,
      timestamp: true,
      sentByUserId: true
    },
    orderBy: { timestamp: 'desc' },
    take: maxMessages
  });

  // If not enough human messages, also analyze AI messages (the persona they set up)
  if (messages.length < 20) {
    const aiMessages = await prisma.message.findMany({
      where: {
        sender: 'AI',
        conversation: {
          lead: { accountId }
        }
      },
      select: {
        content: true,
        timestamp: true,
        sentByUserId: true
      },
      orderBy: { timestamp: 'desc' },
      take: maxMessages
    });
    messages.push(...aiMessages);
  }

  if (messages.length === 0) {
    return createDefaultProfile();
  }

  const contents = messages.map((m) => m.content);

  // ── Message Length Analysis ──
  const lengths = contents.map((c) => c.length);
  const avgMessageLength = Math.round(
    lengths.reduce((a, b) => a + b, 0) / lengths.length
  );
  const shortMessageRate = Math.round(
    (lengths.filter((l) => l < 50).length / lengths.length) * 100
  );
  const longMessageRate = Math.round(
    (lengths.filter((l) => l > 200).length / lengths.length) * 100
  );

  const wordCounts = contents.map((c) => c.split(/\s+/).filter(Boolean).length);
  const avgWordsPerMessage = Math.round(
    wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length
  );

  // ── Tone Indicators ──
  const allText = contents.join(' ');
  const totalWords = allText.split(/\s+/).filter(Boolean).length;

  const emojiCount = countEmojis(allText);
  const emojiFrequency =
    totalWords > 0 ? Math.round((emojiCount / totalWords) * 100 * 10) / 10 : 0;

  const questionCount = contents.filter((c) => c.includes('?')).length;
  const questionFrequency = Math.round((questionCount / contents.length) * 100);

  const exclamationCount = contents.filter((c) => c.includes('!')).length;
  const exclamationFrequency = Math.round(
    (exclamationCount / contents.length) * 100
  );

  const words = allText.split(/\s+/).filter(Boolean);
  const capsWords = words.filter(
    (w) => w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)
  );
  const allCapsWordRate =
    totalWords > 0 ? Math.round((capsWords.length / totalWords) * 100) : 0;

  // ── Phrase Analysis ──
  const phraseMap = new Map<string, number>();
  for (const content of contents) {
    const tokens = content.toLowerCase().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      phraseMap.set(bigram, (phraseMap.get(bigram) || 0) + 1);
    }
  }
  const topPhrases = Array.from(phraseMap.entries())
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([phrase]) => phrase);

  // ── Greetings & Closings ──
  const greetingWords = [
    'hey',
    'yo',
    'hi',
    'sup',
    "what's up",
    'hello',
    'ayy',
    'bro',
    'dude'
  ];
  const commonGreetings: string[] = [];
  for (const content of contents) {
    const firstWord = content.split(/\s+/)[0]?.toLowerCase();
    if (
      firstWord &&
      greetingWords.some((g) => content.toLowerCase().startsWith(g))
    ) {
      const greeting = content.split(/[.!?\n]/)[0].trim();
      if (
        greeting.length < 40 &&
        !commonGreetings.includes(greeting.toLowerCase())
      ) {
        commonGreetings.push(greeting.toLowerCase());
      }
    }
  }

  // ── Slang Detection ──
  const slangPatterns = [
    'fr',
    'ngl',
    'tbh',
    'lowkey',
    'highkey',
    'bet',
    'bro',
    'dude',
    'fam',
    'bruh',
    'lol',
    'lmao',
    'no cap',
    'deadass',
    'vibe',
    'fire',
    'goat',
    'w/',
    'imo',
    'nah',
    'fasho',
    'aight',
    'fs',
    'ong'
  ];
  const slangWords = slangPatterns.filter((s) =>
    allText.toLowerCase().includes(s)
  );

  // ── Response Time ──
  const timestamps = messages
    .map((m) => new Date(m.timestamp).getTime())
    .sort((a, b) => a - b);
  let avgResponseTimeMinutes: number | null = null;
  if (timestamps.length > 1) {
    const diffs = [];
    for (let i = 1; i < timestamps.length; i++) {
      const diff = (timestamps[i] - timestamps[i - 1]) / 60000;
      if (diff > 0 && diff < 1440) diffs.push(diff); // ignore >24h gaps
    }
    if (diffs.length > 0) {
      avgResponseTimeMinutes = Math.round(
        diffs.reduce((a, b) => a + b, 0) / diffs.length
      );
    }
  }

  // ── Peak Activity Hours ──
  const hourCounts = new Array(24).fill(0);
  for (const msg of messages) {
    hourCounts[new Date(msg.timestamp).getHours()]++;
  }
  const maxHourCount = Math.max(...hourCounts);
  const peakActivityHours = hourCounts
    .map((count, hour) => ({ hour, count }))
    .filter((h) => h.count > maxHourCount * 0.6)
    .map((h) => h.hour);

  // ── Tone Label ──
  const toneLabel = deriveToneLabel({
    emojiFrequency,
    shortMessageRate,
    questionFrequency,
    slangWords,
    avgWordsPerMessage
  });

  // ── Style Description ──
  const styleDescription = deriveStyleDescription({
    avgMessageLength,
    avgWordsPerMessage,
    emojiFrequency,
    questionFrequency,
    shortMessageRate,
    slangWords,
    toneLabel
  });

  return {
    avgMessageLength,
    shortMessageRate,
    longMessageRate,
    avgWordsPerMessage,
    emojiFrequency,
    questionFrequency,
    exclamationFrequency,
    allCapsWordRate,
    topPhrases,
    commonGreetings: commonGreetings.slice(0, 5),
    commonClosings: [],
    slangWords,
    avgResponseTimeMinutes,
    peakActivityHours,
    toneLabel,
    styleDescription,
    messageCount: messages.length,
    generatedAt: new Date().toISOString()
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function deriveToneLabel(params: {
  emojiFrequency: number;
  shortMessageRate: number;
  questionFrequency: number;
  slangWords: string[];
  avgWordsPerMessage: number;
}): string {
  const { emojiFrequency, shortMessageRate, slangWords, avgWordsPerMessage } =
    params;

  if (slangWords.length >= 5 && shortMessageRate > 60)
    return 'Street-Smart & Direct';
  if (slangWords.length >= 3 && emojiFrequency > 2) return 'Casual & Energetic';
  if (shortMessageRate > 50 && emojiFrequency < 1) return 'Concise & Direct';
  if (avgWordsPerMessage > 30) return 'Detailed & Consultative';
  if (emojiFrequency > 3) return 'Friendly & Expressive';
  return 'Balanced & Conversational';
}

function deriveStyleDescription(params: {
  avgMessageLength: number;
  avgWordsPerMessage: number;
  emojiFrequency: number;
  questionFrequency: number;
  shortMessageRate: number;
  slangWords: string[];
  toneLabel: string;
}): string {
  const parts: string[] = [];

  parts.push(`Communication style: ${params.toneLabel}.`);

  if (params.shortMessageRate > 60) {
    parts.push(
      `Keeps messages short (avg ${params.avgWordsPerMessage} words).`
    );
  } else if (params.avgWordsPerMessage > 25) {
    parts.push(
      `Writes longer, detailed messages (avg ${params.avgWordsPerMessage} words).`
    );
  } else {
    parts.push(
      `Moderate message length (avg ${params.avgWordsPerMessage} words).`
    );
  }

  if (params.slangWords.length > 0) {
    parts.push(`Uses slang like: ${params.slangWords.slice(0, 4).join(', ')}.`);
  }

  if (params.questionFrequency > 40) {
    parts.push('Asks a lot of questions to engage leads.');
  }

  return parts.join(' ');
}

function createDefaultProfile(): VoiceProfile {
  return {
    avgMessageLength: 0,
    shortMessageRate: 0,
    longMessageRate: 0,
    avgWordsPerMessage: 0,
    emojiFrequency: 0,
    questionFrequency: 0,
    exclamationFrequency: 0,
    allCapsWordRate: 0,
    topPhrases: [],
    commonGreetings: [],
    commonClosings: [],
    slangWords: [],
    avgResponseTimeMinutes: null,
    peakActivityHours: [],
    toneLabel: 'Not enough data',
    styleDescription:
      'Not enough conversation history to generate a voice profile. Send more messages and try again.',
    messageCount: 0,
    generatedAt: new Date().toISOString()
  };
}
