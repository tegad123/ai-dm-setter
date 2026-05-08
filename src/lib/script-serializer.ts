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
import {
  buildRuntimeJudgmentBlock,
  extractVariableNames,
  parseRuntimeJudgments,
  type RuntimeJudgmentInput
} from '@/lib/runtime-judgment-evaluator';

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

  // R24 — Capital verification inject. We fetch the persona here so
  // the serializer can bake a verification Q + WAIT + JUDGMENT into
  // any "qualified" branch at SCRIPT LEVEL — the LLM follows script
  // sequences reliably; abstract R24 rule text in the Absolute Rules
  // section got ignored in production (Bai Sama / Stan Ley both got
  // routed straight to booking). Putting the gate inside the flow the
  // LLM already follows is the reliable layer. When minimumCapital is
  // null, nothing is prepended — backward compatible.
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId, isActive: true },
    select: {
      minimumCapitalRequired: true,
      capitalVerificationPrompt: true,
      skipR24ScriptInject: true
    }
  });
  const capitalThreshold = persona?.minimumCapitalRequired ?? null;
  const capitalCustomPrompt = persona?.capitalVerificationPrompt ?? null;
  // Operator opt-out for the R24 Layer-1 inject. Set true when the
  // account's script natively asks capital earlier in the flow (e.g.
  // daetradez's v2 restructure asks budget at Step 8 before the
  // booking branches). Without this flag, the inject would prepend a
  // duplicate threshold-confirming question to every "qualified"
  // branch. The code-level gate in ai-engine.ts still runs regardless.
  const skipR24Inject = persona?.skipR24ScriptInject === true;

  const parts: string[] = [];

  // ── Script Framework ──────────────────────────────────────
  const stepLines: string[] = [];

  for (const step of script.steps) {
    stepLines.push('');
    stepLines.push(`Step ${step.stepNumber}: ${step.title}`);
    if (step.objective) {
      stepLines.push(`Objective: ${step.objective}`);
    }
    // Inject the operator-edited canonical question so the LLM sees the
    // exact wording from the script editor (vs. inferring from action
    // content alone). When the operator types a precise question shape
    // into ScriptStep.canonicalQuestion, that wording must reach the
    // prompt verbatim — otherwise the AI improvises a similar question
    // and the operator's intent is lost.
    if (step.canonicalQuestion && step.canonicalQuestion.trim().length > 0) {
      stepLines.push(`Canonical question: ${step.canonicalQuestion.trim()}`);
    }

    if (step.branches.length > 0) {
      for (const branch of step.branches) {
        const condition = branch.conditionDescription
          ? ` (${branch.conditionDescription})`
          : '';
        stepLines.push(`  IF ${branch.branchLabel}${condition}:`);

        // R24 injection: prepend capital verification to any branch
        // whose LABEL or CONDITION references qualification positively
        // ("Lead says they qualified", "When the prospect confirms they
        // qualified", etc.). Skip branches that explicitly say
        // did-not / didn't / not-qualify so we don't double-gate the
        // downsell path.
        const labelText = `${branch.branchLabel} ${branch.conditionDescription || ''}`;
        const isQualifiedBranch =
          /\bqualif/i.test(labelText) &&
          !/(did\s*not|didn'?t|not\s+qualif|no\s+qualif)/i.test(labelText);
        if (
          isQualifiedBranch &&
          typeof capitalThreshold === 'number' &&
          capitalThreshold > 0 &&
          !skipR24Inject
        ) {
          const thresholdStr = `$${capitalThreshold.toLocaleString('en-US')}`;
          const verificationQuestion =
            (capitalCustomPrompt || '').trim() ||
            `sick bro, just to confirm — you got at least ${thresholdStr} in capital ready to start?`;
          stepLines.push(
            `    [ASK] ${verificationQuestion}  (R24 capital verification — ask FIRST, before any action below)`
          );
          stepLines.push(`    [WAIT] Wait for response`);
          stepLines.push(
            `    [JUDGMENT] If the lead confirms clearly (yes / yeah / "I got it" / names an amount >= ${thresholdStr}) → continue with the actions below in this branch. If the lead hedges, admits less, or names an amount BELOW ${thresholdStr} ("kinda", "almost", "about half", "I got $500") → STOP this branch. Jump to the "Lead says they did NOT qualify" branch of this same step and run THAT branch's downsell actions instead. Do NOT send booking-handoff messaging.`
          );
        }

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
  let hasRuntimeMatchActions = false;

  for (const step of script.steps) {
    const allActions = [
      ...step.actions,
      ...step.branches.flatMap((b) => b.actions)
    ];
    for (const action of allActions) {
      if (action.actionType === 'send_voice_note') {
        if (action.bindingMode === 'specific' && action.voiceNote) {
          voiceNotes.push({
            id: action.voiceNote.id,
            label:
              action.voiceNote.userLabel ||
              `Voice Note (Step ${step.stepNumber})`,
            description: action.content || 'Pre-recorded voice note'
          });
        } else if (
          action.bindingMode === 'runtime_match' ||
          !action.voiceNote
        ) {
          hasRuntimeMatchActions = true;
        } else if (action.voiceNote) {
          // Legacy: no explicit bindingMode but has a voiceNote
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
  }

  if (voiceNotes.length > 0 || hasRuntimeMatchActions) {
    const vnLines: string[] = [];
    if (voiceNotes.length > 0) {
      vnLines.push(
        ...voiceNotes.map(
          (vn) =>
            `- ${vn.label} (voice_note_id: ${vn.id}): ${vn.description} [AUDIO READY]`
        )
      );
    }
    if (hasRuntimeMatchActions) {
      vnLines.push(
        `- [RUNTIME MATCH] Some voice note slots will be automatically matched from the library based on conversation context.`
      );
    }
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
  // Two flavours of runtime judgments:
  //   1. Judgments with NO {{variable}} placeholders → kept in the
  //      pre-existing "Runtime Judgment Instructions" block. No behavior
  //      change for these (they were already injected into the prompt
  //      and used as soft guidance).
  //   2. Judgments WITH {{variable}} placeholders → rendered as a
  //      separate "Variable Capture & Behavioral Adaptation" block that
  //      instructs the LLM to populate `captured_data_points` in its
  //      JSON response when the judgment fires AND to pause linear
  //      script advancement to go deeper on the signal.
  // Without this split, judgments like "store as {{early_obstacle}}"
  // were just words in the prompt — the LLM had no schema slot to record
  // the captured value and no directive to react to the signal.
  const judgments: { step: string; instruction: string }[] = [];
  const variableJudgments: RuntimeJudgmentInput[] = [];

  for (const step of script.steps) {
    const directRuntimeActions = step.actions
      .filter((a) => a.actionType === 'runtime_judgment' && a.content)
      .map((a) => ({
        stepNumber: step.stepNumber,
        branchLabel: null,
        content: a.content as string
      }));
    for (const j of directRuntimeActions) {
      variableJudgments.push(j);
      judgments.push({
        step: `Step ${step.stepNumber} (${step.title})`,
        instruction: j.content
      });
    }
    for (const branch of step.branches) {
      const branchRuntimeActions = branch.actions
        .filter((a) => a.actionType === 'runtime_judgment' && a.content)
        .map((a) => ({
          stepNumber: step.stepNumber,
          branchLabel: branch.branchLabel,
          content: a.content as string
        }));
      for (const j of branchRuntimeActions) {
        variableJudgments.push(j);
        judgments.push({
          step: `Step ${step.stepNumber} (${step.title}) — branch "${branch.branchLabel}"`,
          instruction: j.content
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

  const variableBlock = buildRuntimeJudgmentBlock(
    parseRuntimeJudgments(variableJudgments)
  );
  if (variableBlock) {
    parts.push(variableBlock);
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
    bindingMode?: string | null;
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
      // Specific binding: use the bound voice note ID
      if (action.bindingMode === 'specific' && action.voiceNote) {
        return `${indent}[${tag}] Send pre-recorded: ${action.voiceNote.userLabel || 'voice note'} (voice_note_id: ${action.voiceNote.id})`;
      }
      // Runtime match (default): let the context matcher find the best VN
      if (action.bindingMode === 'runtime_match' || !action.voiceNote) {
        return `${indent}[${tag}] ${action.content || 'Send a voice note'} (voice_note_action: runtime_match)`;
      }
      // Legacy fallback: specific VN without explicit bindingMode
      return `${indent}[${tag}] Send pre-recorded: ${action.voiceNote.userLabel || 'voice note'} (voice_note_id: ${action.voiceNote.id})`;

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

// ---------------------------------------------------------------------------
// collectRuntimeJudgmentVariableNames
// ---------------------------------------------------------------------------
// Returns the set of {{variable}} names referenced by ANY runtime_judgment
// action in the account's active Script. Used by ai-engine to render the
// "Prior Captured Signals" prompt block — we only surface keys the script
// itself defines so unrelated structured fields (verifiedCapitalUsd, etc.)
// don't pollute the block.
//
// Returns [] when there is no active script or no runtime_judgment
// actions with variable placeholders.
// ---------------------------------------------------------------------------

export async function collectRuntimeJudgmentVariableNames(
  accountId: string
): Promise<string[]> {
  const script = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    include: {
      steps: {
        include: {
          actions: { where: { branchId: null } },
          branches: { include: { actions: true } }
        }
      }
    }
  });
  if (!script) return [];
  const seen = new Set<string>();
  for (const step of script.steps) {
    const allActions = [
      ...step.actions,
      ...step.branches.flatMap((b) => b.actions)
    ];
    for (const action of allActions) {
      if (action.actionType !== 'runtime_judgment') continue;
      if (typeof action.content !== 'string') continue;
      for (const name of extractVariableNames(action.content)) {
        seen.add(name);
      }
    }
  }
  return Array.from(seen);
}
