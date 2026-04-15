import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { VOICE_NOTE_LABELING_PROMPT } from '@/lib/voice-note-prompts';

export const maxDuration = 120;

// ---------------------------------------------------------------------------
// POST /api/voice-notes/:id/process
// Run the full processing pipeline: Whisper → LLM labeling → embedding
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Fetch item, validate ownership + status
    const item = await prisma.voiceNoteLibraryItem.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!item) {
      return NextResponse.json(
        { error: 'Voice note not found' },
        { status: 404 }
      );
    }
    if (item.status !== 'PROCESSING') {
      return NextResponse.json(
        { error: `Cannot process item with status ${item.status}` },
        { status: 400 }
      );
    }

    // ── Resolve API keys ──────────────────────────────────────

    let openaiKey = process.env.OPENAI_API_KEY || '';
    try {
      const cred = await getCredentials(auth.accountId, 'OPENAI');
      if (cred?.apiKey) openaiKey = cred.apiKey;
    } catch {
      /* use env fallback */
    }

    let anthropicKey = process.env.ANTHROPIC_API_KEY || '';
    try {
      const cred = await getCredentials(auth.accountId, 'ANTHROPIC');
      if (cred?.apiKey) anthropicKey = cred.apiKey;
    } catch {
      /* use env fallback */
    }

    if (!openaiKey) {
      await prisma.voiceNoteLibraryItem.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage:
            'OpenAI API key required for transcription. Add it in Settings → Integrations.'
        }
      });
      return NextResponse.json(
        { error: 'OpenAI API key not configured' },
        { status: 400 }
      );
    }

    // ── Step 1: Whisper Transcription ─────────────────────────

    let transcript: string;
    try {
      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: openaiKey });

      // Download audio from blob URL
      const audioRes = await fetch(item.audioFileUrl);
      if (!audioRes.ok) throw new Error('Failed to download audio file');
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      // Extract real extension from blob URL (e.g. .m4a, .wav, .webm)
      const urlPath = new URL(item.audioFileUrl).pathname;
      const ext = urlPath.split('.').pop()?.toLowerCase() || 'mp3';
      const mimeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        mp4: 'audio/mp4',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        webm: 'audio/webm',
        flac: 'audio/flac',
        mpeg: 'audio/mpeg',
        mpga: 'audio/mpeg'
      };
      const mimeType = mimeMap[ext] || 'audio/mpeg';

      // Create a File-like object with the correct name + type for Whisper
      const audioFile = new File([audioBuffer], `audio.${ext}`, {
        type: mimeType
      });

      const transcription = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1'
      });

      transcript = transcription.text;

      // Save transcript immediately in case later steps fail
      await prisma.voiceNoteLibraryItem.update({
        where: { id },
        data: { transcript }
      });
    } catch (err) {
      console.error(`[voice-note-process] Whisper failed for ${id}:`, err);
      await prisma.voiceNoteLibraryItem.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: `Transcription failed: ${err instanceof Error ? err.message : 'Unknown error'}`
        }
      });
      return NextResponse.json(
        { error: 'Transcription failed' },
        { status: 500 }
      );
    }

    // ── Step 2: LLM Labeling ──────────────────────────────────

    let summary = '';
    let useCases: string[] = [];
    let leadTypes: string[] = [];
    let conversationStages: string[] = [];
    let emotionalTone = '';
    let triggerConditionsNatural = '';
    let userLabel = '';

    try {
      if (!anthropicKey) throw new Error('Anthropic API key not configured');

      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: anthropicKey });

      const prompt = VOICE_NOTE_LABELING_PROMPT.replace(
        '{{TRANSCRIPT}}',
        transcript
      );

      // Use stream: true to avoid SDK timeout on large requests
      let responseText = '';
      const stream = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      });

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          responseText += event.delta.text;
        }
      }

      // Parse JSON (with regex fallback)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        else throw new Error('Could not parse LLM JSON response');
      }

      summary = parsed.summary || '';
      useCases = Array.isArray(parsed.use_cases) ? parsed.use_cases : [];
      leadTypes = Array.isArray(parsed.lead_types) ? parsed.lead_types : [];
      conversationStages = Array.isArray(parsed.conversation_stages)
        ? parsed.conversation_stages
        : [];
      emotionalTone = parsed.emotional_tone || '';
      triggerConditionsNatural = parsed.trigger_conditions_natural || '';
      userLabel = parsed.suggested_label || '';

      // Parse structured triggers from LLM response
      let triggers = null;
      let triggerDescription = null;
      try {
        if (Array.isArray(parsed.structured_triggers)) {
          const { validateTriggers, generateTriggerDescription } = await import(
            '@/lib/voice-note-triggers'
          );
          triggers = validateTriggers(parsed.structured_triggers);
          triggerDescription = generateTriggerDescription(triggers);
        }
      } catch (triggerErr) {
        console.warn(
          `[voice-note-process] Structured trigger parsing failed for ${id}:`,
          triggerErr
        );
        // Non-fatal: structured triggers are optional
      }

      await prisma.voiceNoteLibraryItem.update({
        where: { id },
        data: {
          summary,
          useCases,
          leadTypes,
          conversationStages,
          emotionalTone,
          triggerConditionsNatural,
          userLabel,
          // Save LLM-generated triggers as suggestions for user approval (Sprint 4)
          // triggers field stays null until user approves via the suggestion panel
          ...(triggers
            ? {
                autoSuggestedTriggers: triggers as unknown as any[],
                suggestionStatus: 'pending'
              }
            : {})
        }
      });
    } catch (err) {
      console.error(`[voice-note-process] LLM labeling failed for ${id}:`, err);
      // Non-fatal: transcript is saved, user can fill metadata manually
    }

    // ── Step 3: Embedding Generation ──────────────────────────

    try {
      const embeddingInput = [
        transcript,
        summary,
        useCases.join(', '),
        triggerConditionsNatural
      ]
        .filter(Boolean)
        .join('\n\n');

      const { default: OpenAI } = await import('openai');
      const openai = new OpenAI({ apiKey: openaiKey });

      const embeddingRes = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: embeddingInput
      });

      const vector = embeddingRes.data[0].embedding;

      await prisma.voiceNoteLibraryItem.update({
        where: { id },
        data: { embeddingVector: vector as unknown as object }
      });
    } catch (err) {
      console.error(`[voice-note-process] Embedding failed for ${id}:`, err);
      // Non-fatal: everything else is saved, embedding can be retried
    }

    // ── Mark as ready for review ──────────────────────────────

    const final = await prisma.voiceNoteLibraryItem.update({
      where: { id },
      data: { status: 'NEEDS_REVIEW' }
    });

    return NextResponse.json({ item: final });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('POST /api/voice-notes/[id]/process error:', err);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}
