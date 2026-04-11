import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// serializeBreakdownForPrompt
// ---------------------------------------------------------------------------
// Fetches the active PersonaBreakdown for an account, filters to
// user-approved sections and resolved ambiguities, then assembles a
// plain-text block suitable for injection into the system prompt.
// Returns null when no usable breakdown exists.
// ---------------------------------------------------------------------------

export async function serializeBreakdownForPrompt(
  accountId: string
): Promise<string | null> {
  const breakdown = await prisma.personaBreakdown.findFirst({
    where: { accountId, status: 'ACTIVE' },
    include: {
      sections: {
        where: { userApproved: true },
        orderBy: { orderIndex: 'asc' }
      },
      ambiguities: {
        where: { resolved: true }
      }
    }
  });

  if (!breakdown || breakdown.sections.length === 0) {
    return null;
  }

  const parts: string[] = [];

  // Methodology summary
  parts.push(`## Sales Methodology\n${breakdown.methodologySummary}`);

  // Approved sections
  for (const section of breakdown.sections) {
    parts.push(`## ${section.title}\n${section.content}`);
  }

  // Resolved ambiguities
  if (breakdown.ambiguities.length > 0) {
    const bullets = breakdown.ambiguities
      .map((a) => `- ${a.question} -> ${a.userAnswer}`)
      .join('\n');
    parts.push(`## User-Specified Rules\n${bullets}`);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// buildDualLayerBlock
// ---------------------------------------------------------------------------
// Pure function (no DB). Combines the instruction layer (what the AI does)
// and the voice layer (how the AI sounds) into a single text block.
// When both layers are present, a conflict-resolution section is appended
// LAST so that the LLM weights it most heavily.
// ---------------------------------------------------------------------------

export function buildDualLayerBlock(
  instructionLayer: string | null,
  voiceLayer: string | null
): string {
  const parts: string[] = [];

  if (voiceLayer) {
    parts.push(
      `# HOW YOU SOUND (Voice & Style Layer)\n` +
        `The following style profile was derived from the account owner's real conversations. ` +
        `Mirror this voice exactly — vocabulary, sentence structure, emoji usage, punctuation habits, and energy level.\n\n` +
        voiceLayer
    );
  }

  if (instructionLayer) {
    parts.push(
      `# WHAT YOU DO (Instructions & System Layer)\n` +
        `The following instructions were extracted from the account owner's sales script. ` +
        `Follow the methodology, objection handling, qualification steps, and closing techniques described below.\n\n` +
        instructionLayer
    );
  }

  // Conflict resolution MUST be the last section so the LLM weights it most.
  if (voiceLayer && instructionLayer) {
    parts.push(
      `# CONFLICT RESOLUTION\n` +
        `When the Voice & Style layer and the Instructions layer conflict, ` +
        `the Voice & Style layer ALWAYS wins. The goal is to sound like the ` +
        `account owner while following their sales process. If the script says ` +
        `to use formal language but the voice profile shows casual, slang-heavy ` +
        `messages — use the casual style. The voice layer is the ground truth ` +
        `for HOW you communicate.`
    );
  }

  return parts.join('\n\n');
}
