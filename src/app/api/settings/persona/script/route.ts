import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { SCRIPT_ANALYSIS_PROMPT } from '@/lib/persona-breakdown-prompts';
import prisma from '@/lib/prisma';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';

export const maxDuration = 120;

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

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32768,
      messages: [{ role: 'user', content: messageContent }]
    });

    const responseText =
      message.content[0].type === 'text' ? message.content[0].text : '';

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

    // --- Create PersonaBreakdown with nested sections, ambiguities, and script steps ---
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
        },
        ambiguities: {
          create: (parsed.ambiguities || []).map(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (a: any, idx: number) => ({
              question: a.question || '',
              suggestedDefault: a.suggested_default || '',
              orderIndex: idx
            })
          )
        }
      },
      include: {
        sections: { orderBy: { orderIndex: 'asc' } },
        ambiguities: { orderBy: { orderIndex: 'asc' } }
      }
    });

    // --- Create VoiceNoteSlots from LLM detections ---
    const voiceNoteDetections = parsed.voice_note_detections || [];
    const slotIdMap: Record<string, string> = {};

    for (const detection of voiceNoteDetections) {
      // Check for existing slot with same name (preserves audio across re-parses)
      const existingSlot = await prisma.voiceNoteSlot.findFirst({
        where: { accountId: auth.accountId, slotName: detection.slot_name }
      });

      if (existingSlot) {
        // Reuse existing slot — update breakdown reference and trigger condition
        await prisma.voiceNoteSlot.update({
          where: { id: existingSlot.id },
          data: {
            breakdownId: breakdown.id,
            description: detection.description,
            triggerCondition: {
              natural_language: detection.trigger_condition_natural_language,
              structured: detection.trigger_condition_structured
            },
            fallbackText:
              existingSlot.fallbackText || detection.suggested_fallback_text
          }
        });
        slotIdMap[detection.ref_id] = existingSlot.id;
      } else {
        // Create new slot
        const slot = await prisma.voiceNoteSlot.create({
          data: {
            accountId: auth.accountId,
            breakdownId: breakdown.id,
            slotName: detection.slot_name,
            description: detection.description,
            triggerCondition: {
              natural_language: detection.trigger_condition_natural_language,
              structured: detection.trigger_condition_structured
            },
            fallbackText: detection.suggested_fallback_text,
            status: 'EMPTY'
          }
        });
        slotIdMap[detection.ref_id] = slot.id;
      }
    }

    // --- Replace ref_id placeholders with real DB slot IDs in scriptSteps ---
    if (
      Object.keys(slotIdMap).length > 0 &&
      Array.isArray(parsed.script_steps)
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updatedSteps = (parsed.script_steps as any[]).map((step: any) => ({
        ...step,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        branches: (step.branches || []).map((branch: any) => ({
          ...branch,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          actions: (branch.actions || []).map((action: any) => ({
            ...action,
            voice_note_slot_id: action.voice_note_slot_id
              ? slotIdMap[action.voice_note_slot_id] ||
                action.voice_note_slot_id
              : null
          }))
        }))
      }));

      await prisma.personaBreakdown.update({
        where: { id: breakdown.id },
        data: { scriptSteps: updatedSteps }
      });
    }

    // --- Fetch final breakdown with voice note slots ---
    const finalBreakdown = await prisma.personaBreakdown.findUnique({
      where: { id: breakdown.id },
      include: {
        sections: { orderBy: { orderIndex: 'asc' } },
        ambiguities: { orderBy: { orderIndex: 'asc' } },
        voiceNoteSlots: { orderBy: { createdAt: 'asc' } }
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
        voiceNoteSlots: { orderBy: { createdAt: 'asc' } }
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
