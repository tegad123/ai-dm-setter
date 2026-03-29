import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';

/**
 * Generate a voice profile analysis for an account's AI persona.
 */
export async function generateVoiceProfile(
  accountId: string
): Promise<{
  toneAnalysis: string;
  styleDescription: string;
  vocabularyPatterns: string[];
  messageLength: { avg: number; min: number; max: number };
  emojiUsage: number;
  suggestions: string[];
}> {
  // Fetch the persona and recent AI messages
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId }
  });

  const aiMessages = await prisma.message.findMany({
    where: {
      sender: 'AI',
      conversation: { lead: { accountId } }
    },
    orderBy: { timestamp: 'desc' },
    take: 50,
    select: { content: true }
  });

  if (aiMessages.length === 0) {
    return {
      toneAnalysis: 'Not enough messages to analyze voice profile.',
      styleDescription: 'N/A',
      vocabularyPatterns: [],
      messageLength: { avg: 0, min: 0, max: 0 },
      emojiUsage: 0,
      suggestions: ['Generate more AI messages to build a voice profile.']
    };
  }

  const lengths = aiMessages.map((m) => m.content.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const emojiCount = aiMessages.reduce(
    // eslint-disable-next-line no-control-regex
    (count, m) => count + (m.content.match(/[\uD83D][\uDE00-\uDE4F]/g) || []).length,
    0
  );

  return {
    toneAnalysis: persona?.tone || 'casual, direct',
    styleDescription: persona?.tone || 'casual, direct, friendly',
    vocabularyPatterns: ['conversational', 'short sentences', 'question-driven'],
    messageLength: {
      avg: Math.round(avgLength),
      min: Math.min(...lengths),
      max: Math.max(...lengths)
    },
    emojiUsage: Math.round((emojiCount / aiMessages.length) * 100) / 100,
    suggestions: [
      avgLength > 500 ? 'Consider shorter messages for DM context' : '',
      emojiCount === 0 ? 'Add occasional emojis for a more casual tone' : ''
    ].filter(Boolean)
  };
}
