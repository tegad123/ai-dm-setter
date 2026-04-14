import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import {
  parseScriptMarkdown,
  extractTextFromUpload
} from '@/lib/script-parser';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Deep include for returning full script (same shape as route.ts)
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
// POST /api/settings/scripts/parse — Upload + parse a formatted script
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { text, fileBase64, fileName } = body;

    if (!text && !fileBase64) {
      return NextResponse.json(
        { error: 'Either text or fileBase64 is required.' },
        { status: 400 }
      );
    }

    // Extract text from file if needed
    let scriptText = text || '';
    if (fileBase64 && fileName) {
      const buffer = Buffer.from(fileBase64, 'base64');
      scriptText = await extractTextFromUpload(buffer, fileName);
    }

    if (scriptText.trim().length < 50) {
      return NextResponse.json(
        {
          error: 'Script text is too short. Please check the formatting guide.'
        },
        { status: 400 }
      );
    }

    // Parse
    const parsed = await parseScriptMarkdown(auth.accountId, scriptText);

    // Create DB records in a transaction
    const script = await prisma.$transaction(async (tx) => {
      // 1. Create Script
      const newScript = await tx.script.create({
        data: {
          accountId: auth.accountId,
          name: parsed.name,
          description: null,
          isActive: false,
          isDefault: false,
          createdVia: 'upload_parsed',
          originalUploadText: scriptText,
          lastParsedAt: new Date(),
          parseWarnings:
            parsed.warnings.length > 0 ? parsed.warnings : undefined
        }
      });

      // 2. Create forms first (need IDs for form_reference actions)
      const formIdMap: Record<string, string> = {};
      for (const form of parsed.forms) {
        const created = await tx.scriptForm.create({
          data: {
            scriptId: newScript.id,
            name: form.name,
            description: form.description || null
          }
        });
        formIdMap[form.name] = created.id;

        // Create fields
        if (form.fields.length > 0) {
          await tx.scriptFormField.createMany({
            data: form.fields.map((f, idx) => ({
              formId: created.id,
              fieldLabel: f.fieldLabel,
              fieldValue: f.fieldValue || null,
              sortOrder: idx
            }))
          });
        }
      }

      // 3. Create steps, branches, and actions
      for (const step of parsed.steps) {
        const createdStep = await tx.scriptStep.create({
          data: {
            scriptId: newScript.id,
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

          // Create actions for this branch
          if (branch.actions.length > 0) {
            await tx.scriptAction.createMany({
              data: branch.actions.map((action, aIdx) => ({
                stepId: createdStep.id,
                branchId: createdBranch.id,
                actionType: action.actionType,
                content: action.content,
                voiceNoteId: null,
                linkUrl: action.linkUrl,
                linkLabel: action.linkLabel,
                formId: action.formRefName
                  ? formIdMap[action.formRefName] || null
                  : null,
                waitDuration: action.waitDuration,
                sortOrder: aIdx,
                parserConfidence: action.confidence,
                parserStatus: action.status,
                userConfirmed: false
              }))
            });
          }
        }
      }

      return newScript;
    });

    // Fetch full script with deep include
    const fullScript = await prisma.script.findUnique({
      where: { id: script.id },
      include: DEEP_INCLUDE
    });

    return NextResponse.json(
      { script: fullScript, parseWarnings: parsed.warnings },
      { status: 201 }
    );
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Surface user-friendly parser errors
    if (
      err?.message?.includes('too short') ||
      err?.message?.includes('No AI provider') ||
      err?.message?.includes('Failed to parse') ||
      err?.message?.includes('failed to return') ||
      err?.message?.includes('could not identify') ||
      err?.message?.includes('no steps')
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error('[scripts/parse] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
