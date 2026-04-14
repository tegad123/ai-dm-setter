// ---------------------------------------------------------------------------
// script-serializer.ts
// ---------------------------------------------------------------------------
// Reads the active Script for an account and generates a structured text
// block suitable for injection into the AI system prompt.
//
// Replaces serializeBreakdownForPrompt from persona-breakdown-serializer.ts.
// The output format deliberately matches the section headers the old
// serializer used so integration into ai-prompts.ts is seamless.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';

// Action type → prompt tag mapping
const ACTION_TAG: Record<string, string> = {
  send_message: 'SEND',
  ask_question: 'ASK',
  send_voice_note: 'VOICE NOTE',
  send_link: 'LINK',
  send_video: 'VIDEO',
  form_reference: 'FORM',
  runtime_judgment: 'JUDGMENT',
  wait_for_response: 'WAIT',
  wait_duration: 'WAIT'
};

export async function serializeScriptForPrompt(
  accountId: string
): Promise<string | null> {
  const script = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    include: {
      steps: {
        orderBy: { stepNumber: 'asc' },
        include: {
          branches: {
            orderBy: { sortOrder: 'asc' },
            include: {
              actions: {
                orderBy: { sortOrder: 'asc' },
                include: {
                  voiceNote: {
                    select: {
                      id: true,
                      userLabel: true,
                      audioFileUrl: true,
                      durationSeconds: true
                    }
                  },
                  form: {
                    include: {
                      fields: { orderBy: { sortOrder: 'asc' } }
                    }
                  }
                }
              }
            }
          },
          actions: {
            where: { branchId: null },
            orderBy: { sortOrder: 'asc' },
            include: {
              voiceNote: {
                select: {
                  id: true,
                  userLabel: true,
                  audioFileUrl: true,
                  durationSeconds: true
                }
              },
              form: {
                include: {
                  fields: { orderBy: { sortOrder: 'asc' } }
                }
              }
            }
          }
        }
      },
      forms: {
        include: { fields: { orderBy: { sortOrder: 'asc' } } }
      }
    }
  });

  if (!script || script.steps.length === 0) {
    return null;
  }

  const parts: string[] = [];

  // ── Script Framework ──────────────────────────────────────
  const stepLines: string[] = [];

  for (const step of script.steps) {
    stepLines.push('');
    stepLines.push(`Step ${step.stepNumber}: ${step.title}`);
    if (step.objective) {
      stepLines.push(`Objective: ${step.objective}`);
    }

    if (step.branches.length > 0) {
      for (const branch of step.branches) {
        const condition = branch.conditionDescription
          ? ` (${branch.conditionDescription})`
          : '';
        stepLines.push(`  IF ${branch.branchLabel}${condition}:`);

        for (const action of branch.actions) {
          stepLines.push(serializeAction(action, '    '));
        }
      }
    } else {
      // Direct actions
      for (const action of step.actions) {
        stepLines.push(serializeAction(action, '    '));
      }
    }
  }

  parts.push(
    `## Script Framework (Follow this sequence)\nIMPORTANT: Text inside {{double curly braces}} is a runtime placeholder. Replace it with contextually appropriate content based on the conversation so far. For example, "{{customize to their stated goal}}" means you should insert language specific to what the prospect told you about their goal.\n${stepLines.join('\n')}`
  );

  // ── Voice Notes ───────────────────────────────────────────
  const voiceNotes: {
    id: string;
    label: string;
    description: string;
  }[] = [];

  for (const step of script.steps) {
    const allActions = [
      ...step.actions,
      ...step.branches.flatMap((b) => b.actions)
    ];
    for (const action of allActions) {
      if (action.actionType === 'send_voice_note' && action.voiceNote) {
        voiceNotes.push({
          id: action.voiceNote.id,
          label:
            action.voiceNote.userLabel ||
            `Voice Note (Step ${step.stepNumber})`,
          description: action.content || 'Pre-recorded voice note'
        });
      }
    }
  }

  if (voiceNotes.length > 0) {
    const vnLines = voiceNotes.map(
      (vn) =>
        `- ${vn.label} (voice_note_id: ${vn.id}): ${vn.description} [AUDIO READY]`
    );
    parts.push(
      `## Available Voice Notes (Library)\nThese voice notes are pre-recorded and ready to send. When the conversation reaches the trigger point, output voice_note_action with the voice_note_id.\n${vnLines.join('\n')}`
    );
  }

  // ── Links & URLs ──────────────────────────────────────────
  const links: { label: string; url: string }[] = [];

  for (const step of script.steps) {
    const allActions = [
      ...step.actions,
      ...step.branches.flatMap((b) => b.actions)
    ];
    for (const action of allActions) {
      if (
        (action.actionType === 'send_link' ||
          action.actionType === 'send_video') &&
        action.linkUrl
      ) {
        links.push({
          label: action.linkLabel || action.content || 'Link',
          url: action.linkUrl
        });
      }
    }
  }

  if (links.length > 0) {
    const linkLines = links.map((l) => `- ${l.label}: ${l.url}`);
    parts.push(
      `## Available Links & URLs\nUse these EXACT URLs when the script calls for them. NEVER make up or hallucinate URLs.\n${linkLines.join('\n')}`
    );
  }

  // ── Configured Data (Forms — Global Reference) ────────────
  const filledForms = script.forms.filter((f) =>
    f.fields.some((fld) => fld.fieldValue && fld.fieldValue.trim().length > 0)
  );

  if (filledForms.length > 0) {
    const formParts: string[] = [];
    for (const form of filledForms) {
      const entries = form.fields
        .filter((f) => f.fieldValue && f.fieldValue.trim().length > 0)
        .map((f) => `  - ${f.fieldLabel}: ${f.fieldValue}`);
      if (entries.length > 0) {
        formParts.push(`${form.name}:\n${entries.join('\n')}`);
      }
    }
    if (formParts.length > 0) {
      parts.push(
        `## Reference Data (Available Throughout Entire Conversation)\nThese forms contain reference data you can draw from at ANY point in the conversation — not just specific steps. Use them whenever relevant.\n${formParts.join('\n\n')}`
      );
    }
  }

  // ── Runtime Judgment Instructions ─────────────────────────
  const judgments: { step: string; instruction: string }[] = [];

  for (const step of script.steps) {
    const allActions = [
      ...step.actions,
      ...step.branches.flatMap((b) => b.actions)
    ];
    for (const action of allActions) {
      if (action.actionType === 'runtime_judgment' && action.content) {
        judgments.push({
          step: `Step ${step.stepNumber} (${step.title})`,
          instruction: action.content
        });
      }
    }
  }

  if (judgments.length > 0) {
    const rjLines = judgments.map((j) => `- At ${j.step}: ${j.instruction}`);
    parts.push(
      `## Runtime Judgment Instructions\nAt these points, use your judgment based on the conversation context:\n${rjLines.join('\n')}`
    );
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Helper: serialize a single action into a prompt line
// ---------------------------------------------------------------------------

function serializeAction(
  action: {
    actionType: string;
    content?: string | null;
    linkUrl?: string | null;
    linkLabel?: string | null;
    waitDuration?: number | null;
    voiceNote?: { id: string; userLabel: string | null } | null;
    form?: {
      name: string;
      fields: { fieldLabel: string; fieldValue: string | null }[];
    } | null;
  },
  indent: string
): string {
  const tag = ACTION_TAG[action.actionType] || action.actionType.toUpperCase();

  switch (action.actionType) {
    case 'send_message':
    case 'ask_question':
      return `${indent}[${tag}] ${action.content || '(empty)'}`;

    case 'send_voice_note':
      if (action.voiceNote) {
        return `${indent}[${tag}] Send pre-recorded: ${action.voiceNote.userLabel || 'voice note'} (voice_note_id: ${action.voiceNote.id})`;
      }
      return `${indent}[${tag}] ${action.content || 'Send a voice note'}`;

    case 'send_link':
    case 'send_video':
      if (action.linkUrl) {
        return `${indent}[${tag}] ${action.linkLabel || action.content || 'Link'}: ${action.linkUrl}`;
      }
      return `${indent}[${tag}] ${action.content || '(URL not yet configured)'}`;

    case 'form_reference':
      if (action.form) {
        return `${indent}[${tag}] Reference: ${action.form.name}`;
      }
      return `${indent}[${tag}] ${action.content || 'Reference a form'}`;

    case 'runtime_judgment':
      return `${indent}[${tag}] ${action.content || 'Use your judgment'}`;

    case 'wait_for_response':
      return `${indent}[${tag}] Wait for response`;

    case 'wait_duration':
      return `${indent}[${tag}] Wait ${action.waitDuration || 0} seconds`;

    default:
      return `${indent}[${action.actionType}] ${action.content || ''}`;
  }
}
