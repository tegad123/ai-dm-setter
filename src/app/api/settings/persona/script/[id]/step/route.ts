import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import type { ScriptStep, ScriptBranch } from '@/lib/script-framework-types';

// ---------------------------------------------------------------------------
// PUT /api/settings/persona/script/:id/step
// Edit a single script step within the breakdown's scriptSteps JSON.
//
// PERSISTENCE FIX (2026-05-08):
// 1. Auto-set user_approved=true when content/title is edited. The
//    serializer filters by user_approved, so without this flag the
//    operator's edits were silently dropped from the AI prompt.
// 2. Mirror the edit into the relational Script model when an active
//    Script exists for the account. The AI prompt builder
//    (serializeScriptForPrompt) prefers the relational Script over the
//    PersonaBreakdown JSON, so edits to PersonaBreakdown alone never
//    reached the LLM for accounts that had run the script parser. Match
//    by stepNumber + branchLabel + sortOrder. Best-effort: if no match,
//    PersonaBreakdown still has the canonical edit.
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: breakdownId } = await params;
    const body = await req.json();
    const { stepId, title, branches, userApproved } = body as {
      stepId: string;
      title?: string;
      branches?: ScriptBranch[];
      userApproved?: boolean;
    };

    if (!stepId) {
      return NextResponse.json(
        { error: 'stepId is required' },
        { status: 400 }
      );
    }

    // Fetch breakdown
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id: breakdownId, accountId: auth.accountId }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steps = ((breakdown.scriptSteps as any) || []) as ScriptStep[];
    const stepIndex = steps.findIndex((s) => s.step_id === stepId);

    if (stepIndex === -1) {
      return NextResponse.json(
        { error: `Step "${stepId}" not found` },
        { status: 404 }
      );
    }

    // Determine whether this save is a content edit (vs a pure approval
    // toggle). Content edits implicitly approve the step so the AI starts
    // using the new content immediately — operator just edited it, they
    // clearly want it live.
    const isContentEdit = title !== undefined || branches !== undefined;

    // Apply updates
    const updatedStep = { ...steps[stepIndex] };
    if (title !== undefined) updatedStep.title = title;
    if (branches !== undefined) updatedStep.branches = branches;
    if (userApproved !== undefined) {
      updatedStep.user_approved = userApproved;
    } else if (isContentEdit) {
      // Auto-approve on content edit so the serializer's user_approved
      // filter doesn't drop the change.
      updatedStep.user_approved = true;
    }
    if (isContentEdit) {
      updatedStep.user_edited = true;
    }

    const updatedSteps = [...steps];
    updatedSteps[stepIndex] = updatedStep;

    await prisma.personaBreakdown.update({
      where: { id: breakdownId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { scriptSteps: updatedSteps as any }
    });

    // Mirror to the relational Script model so the new
    // serializeScriptForPrompt path (preferred over PersonaBreakdown by
    // ai-prompts.ts) sees the operator's edit. Best-effort — failures
    // here log but don't fail the request.
    let mirrorWarnings: string[] = [];
    if (isContentEdit) {
      try {
        mirrorWarnings = await mirrorEditToRelationalScript(
          auth.accountId,
          updatedStep
        );
      } catch (mirrorErr) {
        console.error(
          '[persona/script/step] Mirror-to-Script failed (non-fatal):',
          mirrorErr
        );
        mirrorWarnings = ['mirror_failed'];
      }
    }

    return NextResponse.json({ step: updatedStep, mirrorWarnings });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('PUT /api/settings/persona/script/[id]/step error:', errMsg);
    return NextResponse.json(
      { error: `Failed to update step: ${errMsg}` },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// mirrorEditToRelationalScript
// ---------------------------------------------------------------------------
// Propagate a PersonaBreakdown step edit into the active relational Script
// model. The AI prompt builder reads the relational Script first (per
// serializeScriptForPrompt in src/lib/script-serializer.ts), so without
// this mirror the operator's edits never reach the LLM for accounts that
// have an active parsed Script.
//
// Mapping strategy:
//   ScriptStep <- step_number  (PersonaBreakdown step.step_number)
//   ScriptBranch <- branchLabel matched against branch.condition (case-
//     insensitive substring on either direction). For "default" branches,
//     uses Script's default branch (branchLabel ~= "default") OR direct
//     step.actions when no branches exist.
//   ScriptAction <- sortOrder within the matched branch (positional).
//
// Returns warnings array describing any rows that couldn't be mirrored
// (e.g., no matching step number, no matching branch label, action count
// mismatch). The caller surfaces these in the response so the UI can show
// "saved, but new-system mirror partial" if present.
// ---------------------------------------------------------------------------

async function mirrorEditToRelationalScript(
  accountId: string,
  updatedStep: ScriptStep
): Promise<string[]> {
  const warnings: string[] = [];

  const activeScript = await prisma.script.findFirst({
    where: { accountId, isActive: true },
    include: {
      steps: {
        include: {
          branches: {
            include: {
              actions: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy: { sortOrder: 'asc' }
          },
          actions: {
            where: { branchId: null },
            orderBy: { sortOrder: 'asc' }
          }
        }
      }
    }
  });

  if (!activeScript) {
    // No active Script — PersonaBreakdown is the canonical store, nothing
    // to mirror.
    return warnings;
  }

  const targetScriptStep = activeScript.steps.find(
    (s) => s.stepNumber === updatedStep.step_number
  );
  if (!targetScriptStep) {
    warnings.push(
      `No relational ScriptStep with stepNumber=${updatedStep.step_number}`
    );
    return warnings;
  }

  // Mirror title
  if (typeof updatedStep.title === 'string') {
    await prisma.scriptStep.update({
      where: { id: targetScriptStep.id },
      data: { title: updatedStep.title, userConfirmed: true }
    });
  }

  // Mirror action content per branch
  if (Array.isArray(updatedStep.branches)) {
    for (const updatedBranch of updatedStep.branches) {
      // Find matching relational branch by label / condition (case-
      // insensitive substring match). Falls back to default-branch action
      // list (step.actions where branchId IS NULL) when no branches exist.
      const updatedBranchKey = (updatedBranch.condition || 'default')
        .toLowerCase()
        .trim();

      let targetActions: typeof targetScriptStep.actions;
      let targetBranchId: string | null = null;

      if (
        targetScriptStep.branches.length === 0 ||
        updatedBranchKey === 'default'
      ) {
        targetActions = targetScriptStep.actions;
      } else {
        const targetBranch = targetScriptStep.branches.find((b) => {
          const label = b.branchLabel.toLowerCase();
          const desc = (b.conditionDescription || '').toLowerCase();
          return (
            label.includes(updatedBranchKey) ||
            updatedBranchKey.includes(label) ||
            desc.includes(updatedBranchKey) ||
            updatedBranchKey.includes(desc)
          );
        });
        if (!targetBranch) {
          warnings.push(
            `No relational ScriptBranch matched "${updatedBranch.condition}" for step ${updatedStep.step_number}`
          );
          continue;
        }
        targetBranchId = targetBranch.id;
        targetActions = targetBranch.actions;
      }

      const updatedActions = updatedBranch.actions || [];
      if (updatedActions.length !== targetActions.length) {
        warnings.push(
          `Action count mismatch on step ${updatedStep.step_number} branch "${updatedBranch.condition}": breakdown=${updatedActions.length} script=${targetActions.length}; mirroring overlap only`
        );
      }
      const overlap = Math.min(updatedActions.length, targetActions.length);
      for (let i = 0; i < overlap; i++) {
        const u = updatedActions[i];
        const t = targetActions[i];
        if (typeof u.content === 'string' && u.content !== t.content) {
          await prisma.scriptAction.update({
            where: { id: t.id },
            data: { content: u.content, userConfirmed: true }
          });
        }
      }
      void targetBranchId;
    }
  }

  return warnings;
}
