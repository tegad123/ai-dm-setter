import prisma from '@/lib/prisma';
import type { ScriptStep } from '@/lib/script-framework-types';

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
      },
      voiceNoteSlots: true,
      scriptSlots: {
        orderBy: { orderIndex: 'asc' },
        include: {
          boundVoiceNote: {
            select: { id: true, audioFileUrl: true, userLabel: true }
          }
        }
      }
    }
  });

  if (!breakdown || breakdown.sections.length === 0) {
    return null;
  }

  const parts: string[] = [];

  // Methodology summary
  parts.push(`## Sales Methodology\n${breakdown.methodologySummary}`);

  // Approved sections (behavioral view)
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

  // Script Framework (sequential flow view) — approved steps only
  const scriptSteps = (breakdown.scriptSteps as ScriptStep[] | null) || [];
  const approvedSteps = scriptSteps.filter((s) => s.user_approved);
  if (approvedSteps.length > 0) {
    const stepLines = serializeStepsCompact(approvedSteps);
    parts.push(`## Script Framework (Follow this sequence)\n${stepLines}`);
  }

  // Voice Note Slots — show available pre-recorded audio slots
  const readySlots = breakdown.voiceNoteSlots.filter(
    (s) => s.status === 'UPLOADED' || s.status === 'APPROVED'
  );
  const fallbackSlots = breakdown.voiceNoteSlots.filter(
    (s) =>
      s.status === 'EMPTY' &&
      s.fallbackBehavior !== 'BLOCK_UNTIL_FILLED' &&
      s.fallbackText
  );
  const allUsableSlots = [...readySlots, ...fallbackSlots];

  if (allUsableSlots.length > 0) {
    const slotLines = allUsableSlots.map((s) => {
      const hasAudio = s.status === 'UPLOADED' || s.status === 'APPROVED';
      const tag = hasAudio ? '[AUDIO READY]' : `[FALLBACK: text equivalent]`;
      return `- ${s.slotName} (slot_id: ${s.id}): ${s.description} ${tag}`;
    });
    parts.push(
      `## Available Voice Note Slots\nWhen the conversation reaches these trigger points, output voice_note_action with the slot_id.\n${slotLines.join('\n')}`
    );
  }

  // Sprint 3: Inject ScriptSlot data into the system prompt
  if (breakdown.scriptSlots && breakdown.scriptSlots.length > 0) {
    // Voice note slots bound to library items
    const boundVnSlots = breakdown.scriptSlots.filter(
      (s) =>
        s.slotType === 'voice_note' && s.boundVoiceNoteId && s.boundVoiceNote
    );
    if (boundVnSlots.length > 0) {
      const vnLines = boundVnSlots.map((s) => {
        const label =
          s.boundVoiceNote?.userLabel || s.detectedName || 'Voice Note';
        return `- ${label} (slot_id: ${s.id}): ${s.description || ''} [AUDIO READY]`;
      });
      parts.push(
        `## Bound Voice Notes (Library)\nThese voice notes are pre-recorded and ready to send.\n${vnLines.join('\n')}`
      );
    }

    // Link slots with filled URLs
    const filledLinks = breakdown.scriptSlots.filter(
      (s) => s.slotType === 'link' && s.url
    );
    if (filledLinks.length > 0) {
      const linkLines = filledLinks.map(
        (s) => `- ${s.detectedName || 'Link'}: ${s.url}`
      );
      parts.push(
        `## Available Links & URLs\nUse these EXACT URLs when the script calls for them. NEVER make up or hallucinate URLs.\n${linkLines.join('\n')}`
      );
    }

    // Form slot data (FAQ answers, etc.)
    const filledForms = breakdown.scriptSlots.filter(
      (s) =>
        s.slotType === 'form' &&
        s.formValues &&
        Object.keys(s.formValues as object).length > 0
    );
    if (filledForms.length > 0) {
      const formParts: string[] = [];
      for (const form of filledForms) {
        const schema = form.formSchema as {
          fields: Array<{ field_id: string; label: string }>;
        } | null;
        const vals = form.formValues as Record<string, string>;
        if (schema?.fields && vals) {
          const entries = schema.fields
            .filter((f) => vals[f.field_id])
            .map((f) => `  - ${f.label}: ${vals[f.field_id]}`);
          if (entries.length > 0) {
            formParts.push(
              `${form.detectedName || 'Form Data'}:\n${entries.join('\n')}`
            );
          }
        }
      }
      if (formParts.length > 0) {
        parts.push(`## Configured Data\n${formParts.join('\n\n')}`);
      }
    }

    // Runtime judgment instructions
    const rjSlots = breakdown.scriptSlots.filter(
      (s) => s.slotType === 'runtime_judgment' && s.instruction
    );
    if (rjSlots.length > 0) {
      const rjLines = rjSlots.map(
        (s) =>
          `- At ${s.stepId}: ${s.instruction}${s.context ? ` (Context: ${s.context})` : ''}`
      );
      parts.push(
        `## Runtime Judgment Instructions\nAt these points, use your judgment based on the conversation context:\n${rjLines.join('\n')}`
      );
    }

    // Filled text gaps
    const filledTexts = breakdown.scriptSlots.filter(
      (s) => s.slotType === 'text_gap' && (s.userContent || s.suggestedContent)
    );
    if (filledTexts.length > 0) {
      const textLines = filledTexts.map(
        (s) =>
          `- ${s.description || s.stepId}: ${s.userContent || s.suggestedContent}`
      );
      parts.push(`## Script Content Fills\n${textLines.join('\n')}`);
    }
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// serializeStepsCompact
// ---------------------------------------------------------------------------
// Converts ScriptStep[] into compact numbered text for the system prompt.
// Keeps it concise to avoid bloating the prompt.
// ---------------------------------------------------------------------------

function serializeStepsCompact(steps: ScriptStep[]): string {
  const lines: string[] = [];
  for (const step of steps) {
    let stepText = `Step ${step.step_number}: ${step.title}`;
    for (const branch of step.branches) {
      if (branch.condition !== 'default') {
        stepText += `\n  IF ${branch.condition}:`;
      }
      for (const action of branch.actions) {
        const prefix =
          action.action_type === 'send_voice_note'
            ? '[VOICE NOTE]'
            : action.action_type === 'wait_for_response'
              ? '[WAIT]'
              : action.action_type === 'ask_question'
                ? '[ASK]'
                : action.action_type === 'send_link'
                  ? '[LINK]'
                  : action.action_type === 'branch_decision'
                    ? '[DECIDE]'
                    : '[DO]';
        const content = action.content || action.action_type;
        const slotRef = action.voice_note_slot_id
          ? ` (slot_id: ${action.voice_note_slot_id})`
          : '';
        stepText += `\n    ${prefix} ${content}${slotRef}`;
      }
    }
    lines.push(stepText);
  }
  return lines.join('\n\n');
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
