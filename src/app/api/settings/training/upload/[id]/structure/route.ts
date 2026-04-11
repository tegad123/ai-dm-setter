import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import Anthropic from '@anthropic-ai/sdk';
import {
  detectConversationBoundaries,
  chunkForLLM,
  hydrateConversations,
  validateConversations
} from '@/lib/training-parser';
import { STRUCTURING_PROMPT } from '@/lib/training-prompts';

export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Structuring metadata — stored in errorMessage field during STRUCTURING
// ---------------------------------------------------------------------------

interface StructuringMeta {
  currentBatch: number;
  totalBatches: number;
}

function parseMeta(raw: string | null): StructuringMeta | null {
  if (!raw || !raw.startsWith('{')) return null;
  try {
    const m = JSON.parse(raw);
    if (
      typeof m.currentBatch === 'number' &&
      typeof m.totalBatches === 'number'
    ) {
      return m;
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// POST — Process ONE batch per call. Client loops until complete.
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const upload = await prisma.trainingUpload.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    if (
      upload.status !== 'AWAITING_CONFIRMATION' &&
      upload.status !== 'FAILED' &&
      upload.status !== 'STRUCTURING'
    ) {
      return NextResponse.json(
        { error: `Upload is in status "${upload.status}"` },
        { status: 400 }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      await prisma.trainingUpload.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: 'ANTHROPIC_API_KEY not configured'
        }
      });
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });
    const rawText = upload.rawText || '';
    const estimatedTokens = Math.ceil(rawText.length / 4);

    // ── Existing meta from a previous call? ────────────────
    let meta = parseMeta(upload.errorMessage);

    // ── FIRST CALL: Prepare batches and return immediately ──
    if (upload.status !== 'STRUCTURING' || !meta) {
      // Clean up any conversations from a previous failed attempt
      await prisma.trainingConversation.deleteMany({ where: { uploadId: id } });

      // Compute batches
      const conversationTexts = detectConversationBoundaries(rawText);
      const batches = chunkForLLM(conversationTexts, 15_000);

      meta = { currentBatch: 0, totalBatches: batches.length };
      await prisma.trainingUpload.update({
        where: { id },
        data: { status: 'STRUCTURING', errorMessage: JSON.stringify(meta) }
      });

      console.log(
        `[training-structure] Initialized: ${batches.length} batch(es) from ${conversationTexts.length} chunk(s)`
      );

      // Return immediately — don't process any batch yet
      return NextResponse.json({
        type: 'processing',
        percent: 3,
        message: `Prepared ${batches.length} batches — starting analysis...`,
        conversationsFound: 0
      });
    }

    // ── PROCESS CURRENT BATCH ──────────────────────────────
    const conversationTexts = detectConversationBoundaries(rawText);
    const batches = chunkForLLM(conversationTexts, 15_000);

    if (meta.currentBatch >= batches.length) {
      // All batches already done — finalize
      return await finalizeFromDb(id, auth.accountId);
    }

    const batchText = batches[meta.currentBatch].join('\n\n---\n\n');
    console.log(
      `[training-structure] Processing batch ${meta.currentBatch + 1}/${meta.totalBatches} (${Math.ceil(batchText.length / 4)} est. tokens)`
    );

    const message = await client.messages
      .stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 32000,
        messages: [
          {
            role: 'user',
            content: `${STRUCTURING_PROMPT}\n\nCONVERSATIONS:\n---\n${batchText}\n---`
          }
        ]
      })
      .finalMessage();

    if (message.stop_reason === 'max_tokens') {
      console.warn(
        `[training-structure] Batch ${meta.currentBatch + 1} output truncated`
      );
    }

    const responseText =
      message.content[0].type === 'text' ? message.content[0].text : '';
    const parsed = parseJsonResponse(responseText);
    const rawConvos = parsed.conversations || [];

    // Hydrate, validate, dedup, save THIS batch
    if (rawConvos.length > 0) {
      const hydrated = hydrateConversations(rawConvos);
      const validation = validateConversations(hydrated);
      const valid = hydrated.filter(
        (_, i) => !validation.errors.some((e) => e.conversationIndex === i)
      );

      if (valid.length > 0) {
        const hashes = valid.map((c) => c.contentHash);
        const existing = await prisma.trainingConversation.findMany({
          where: { accountId: auth.accountId, contentHash: { in: hashes } },
          select: { contentHash: true }
        });
        const existingSet = new Set(existing.map((c) => c.contentHash));
        const newConvos = valid.filter((c) => !existingSet.has(c.contentHash));

        for (const conv of newConvos) {
          await prisma.trainingConversation.create({
            data: {
              uploadId: id,
              accountId: auth.accountId,
              personaId: upload.personaId,
              leadIdentifier: conv.leadIdentifier,
              contentHash: conv.contentHash,
              messageCount: conv.messageCount,
              closerMessageCount: conv.closerMessageCount,
              leadMessageCount: conv.leadMessageCount,
              voiceNoteCount: conv.voiceNoteCount,
              startedAt: conv.startedAt,
              endedAt: conv.endedAt,
              messages: {
                createMany: {
                  data: conv.messages.map((m) => ({
                    sender: m.sender,
                    text: m.text,
                    timestamp: m.timestamp,
                    messageType: m.messageType,
                    orderIndex: m.orderIndex
                  }))
                }
              }
            }
          });
        }
      }
    }

    // Advance batch counter
    meta.currentBatch++;
    const totalSaved = await prisma.trainingConversation.count({
      where: { uploadId: id }
    });

    // Check if all batches are done
    if (meta.currentBatch >= meta.totalBatches) {
      return await finalizeFromDb(id, auth.accountId);
    }

    // More batches to go — save progress
    await prisma.trainingUpload.update({
      where: { id },
      data: { errorMessage: JSON.stringify(meta) }
    });

    const percent =
      5 + Math.round((meta.currentBatch / meta.totalBatches) * 90);

    return NextResponse.json({
      type: 'processing',
      percent,
      message: `Batch ${meta.currentBatch} of ${meta.totalBatches} complete — ${totalSaved} conversations found`,
      conversationsFound: totalSaved
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[training-structure] Error:', errMsg);

    // Don't mark as FAILED for transient errors — keep STRUCTURING status
    // so client retries can resume from the last saved batch.
    // Only mark FAILED for clearly permanent errors (missing API key, etc.)
    const { id } = await params;
    const isPermanent =
      errMsg.includes('API key') ||
      errMsg.includes('authentication') ||
      errMsg.includes('not configured');

    if (isPermanent) {
      try {
        await prisma.trainingUpload.update({
          where: { id },
          data: {
            status: 'FAILED',
            errorMessage: `Structuring failed: ${errMsg}`
          }
        });
      } catch {}
    }

    return NextResponse.json(
      {
        type: 'error',
        error: `Structuring failed: ${errMsg}`,
        message: `Structuring failed: ${errMsg}`
      },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Finalize — mark complete, return all conversations
// ---------------------------------------------------------------------------

async function finalizeFromDb(uploadId: string, accountId: string) {
  const conversations = await prisma.trainingConversation.findMany({
    where: { uploadId },
    orderBy: { startedAt: 'asc' },
    select: {
      id: true,
      leadIdentifier: true,
      outcomeLabel: true,
      messageCount: true,
      closerMessageCount: true,
      leadMessageCount: true,
      voiceNoteCount: true,
      startedAt: true,
      endedAt: true
    }
  });

  await prisma.trainingUpload.update({
    where: { id: uploadId },
    data: {
      status: 'COMPLETE',
      conversationCount: conversations.length,
      errorMessage: null
    }
  });

  console.log(
    `[training-structure] Complete: ${conversations.length} conversations`
  );

  return NextResponse.json({
    type: 'complete',
    upload: {
      id: uploadId,
      status: 'COMPLETE',
      conversationCount: conversations.length
    },
    conversations,
    duplicatesSkipped: 0
  });
}

// ---------------------------------------------------------------------------
// JSON parse helper
// ---------------------------------------------------------------------------

function parseJsonResponse(text: string): {
  conversations: Array<{
    leadIdentifier: string;
    messages: Array<{
      sender: string;
      text: string | null;
      timestamp: string | null;
      messageType: string;
      orderIndex: number;
    }>;
  }>;
} {
  try {
    return JSON.parse(text);
  } catch {}

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }

  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return { conversations: JSON.parse(arrayMatch[0]) };
    } catch {}
  }

  // Truncated JSON recovery
  const salvaged = salvageTruncatedConversations(text);
  if (salvaged.length > 0) {
    console.log(
      `[training-structure] Salvaged ${salvaged.length} conversations from truncated JSON`
    );
    return { conversations: salvaged };
  }

  console.error(
    '[training-structure] Failed to parse LLM response:',
    text.slice(0, 500)
  );
  return { conversations: [] };
}

function salvageTruncatedConversations(text: string): Array<any> {
  const results: Array<any> = [];
  const arrStart = text.indexOf('"conversations"');
  if (arrStart === -1) return results;

  const bracketStart = text.indexOf('[', arrStart);
  if (bracketStart === -1) return results;

  let depth = 0;
  let objStart = -1;

  for (let i = bracketStart + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{' && depth === 0) {
      objStart = i;
      depth = 1;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        try {
          const obj = JSON.parse(text.slice(objStart, i + 1));
          if (obj.leadIdentifier && Array.isArray(obj.messages)) {
            results.push(obj);
          }
        } catch {}
        objStart = -1;
      }
    } else if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
    }
  }

  return results;
}
