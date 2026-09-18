import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';

/** Only used for IG conversations already created by the ManyChat opener. */
export async function persistManyChatNativeInbound(
  accountId: string,
  conversationId: string,
  data: Prisma.MessageUncheckedCreateInput
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`manychat-first-reply:${conversationId}`}, 0))`;
      const receipt = await tx.manyChatHandoffReceipt.findFirst({
        where: {
          accountId,
          conversationId,
          platform: 'INSTAGRAM',
          status: { in: ['PROCESSING', 'RETRY', 'QUEUED', 'ALREADY_HANDLED'] },
          receivedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
          leadMessageId: { not: null }
        }
      });
      if (receipt?.leadMessageId && data.platformMessageId) {
        const linked = await tx.message.findFirst({
          where: {
            id: receipt.leadMessageId,
            conversationId,
            sender: 'LEAD',
            platformMessageId: null,
            deletedAt: null,
            content: typeof data.content === 'string' ? data.content.trim() : ''
          }
        });
        const outbound = linked
          ? await tx.message.findFirst({
              where: {
                conversationId,
                sender: { in: ['AI', 'HUMAN'] },
                deletedAt: null
              }
            })
          : null;
        if (linked && !outbound) {
          const message = await tx.message.update({
            where: { id: linked.id },
            data: { platformMessageId: data.platformMessageId }
          });
          return { message, reused: true, skipReply: true };
        }
        if (linked && outbound) {
          // No native MID was provided by ManyChat. After an outbound, matching
          // text may be a delayed copy OR a genuine repeat. Preserve it for a
          // human instead of silently swallowing it or sending a duplicate.
          const message = await tx.message.create({ data });
          await tx.conversation.update({
            where: { id: conversationId },
            data: { awaitingHumanReview: true, unreadCount: { increment: 1 } }
          });
          await tx.notification.upsert({
            where: { id: `manychat-native-ambiguity-${receipt.id}` },
            create: {
              id: `manychat-native-ambiguity-${receipt.id}`,
              accountId,
              type: 'SYSTEM',
              title: 'ManyChat first reply needs review',
              body: `Conversation ${conversationId}, receipt ${receipt.id}: a native message matches the first reply after an outbound. Review whether this is a delayed duplicate or a new answer. Automatic response held.`
            },
            update: {}
          });
          return { message, reused: false, skipReply: true };
        }
      }
      return {
        message: await tx.message.create({ data }),
        reused: false,
        skipReply: false
      };
    },
    { maxWait: 2000, timeout: 5000 }
  );
}
