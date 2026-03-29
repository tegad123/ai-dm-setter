import prisma from '@/lib/prisma';

/**
 * Generate optimization suggestions based on conversation data.
 */
export async function generateOptimizations(
  accountId: string
): Promise<Array<{
  type: string;
  reasoning: string;
  proposedChanges: string;
  confidence: number;
}>> {
  const conversations = await prisma.conversation.findMany({
    where: {
      lead: { accountId },
      outcome: { not: 'ONGOING' }
    },
    select: { outcome: true }
  });

  if (conversations.length < 10) {
    return [];
  }

  const outcomes = conversations.reduce(
    (acc, c) => {
      acc[c.outcome] = (acc[c.outcome] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const total = conversations.length;
  const bookingRate = (outcomes['BOOKED'] || 0) / total;
  const leftOnReadRate = (outcomes['LEFT_ON_READ'] || 0) / total;

  const suggestions = [];

  if (leftOnReadRate > 0.5) {
    suggestions.push({
      type: 'SYSTEM_PROMPT_UPDATE',
      reasoning: `${Math.round(leftOnReadRate * 100)}% of conversations end in LEFT_ON_READ. The follow-up sequence may need adjustment.`,
      proposedChanges: 'Adjust follow-up timing and messaging to re-engage more leads.',
      confidence: 0.7
    });
  }

  if (bookingRate < 0.1 && total > 20) {
    suggestions.push({
      type: 'FLOW_ADJUSTMENT',
      reasoning: `Booking rate is only ${Math.round(bookingRate * 100)}%. The qualification flow may be too aggressive or not building enough value.`,
      proposedChanges: 'Consider adding more vision-building before the booking ask.',
      confidence: 0.6
    });
  }

  return suggestions;
}

/**
 * Apply an optimization suggestion (update prompt version).
 */
export async function applyOptimization(
  accountId: string,
  optimizationId: string
): Promise<void> {
  await prisma.optimizationSuggestion.update({
    where: { id: optimizationId },
    data: { status: 'APPLIED', resolvedAt: new Date() }
  });
}

/**
 * Reject an optimization suggestion.
 */
/**
 * Revert a previously applied optimization.
 */
export async function revertOptimization(
  optimizationId: string,
  notes?: string
): Promise<void> {
  await prisma.optimizationSuggestion.update({
    where: { id: optimizationId },
    data: {
      status: 'REVERTED',
      adminNotes: notes || null,
      resolvedAt: new Date()
    }
  });
}

export async function rejectOptimization(
  optimizationId: string,
  notes?: string
): Promise<void> {
  await prisma.optimizationSuggestion.update({
    where: { id: optimizationId },
    data: {
      status: 'REJECTED',
      adminNotes: notes || null,
      resolvedAt: new Date()
    }
  });
}
