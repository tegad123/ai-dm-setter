import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { SCRIPT_ANALYSIS_PROMPT } from '@/lib/persona-breakdown-prompts';
import prisma from '@/lib/prisma';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// POST /api/settings/persona/script
// Upload a sales script (PDF/DOCX/TXT/pasted text), run LLM analysis, and
// create a PersonaBreakdown with sections and ambiguities.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { pdfBase64, documentText, fileName } = body;

    // --- Validate input ---
    if (!pdfBase64 && !documentText) {
      return NextResponse.json(
        { error: 'Either pdfBase64 or documentText is required' },
        { status: 400 }
      );
    }

    // --- Find persona (active first, fallback to most recent) ---
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }]
    });

    if (!persona) {
      return NextResponse.json(
        { error: 'No persona found. Please create a persona first.' },
        { status: 404 }
      );
    }

    // --- Extract text from the uploaded file or use provided text ---
    let scriptText: string;

    if (pdfBase64) {
      const buffer = Buffer.from(pdfBase64, 'base64');
      const ext = (fileName || '').toLowerCase().split('.').pop() || '';

      if (ext === 'pdf') {
        const pdfParse = require('pdf-parse');
        const pdfData = await pdfParse(buffer);
        scriptText = pdfData.text;
      } else if (ext === 'docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        scriptText = result.value;
      } else {
        // .txt, .md, or unknown extension — decode as utf-8
        scriptText = buffer.toString('utf-8');
      }
    } else {
      scriptText = documentText;
    }

    // --- Validate text length ---
    if (!scriptText || scriptText.trim().length < 100) {
      return NextResponse.json(
        { error: 'Script text is too short (minimum 100 characters).' },
        { status: 400 }
      );
    }

    // Truncate at 200K characters
    if (scriptText.length > 200_000) {
      scriptText = scriptText.slice(0, 200_000);
    }

    // --- SHA-256 hash for dedup ---
    const sourceScriptHash = createHash('sha256')
      .update(scriptText)
      .digest('hex');

    // --- Archive any existing DRAFT breakdowns for this account ---
    await prisma.personaBreakdown.updateMany({
      where: {
        accountId: auth.accountId,
        status: 'DRAFT'
      },
      data: { status: 'ARCHIVED' }
    });

    // --- Call Claude Sonnet ---
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });

    // Estimate token count (~4 chars per token) and decide on content type
    const estimatedTokens = Math.ceil(scriptText.length / 4);
    const isPdf =
      (fileName || '').toLowerCase().endsWith('.pdf') && !!pdfBase64;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let messageContent: any[];

    if (isPdf && estimatedTokens < 120_000) {
      // Send as native PDF document type for better extraction
      messageContent = [
        {
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: pdfBase64
          }
        },
        { type: 'text', text: SCRIPT_ANALYSIS_PROMPT }
      ];
    } else {
      // Send as text in the prompt
      messageContent = [
        {
          type: 'text',
          text: `${SCRIPT_ANALYSIS_PROMPT}\n\nSALES SCRIPT:\n---\n${scriptText}\n---`
        }
      ];
    }

    // Use explicit stream: true to avoid Anthropic SDK timeout error
    // ("Streaming is required for operations that may take longer than 10 minutes")
    let responseText = '';
    const stream = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16384,
      stream: true,
      messages: [{ role: 'user', content: messageContent }]
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        responseText += event.delta.text;
      }
    }

    // --- Parse JSON response (handle markdown wrapping) ---
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let parsed: any;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        console.error(
          'POST /api/settings/persona/script — failed to parse LLM response:',
          responseText.slice(0, 500)
        );
        return NextResponse.json(
          { error: 'Failed to parse AI response' },
          { status: 500 }
        );
      }
    }

    // --- Validate parsed response structure ---
    if (!parsed.methodology_summary || !Array.isArray(parsed.sections)) {
      return NextResponse.json(
        {
          error:
            'AI response missing required fields (methodology_summary, sections)'
        },
        { status: 500 }
      );
    }

    // --- Convert any legacy ambiguities into structured slots ---
    // The LLM may still output an "ambiguities" array despite being told not to.
    // This conversion layer ensures they become proper ScriptSlot records.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const convertAmbiguitiesToSlots = (ambiguities: any[]): any[] => {
      if (!Array.isArray(ambiguities) || ambiguities.length === 0) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return ambiguities.map((a: any, idx: number) => {
        const q = (a.question || '').toLowerCase();
        const text = a.question || '';
        const suggested = a.suggested_default || '';

        // Detect voice note content questions
        if (
          q.includes('voice note') ||
          q.includes('audio') ||
          q.includes('record')
        ) {
          return {
            slot_type: 'voice_note',
            slot_id: `converted_vn_${idx}`,
            step_id: `unknown`,
            branch_id: null,
            action_id: null,
            detected_name: text
              .replace(/^what .*(?:in|for) the /i, '')
              .replace(/\?.*$/, '')
              .trim()
              .slice(0, 60),
            context_description: text,
            suggested_trigger: null,
            suggested_fallback_text: suggested
          };
        }

        // Detect link/URL/video questions
        if (
          q.includes('url') ||
          q.includes('link') ||
          q.includes('video') ||
          q.includes('page') ||
          q.includes('downsell') ||
          q.includes('youtube') ||
          q.includes('homework') ||
          q.includes('resource') ||
          q.includes('results video') ||
          /\[.*\]/.test(text)
        ) {
          return {
            slot_type: 'link',
            slot_id: `converted_link_${idx}`,
            step_id: `unknown`,
            branch_id: null,
            action_id: null,
            detected_name: text
              .replace(/^what .*(?:is|are) the /i, '')
              .replace(/\?.*$/, '')
              .trim()
              .slice(0, 60),
            link_description: text
          };
        }

        // Detect runtime judgment (personalise, customize, adjust, etc.)
        if (
          q.includes('personali') ||
          q.includes('customiz') ||
          q.includes('adjust based on') ||
          q.includes('use judgment') ||
          q.includes('depending on') ||
          q.includes('tailor') ||
          q.includes('based on the conversation')
        ) {
          return {
            slot_type: 'runtime_judgment',
            slot_id: `converted_rj_${idx}`,
            step_id: `unknown`,
            instruction: text,
            context: suggested
          };
        }

        // Detect form-like questions (FAQ, list, structured data)
        if (
          q.includes('faq') ||
          q.includes('question') ||
          q.includes('list') ||
          q.includes('incomplete') ||
          q.includes('remaining')
        ) {
          return {
            slot_type: 'form',
            slot_id: `converted_form_${idx}`,
            step_id: `unknown`,
            form_schema: {
              fields: [
                {
                  field_id: `field_${idx}_1`,
                  field_type: 'qa_pair',
                  label: text.replace(/\?$/, '').trim().slice(0, 80),
                  placeholder: suggested || 'Enter your answer...',
                  required: false
                }
              ]
            }
          };
        }

        // Default: text gap
        return {
          slot_type: 'text_gap',
          slot_id: `converted_tg_${idx}`,
          step_id: `unknown`,
          branch_id: null,
          action_id: null,
          context_description: text,
          suggested_content: suggested
        };
      });
    };

    // --- Create PersonaBreakdown with nested sections ---
    // Sprint 3: No longer creates ambiguities — slots replace them.
    const breakdown = await prisma.personaBreakdown.create({
      data: {
        accountId: auth.accountId,
        personaId: persona.id,
        sourceScriptHash,
        sourceFileName: fileName || null,
        sourceText: scriptText,
        methodologySummary: parsed.methodology_summary,
        gaps: parsed.gaps || [],
        scriptSteps: parsed.script_steps || [],
        status: 'DRAFT',
        sections: {
          create: (parsed.sections || []).map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (s: any, idx: number) => ({
              sectionType: s.section_type || 'custom',
              title: s.title || `Section ${idx + 1}`,
              content: s.content || '',
              sourceExcerpts: s.source_excerpts || [],
              confidence: s.confidence || 'medium',
              orderIndex: idx
            })
          )
        }
      },
      include: {
        sections: { orderBy: { orderIndex: 'asc' } }
      }
    });

    // --- Create ScriptSlots from parser output (Sprint 3) ---
    // Use parsed.slots if available; otherwise convert any ambiguities to slots
    let parsedSlots =
      Array.isArray(parsed.slots) && parsed.slots.length > 0
        ? parsed.slots
        : convertAmbiguitiesToSlots(parsed.ambiguities || []);

    // Also merge in voice_note_detections if the LLM output them (legacy format)
    if (
      Array.isArray(parsed.voice_note_detections) &&
      parsed.voice_note_detections.length > 0
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vnSlots = parsed.voice_note_detections.map((d: any) => ({
        slot_type: 'voice_note',
        slot_id:
          d.ref_id || `vn_legacy_${Math.random().toString(36).slice(2, 8)}`,
        step_id: d.trigger_condition_structured?.step_id || 'unknown',
        branch_id: d.trigger_condition_structured?.branch_id || null,
        action_id: d.trigger_condition_structured?.action_id || null,
        detected_name: d.slot_name || 'Voice Note',
        context_description: d.description || '',
        suggested_trigger: null,
        suggested_fallback_text: d.suggested_fallback_text || null
      }));
      // Don't duplicate — only add voice note slots not already in parsedSlots
      const existingVnIds = new Set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parsedSlots
          .filter((s: any) => s.slot_type === 'voice_note')
          .map((s: any) => s.slot_id)
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const vn of vnSlots) {
        if (!existingVnIds.has(vn.slot_id)) {
          parsedSlots.push(vn);
        }
      }
    }

    const slotIdMap: Record<string, string> = {};

    for (let idx = 0; idx < parsedSlots.length; idx++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = parsedSlots[idx];
      const slotType = s.slot_type;

      // Build the slot data based on type
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slotData: any = {
        accountId: auth.accountId,
        breakdownId: breakdown.id,
        slotType,
        stepId: s.step_id || '',
        branchId: s.branch_id || null,
        actionId: s.action_id || null,
        detectedName: s.detected_name || null,
        orderIndex: idx,
        status: 'unfilled'
      };

      switch (slotType) {
        case 'voice_note':
          slotData.description = s.context_description || '';
          slotData.suggestedTrigger = s.suggested_trigger || null;
          // Check if an existing library voice note can be auto-bound by name
          // (preserves bindings across re-parses)
          break;

        case 'link':
          slotData.description = s.link_description || s.detected_name || '';
          slotData.linkDescription = s.link_description || '';
          break;

        case 'form':
          slotData.description = `Form: ${(s.form_schema?.fields || []).map((f: { label: string }) => f.label).join(', ')}`;
          slotData.formSchema = s.form_schema || { fields: [] };
          break;

        case 'runtime_judgment':
          slotData.instruction = s.instruction || '';
          slotData.context = s.context || '';
          slotData.description = s.instruction || '';
          slotData.status = 'complete'; // Runtime judgment slots are always "complete"
          break;

        case 'text_gap':
          slotData.description = s.context_description || '';
          slotData.suggestedContent = s.suggested_content || '';
          break;

        default:
          // Unknown slot type — skip
          continue;
      }

      const dbSlot = await prisma.scriptSlot.create({ data: slotData });
      slotIdMap[s.slot_id] = dbSlot.id;
    }

    // --- Also create legacy VoiceNoteSlots for backward compatibility ---
    // This ensures the existing VoiceNoteSlot-based delivery system still works
    // until we fully migrate runtime to ScriptSlot system.
    const voiceNoteSlots = parsedSlots.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s.slot_type === 'voice_note'
    );
    const legacySlotIdMap: Record<string, string> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const detection of voiceNoteSlots) {
      const existingSlot = await prisma.voiceNoteSlot.findFirst({
        where: { accountId: auth.accountId, slotName: detection.detected_name }
      });

      if (existingSlot) {
        await prisma.voiceNoteSlot.update({
          where: { id: existingSlot.id },
          data: {
            breakdownId: breakdown.id,
            description:
              detection.context_description || detection.detected_name,
            triggerCondition: {
              natural_language: detection.context_description || '',
              structured: {
                step_id: detection.step_id,
                branch_id: detection.branch_id,
                action_id: detection.action_id
              }
            },
            fallbackText:
              existingSlot.fallbackText || detection.suggested_fallback_text
          }
        });
        legacySlotIdMap[detection.slot_id] = existingSlot.id;
      } else {
        const slot = await prisma.voiceNoteSlot.create({
          data: {
            accountId: auth.accountId,
            breakdownId: breakdown.id,
            slotName:
              detection.detected_name ||
              `Voice Note ${Object.keys(legacySlotIdMap).length + 1}`,
            description: detection.context_description || '',
            triggerCondition: {
              natural_language: detection.context_description || '',
              structured: {
                step_id: detection.step_id,
                branch_id: detection.branch_id,
                action_id: detection.action_id
              }
            },
            fallbackText: detection.suggested_fallback_text,
            status: 'EMPTY'
          }
        });
        legacySlotIdMap[detection.slot_id] = slot.id;
      }
    }

    // --- Replace slot_id placeholders with real DB IDs in scriptSteps ---
    // Also auto-create link ScriptSlots for any send_link/send_video actions
    // that don't already have a matching slot (belt-and-suspenders guarantee).
    if (Array.isArray(parsed.script_steps)) {
      let autoSlotIdx = 900;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updatedSteps = JSON.parse(
        JSON.stringify(parsed.script_steps)
      ) as any[];

      for (const step of updatedSteps) {
        for (const branch of step.branches || []) {
          for (const action of branch.actions || []) {
            // Map existing slot_id references to real DB IDs
            if (action.slot_id && slotIdMap[action.slot_id]) {
              action.slot_id = slotIdMap[action.slot_id];
            }
            if (action.voice_note_slot_id) {
              action.voice_note_slot_id =
                legacySlotIdMap[action.voice_note_slot_id] ||
                slotIdMap[action.voice_note_slot_id] ||
                action.voice_note_slot_id;
            }

            // Auto-create link slot for send_link/send_video actions without a slot
            if (
              (action.action_type === 'send_link' ||
                action.action_type === 'send_video') &&
              !action.slot_id
            ) {
              const autoSlot = await prisma.scriptSlot.create({
                data: {
                  accountId: auth.accountId,
                  breakdownId: breakdown.id,
                  slotType: 'link',
                  stepId: step.step_id || '',
                  branchId: branch.branch_id || null,
                  actionId: action.action_id || null,
                  detectedName:
                    action.content || `${action.action_type} in ${step.title}`,
                  description: action.content || '',
                  linkDescription: action.content || '',
                  status: 'unfilled',
                  orderIndex: autoSlotIdx++
                }
              });
              action.slot_id = autoSlot.id;
            }

            // Auto-create voice_note slot for send_voice_note actions without a slot
            if (action.action_type === 'send_voice_note' && !action.slot_id) {
              const autoSlot = await prisma.scriptSlot.create({
                data: {
                  accountId: auth.accountId,
                  breakdownId: breakdown.id,
                  slotType: 'voice_note',
                  stepId: step.step_id || '',
                  branchId: branch.branch_id || null,
                  actionId: action.action_id || null,
                  detectedName: action.content || `Voice note in ${step.title}`,
                  description: action.content || '',
                  status: 'unfilled',
                  orderIndex: autoSlotIdx++
                }
              });
              action.slot_id = autoSlot.id;
            }
          }
        }
      }

      await prisma.personaBreakdown.update({
        where: { id: breakdown.id },
        data: { scriptSteps: updatedSteps }
      });
    }

    // --- Fetch final breakdown with all relations ---
    const finalBreakdown = await prisma.personaBreakdown.findUnique({
      where: { id: breakdown.id },
      include: {
        sections: { orderBy: { orderIndex: 'asc' } },
        ambiguities: { orderBy: { orderIndex: 'asc' } },
        voiceNoteSlots: { orderBy: { createdAt: 'asc' } },
        scriptSlots: {
          orderBy: { orderIndex: 'asc' },
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
        }
      }
    });

    return NextResponse.json({ breakdown: finalBreakdown });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('POST /api/settings/persona/script error:', errMsg);
    return NextResponse.json(
      { error: `Failed to analyze script: ${errMsg}` },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/settings/persona/script
// Fetch the current breakdown (latest DRAFT or ACTIVE).
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Prefer ACTIVE over DRAFT; within the same status, prefer most recent
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: {
        accountId: auth.accountId,
        status: { in: ['DRAFT', 'ACTIVE'] }
      },
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      include: {
        sections: { orderBy: { orderIndex: 'asc' } },
        ambiguities: { orderBy: { orderIndex: 'asc' } },
        voiceNoteSlots: { orderBy: { createdAt: 'asc' } },
        scriptSlots: {
          orderBy: { orderIndex: 'asc' },
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
        }
      }
    });

    return NextResponse.json({ breakdown: breakdown || null });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('GET /api/settings/persona/script error:', errMsg);
    return NextResponse.json(
      { error: `Failed to fetch breakdown: ${errMsg}` },
      { status: 500 }
    );
  }
}
