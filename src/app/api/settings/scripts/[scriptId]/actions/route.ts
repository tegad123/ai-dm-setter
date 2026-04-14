import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST   /api/settings/scripts/[scriptId]/actions — Create action
// PUT    /api/settings/scripts/[scriptId]/actions — Update action
// DELETE /api/settings/scripts/[scriptId]/actions — Delete action
// ---------------------------------------------------------------------------

const VALID_ACTION_TYPES = [
  'send_message',
  'ask_question',
  'send_voice_note',
  'send_link',
  'send_video',
  'form_reference',
  'runtime_judgment',
  'wait_for_response',
  'wait_duration'
] as const;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    if (!body.actionType || !VALID_ACTION_TYPES.includes(body.actionType)) {
      return NextResponse.json(
        { error: 'Invalid actionType' },
        { status: 400 }
      );
    }
    if (!body.stepId) {
      return NextResponse.json(
        { error: 'stepId is required' },
        { status: 400 }
      );
    }

    // Validate formId belongs to same script
    if (body.formId) {
      const form = await prisma.scriptForm.findFirst({
        where: { id: body.formId, scriptId }
      });
      if (!form) {
        return NextResponse.json(
          { error: 'Form not found in this script' },
          { status: 400 }
        );
      }
    }

    // Validate voiceNoteId belongs to same account
    if (body.voiceNoteId) {
      const vn = await prisma.voiceNoteLibraryItem.findFirst({
        where: { id: body.voiceNoteId, accountId: auth.accountId }
      });
      if (!vn) {
        return NextResponse.json(
          { error: 'Voice note not found' },
          { status: 400 }
        );
      }
    }

    // Get next sort order
    const where = body.branchId
      ? { branchId: body.branchId }
      : { stepId: body.stepId, branchId: null };
    const maxAction = await prisma.scriptAction.findFirst({
      where,
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true }
    });
    const nextOrder = body.sortOrder ?? (maxAction?.sortOrder ?? -1) + 1;

    const action = await prisma.scriptAction.create({
      data: {
        stepId: body.stepId,
        branchId: body.branchId || null,
        actionType: body.actionType,
        content: body.content ?? null,
        voiceNoteId: body.voiceNoteId ?? null,
        linkUrl: body.linkUrl ?? null,
        linkLabel: body.linkLabel ?? null,
        formId: body.formId ?? null,
        waitDuration: body.waitDuration ?? null,
        sortOrder: nextOrder
      },
      include: {
        voiceNote: {
          select: {
            id: true,
            userLabel: true,
            audioFileUrl: true,
            durationSeconds: true
          }
        },
        form: { include: { fields: { orderBy: { sortOrder: 'asc' } } } }
      }
    });

    return NextResponse.json(action, { status: 201 });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/actions] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { actionId, ...data } = body;

    if (!actionId) {
      return NextResponse.json(
        { error: 'actionId is required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    // Validate voiceNoteId if provided
    if (data.voiceNoteId) {
      const vn = await prisma.voiceNoteLibraryItem.findFirst({
        where: { id: data.voiceNoteId, accountId: auth.accountId }
      });
      if (!vn) {
        return NextResponse.json(
          { error: 'Voice note not found' },
          { status: 400 }
        );
      }
    }

    const action = await prisma.scriptAction.update({
      where: { id: actionId },
      data: {
        ...(data.actionType !== undefined && { actionType: data.actionType }),
        ...(data.content !== undefined && { content: data.content }),
        ...(data.voiceNoteId !== undefined && {
          voiceNoteId: data.voiceNoteId
        }),
        ...(data.linkUrl !== undefined && { linkUrl: data.linkUrl }),
        ...(data.linkLabel !== undefined && { linkLabel: data.linkLabel }),
        ...(data.formId !== undefined && { formId: data.formId }),
        ...(data.waitDuration !== undefined && {
          waitDuration: data.waitDuration
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
        ...(data.userConfirmed !== undefined && {
          userConfirmed: data.userConfirmed
        }),
        ...(data.parserStatus !== undefined && {
          parserStatus: data.parserStatus
        })
      },
      include: {
        voiceNote: {
          select: {
            id: true,
            userLabel: true,
            audioFileUrl: true,
            durationSeconds: true
          }
        },
        form: { include: { fields: { orderBy: { sortOrder: 'asc' } } } }
      }
    });

    return NextResponse.json(action);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/actions] PUT error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();
    const { actionId } = body;

    if (!actionId) {
      return NextResponse.json(
        { error: 'actionId is required' },
        { status: 400 }
      );
    }

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.scriptAction.delete({ where: { id: actionId } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts/actions] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
