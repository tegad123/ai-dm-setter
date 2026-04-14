import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST /api/settings/scripts/[scriptId]/duplicate — Deep clone a script
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;

    const source = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId },
      include: {
        steps: {
          orderBy: { stepNumber: 'asc' },
          include: {
            branches: {
              orderBy: { sortOrder: 'asc' },
              include: { actions: { orderBy: { sortOrder: 'asc' } } }
            },
            actions: {
              where: { branchId: null },
              orderBy: { sortOrder: 'asc' }
            }
          }
        },
        forms: {
          include: { fields: { orderBy: { sortOrder: 'asc' } } }
        }
      }
    });

    if (!source) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Create the clone
    const clone = await prisma.script.create({
      data: {
        accountId: auth.accountId,
        name: `${source.name} (Copy)`,
        description: source.description,
        isActive: false,
        isDefault: false
      }
    });

    // Clone forms first (need IDs for form_reference actions)
    const formIdMap: Record<string, string> = {};
    for (const form of source.forms) {
      const newForm = await prisma.scriptForm.create({
        data: {
          scriptId: clone.id,
          name: form.name,
          description: form.description
        }
      });
      formIdMap[form.id] = newForm.id;
      if (form.fields.length > 0) {
        await prisma.scriptFormField.createMany({
          data: form.fields.map((f) => ({
            formId: newForm.id,
            fieldLabel: f.fieldLabel,
            fieldValue: f.fieldValue,
            sortOrder: f.sortOrder
          }))
        });
      }
    }

    // Clone steps, branches, actions
    for (const step of source.steps) {
      const newStep = await prisma.scriptStep.create({
        data: {
          scriptId: clone.id,
          stepNumber: step.stepNumber,
          title: step.title,
          description: step.description,
          objective: step.objective
        }
      });

      for (const branch of step.branches) {
        const newBranch = await prisma.scriptBranch.create({
          data: {
            stepId: newStep.id,
            branchLabel: branch.branchLabel,
            conditionDescription: branch.conditionDescription,
            sortOrder: branch.sortOrder
          }
        });
        if (branch.actions.length > 0) {
          await prisma.scriptAction.createMany({
            data: branch.actions.map((a) => ({
              stepId: newStep.id,
              branchId: newBranch.id,
              actionType: a.actionType,
              content: a.content,
              voiceNoteId: a.voiceNoteId,
              linkUrl: a.linkUrl,
              linkLabel: a.linkLabel,
              formId: a.formId ? (formIdMap[a.formId] ?? null) : null,
              waitDuration: a.waitDuration,
              sortOrder: a.sortOrder
            }))
          });
        }
      }

      // Direct actions
      if (step.actions.length > 0) {
        await prisma.scriptAction.createMany({
          data: step.actions.map((a) => ({
            stepId: newStep.id,
            branchId: null,
            actionType: a.actionType,
            content: a.content,
            voiceNoteId: a.voiceNoteId,
            linkUrl: a.linkUrl,
            linkLabel: a.linkLabel,
            formId: a.formId ? (formIdMap[a.formId] ?? null) : null,
            waitDuration: a.waitDuration,
            sortOrder: a.sortOrder
          }))
        });
      }
    }

    return NextResponse.json(
      { id: clone.id, name: clone.name },
      { status: 201 }
    );
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] duplicate error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
