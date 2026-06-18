/**
 * conversation-takeover-importer.ts
 *
 * Writes parsed takeover messages into the database.
 * Each message is written as a real Message row (so the AI sees them in
 * context) with msgSource=IMPORTED_TAKEOVER. The conversation is flagged
 * priorHumanHandoff=true so the prompt can inject a "resume" preamble.
 */

import prisma from '@/lib/prisma';
import type { ParsedMessage } from './conversation-takeover-parser';

export interface TakeoverImportResult {
  importedCount: number;
  skippedCount: number;
}

export async function importTakeoverMessages(
  conversationId: string,
  messages: ParsedMessage[]
): Promise<TakeoverImportResult> {
  if (messages.length === 0) {
    return { importedCount: 0, skippedCount: 0 };
  }

  let skippedCount = 0;
  const now = new Date();

  // Use a base timestamp so messages appear in order when no timestamp
  // was detected. Space them 30s apart so ordering is stable.
  const BASE_MS = now.getTime() - messages.length * 30_000;

  const rows = messages
    .map((m, i) => {
      const content = m.content?.trim();
      if (!content) {
        skippedCount++;
        return null;
      }
      const ts = m.timestamp
        ? new Date(m.timestamp)
        : new Date(BASE_MS + i * 30_000);
      return {
        conversationId,
        sender: (m.sender === 'lead' ? 'LEAD' : 'HUMAN') as 'LEAD' | 'HUMAN',
        content,
        timestamp: ts,
        msgSource: 'IMPORTED_TAKEOVER' as const
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  await prisma.$transaction([
    prisma.message.createMany({ data: rows }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: {
        priorHumanHandoff: true,
        lastMessageAt: rows.at(-1)?.timestamp ?? now
      }
    })
  ]);

  return { importedCount: rows.length, skippedCount };
}
