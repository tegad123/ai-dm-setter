import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// PUT /api/settings/persona/script/[id]/slot
// Update a ScriptSlot — fill URL, bind voice note, fill form, fill text gap
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: breakdownId } = await params;
    const body = await req.json();
    const { slotId, action } = body;

    if (!slotId || !action) {
      return NextResponse.json(
        { error: 'slotId and action are required' },
        { status: 400 }
      );
    }

    // Verify ownership
    const slot = await prisma.scriptSlot.findFirst({
      where: { id: slotId, breakdownId, accountId: auth.accountId }
    });

    if (!slot) {
      return NextResponse.json({ error: 'Slot not found' }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = {};

    switch (action) {
      // ── Fill a link slot with a URL ──────────────────────────────
      case 'fill_url': {
        if (slot.slotType !== 'link') {
          return NextResponse.json(
            { error: 'This slot is not a link slot' },
            { status: 400 }
          );
        }
        const { url } = body;
        if (!url || typeof url !== 'string') {
          return NextResponse.json(
            { error: 'url is required' },
            { status: 400 }
          );
        }
        updateData.url = url.trim();
        updateData.status = 'filled';
        break;
      }

      // ── Clear a link slot URL ────────────────────────────────────
      case 'clear_url': {
        if (slot.slotType !== 'link') {
          return NextResponse.json(
            { error: 'This slot is not a link slot' },
            { status: 400 }
          );
        }
        updateData.url = null;
        updateData.status = 'unfilled';
        break;
      }

      // ── Bind a library voice note to a voice_note slot ──────────
      case 'bind_voice_note': {
        if (slot.slotType !== 'voice_note') {
          return NextResponse.json(
            { error: 'This slot is not a voice note slot' },
            { status: 400 }
          );
        }
        const { voiceNoteId } = body;
        if (!voiceNoteId) {
          return NextResponse.json(
            { error: 'voiceNoteId is required' },
            { status: 400 }
          );
        }
        // Verify the voice note exists and belongs to this account
        const voiceNote = await prisma.voiceNoteLibraryItem.findFirst({
          where: { id: voiceNoteId, accountId: auth.accountId }
        });
        if (!voiceNote) {
          return NextResponse.json(
            { error: 'Voice note not found' },
            { status: 404 }
          );
        }

        updateData.boundVoiceNoteId = voiceNoteId;
        updateData.status = 'bound';

        // Also update the voice note's scriptBindings array
        const existingBindings = Array.isArray(voiceNote.scriptBindings)
          ? (voiceNote.scriptBindings as Array<Record<string, unknown>>)
          : [];
        // Check if already bound to this slot
        const alreadyBound = existingBindings.some((b) => b.slot_id === slotId);
        if (!alreadyBound) {
          const newBinding = {
            script_id: breakdownId,
            step_id: slot.stepId,
            branch_id: slot.branchId,
            action_id: slot.actionId,
            slot_id: slotId,
            bound_at: new Date().toISOString()
          };
          await prisma.voiceNoteLibraryItem.update({
            where: { id: voiceNoteId },
            data: {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              scriptBindings: [...existingBindings, newBinding] as any
            }
          });
        }
        break;
      }

      // ── Unbind a voice note from a slot ──────────────────────────
      case 'unbind_voice_note': {
        if (slot.slotType !== 'voice_note') {
          return NextResponse.json(
            { error: 'This slot is not a voice note slot' },
            { status: 400 }
          );
        }
        // Remove the binding from the voice note
        if (slot.boundVoiceNoteId) {
          const voiceNote = await prisma.voiceNoteLibraryItem.findUnique({
            where: { id: slot.boundVoiceNoteId }
          });
          if (voiceNote) {
            const existingBindings = Array.isArray(voiceNote.scriptBindings)
              ? (voiceNote.scriptBindings as Array<Record<string, unknown>>)
              : [];
            const filteredBindings = existingBindings.filter(
              (b) => b.slot_id !== slotId
            );
            await prisma.voiceNoteLibraryItem.update({
              where: { id: voiceNote.id },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: { scriptBindings: filteredBindings as any }
            });
          }
        }
        updateData.boundVoiceNoteId = null;
        updateData.status = 'unfilled';
        break;
      }

      // ── Fill form slot values ────────────────────────────────────
      case 'fill_form': {
        if (slot.slotType !== 'form') {
          return NextResponse.json(
            { error: 'This slot is not a form slot' },
            { status: 400 }
          );
        }
        const { values, formSchema: newFormSchema } = body;
        if (!values || typeof values !== 'object') {
          return NextResponse.json(
            { error: 'values object is required' },
            { status: 400 }
          );
        }
        updateData.formValues = values;

        // Allow schema updates (e.g., adding new Q/A pairs)
        if (newFormSchema && typeof newFormSchema === 'object') {
          updateData.formSchema = newFormSchema;
        }

        // Determine status based on field completion
        const schema = (newFormSchema || slot.formSchema) as {
          fields?: Array<{ field_id: string; required: boolean }>;
        } | null;
        if (schema?.fields) {
          const requiredFields = schema.fields.filter((f) => f.required);
          const allRequiredFilled = requiredFields.every(
            (f) => values[f.field_id] && String(values[f.field_id]).trim()
          );
          const anyFilled = Object.values(values).some(
            (v) => v && String(v).trim()
          );
          if (allRequiredFilled && anyFilled) {
            updateData.status = 'complete';
          } else if (anyFilled) {
            updateData.status = 'partially_filled';
          } else {
            updateData.status = 'unfilled';
          }
        } else {
          updateData.status = 'complete';
        }
        break;
      }

      // ── Fill text gap content ────────────────────────────────────
      case 'fill_text': {
        if (slot.slotType !== 'text_gap') {
          return NextResponse.json(
            { error: 'This slot is not a text gap slot' },
            { status: 400 }
          );
        }
        const { content } = body;
        if (content === undefined) {
          return NextResponse.json(
            { error: 'content is required' },
            { status: 400 }
          );
        }
        updateData.userContent = content;
        updateData.status = content && content.trim() ? 'filled' : 'unfilled';
        break;
      }

      // ── Accept AI-suggested content for text gap ─────────────────
      case 'accept_suggestion': {
        if (slot.slotType !== 'text_gap') {
          return NextResponse.json(
            { error: 'This slot is not a text gap slot' },
            { status: 400 }
          );
        }
        updateData.userContent = slot.suggestedContent;
        updateData.status = slot.suggestedContent ? 'filled' : 'unfilled';
        break;
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }

    const updated = await prisma.scriptSlot.update({
      where: { id: slotId },
      data: updateData,
      include: {
        boundVoiceNote: {
          select: {
            id: true,
            userLabel: true,
            audioFileUrl: true,
            durationSeconds: true,
            summary: true
          }
        }
      }
    });

    return NextResponse.json({ slot: updated });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('PUT /api/settings/persona/script/[id]/slot error:', errMsg);
    return NextResponse.json(
      { error: `Failed to update slot: ${errMsg}` },
      { status: 500 }
    );
  }
}
