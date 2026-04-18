import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import {
  parseScriptMarkdown,
  extractTextFromUpload
} from '@/lib/script-parser';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Deep include (same as other script routes)
// ---------------------------------------------------------------------------

const DEEP_INCLUDE = {
  steps: {
    orderBy: { stepNumber: 'asc' as const },
    include: {
      branches: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          actions: {
            orderBy: { sortOrder: 'asc' as const },
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
                include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
              }
            }
          }
        }
      },
      actions: {
        where: { branchId: null },
        orderBy: { sortOrder: 'asc' as const },
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
            include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
          }
        }
      }
    }
  },
  forms: {
    include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
  }
};

// ---------------------------------------------------------------------------
// Binding key for positional matching
// ---------------------------------------------------------------------------

interface ActionBinding {
  voiceNoteId: string | null;
  linkUrl: string | null;
  linkLabel: string | null;
  formId: string | null;
}

function bindingKey(
  stepNumber: number,
  branchLabel: string,
  sortOrder: number
): string {
  return `${stepNumber}-${branchLabel.toLowerCase().trim()}-${sortOrder}`;
}

// ---------------------------------------------------------------------------
// POST /api/settings/scripts/[scriptId]/reupload
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { text, fileBase64, fileName } = body;

    if (!text && !fileBase64) {
      return NextResponse.json(
        { error: 'Either text or fileBase64 is required.' },
        { status: 400 }
      );
    }

    // Verify script ownership
    const existingScript = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId },
      include: DEEP_INCLUDE
    });

    if (!existingScript) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Extract text
    let scriptText = text || '';
    if (fileBase64 && fileName) {
      const buffer = Buffer.from(fileBase64, 'base64');
      scriptText = await extractTextFromUpload(buffer, fileName);
    }

    if (scriptText.trim().length < 50) {
      return NextResponse.json(
        { error: 'Script text is too short.' },
        { status: 400 }
      );
    }

    // Build bindings map from existing actions (preserve VN, URL, form bindings)
    const bindings = new Map<string, ActionBinding>();
    for (const step of existingScript.steps as any[]) {
      const allActions = [
        ...(step.actions || []),
        ...(step.branches || []).flatMap((b: any) =>
          (b.actions || []).map((a: any) => ({
            ...a,
            _branchLabel: b.branchLabel
          }))
        )
      ];
      for (const action of allActions) {
        const branchLabel = action._branchLabel || 'Default';
        const key = bindingKey(step.stepNumber, branchLabel, action.sortOrder);
        if (action.voiceNoteId || action.linkUrl || action.formId) {
          bindings.set(key, {
            voiceNoteId: action.voiceNoteId,
            linkUrl: action.linkUrl,
            linkLabel: action.linkLabel,
            formId: action.formId
          });
        }
      }
    }

    // Parse new text
    const parsed = await parseScriptMarkdown(auth.accountId, scriptText);

    // Re-create in transaction
    await prisma.$transaction(async (tx) => {
      // Delete all existing steps (cascades to branches + actions)
      await tx.scriptStep.deleteMany({ where: { scriptId } });

      // Keep existing forms — don't delete them (preserve form content)
      // Build form ID map from existing forms
      const existingForms = await tx.scriptForm.findMany({
        where: { scriptId }
      });
      const formIdMap: Record<string, string> = {};
      for (const f of existingForms) {
        formIdMap[f.name] = f.id;
      }

      // Create new forms that don't exist yet
      for (const form of parsed.forms) {
        if (!formIdMap[form.name]) {
          const created = await tx.scriptForm.create({
            data: {
              scriptId,
              name: form.name,
              description: form.description || null
            }
          });
          formIdMap[form.name] = created.id;
        }
      }

      // Re-create steps, branches, actions from new parse
      for (const step of parsed.steps) {
        const createdStep = await tx.scriptStep.create({
          data: {
            scriptId,
            stepNumber: step.stepNumber,
            title: step.title,
            description: null,
            objective: null,
            parserConfidence: step.confidence,
            userConfirmed: false
          }
        });

        for (let bIdx = 0; bIdx < step.branches.length; bIdx++) {
          const branch = step.branches[bIdx];

          const createdBranch = await tx.scriptBranch.create({
            data: {
              stepId: createdStep.id,
              branchLabel: branch.label,
              conditionDescription: branch.conditionDescription,
              sortOrder: bIdx,
              parserConfidence: branch.confidence,
              userConfirmed: false
            }
          });

          if (branch.actions.length > 0) {
            await tx.scriptAction.createMany({
              data: branch.actions.map((action, aIdx) => {
                // Check bindings map for preserved data
                const key = bindingKey(step.stepNumber, branch.label, aIdx);
                const existing = bindings.get(key);

                return {
                  stepId: createdStep.id,
                  branchId: createdBranch.id,
                  actionType: action.actionType,
                  content: action.content,
                  voiceNoteId: existing?.voiceNoteId || null,
                  linkUrl: existing?.linkUrl || action.linkUrl,
                  linkLabel: existing?.linkLabel || action.linkLabel,
                  formId: action.formRefName
                    ? formIdMap[action.formRefName] || existing?.formId || null
                    : existing?.formId || null,
                  waitDuration: action.waitDuration,
                  sortOrder: aIdx,
                  parserConfidence: action.confidence,
                  parserStatus: action.status,
                  userConfirmed: false
                };
              })
            });
          }
        }
      }

      // Update script metadata
      await tx.script.update({
        where: { id: scriptId },
        data: {
          originalUploadText: scriptText,
          lastParsedAt: new Date(),
          parseWarnings:
            parsed.warnings.length > 0 ? parsed.warnings : undefined
        }
      });
    });

    // Fetch refreshed script
    const fullScript = await prisma.script.findUnique({
      where: { id: scriptId },
      include: DEEP_INCLUDE
    });

    return NextResponse.json({
      script: fullScript,
      parseWarnings: parsed.warnings
    });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (
      err?.message?.includes('too short') ||
      err?.message?.includes('No AI provider') ||
      err?.message?.includes('Failed to parse') ||
      err?.message?.includes('failed to return') ||
      err?.message?.includes('could not identify') ||
      err?.message?.includes('no steps') ||
      err?.message?.includes('truncated') ||
      err?.message?.includes('too large to parse')
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error('[scripts/reupload] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
