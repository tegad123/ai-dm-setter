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
// POST — Two-call architecture:
//   Call 1: Prepare batches → return immediately
//   Call 2: Process ALL batches with Haiku (parallel) → return complete
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

    const rawText = upload.rawText || '';
    const conversationTexts = detectConversationBoundaries(rawText);
    const batches = chunkForLLM(conversationTexts, 8_000);

    // ── FIRST CALL: Prepare and return immediately ──────────
    if (upload.status !== 'STRUCTURING') {
      await prisma.trainingConversation.deleteMany({ where: { uploadId: id } });

      await prisma.trainingUpload.update({
        where: { id },
        data: { status: 'STRUCTURING', errorMessage: null }
      });

      console.log(
        `[training-structure] Prepared: ${batches.length} batch(es) from ${conversationTexts.length} chunk(s)`
      );

      return NextResponse.json({
        type: 'processing',
        percent: 5,
        message: `Analyzing ${conversationTexts.length} conversations in ${batches.length} batches...`
      });
    }

    // ── SECOND CALL: Process ALL batches sequentially with Haiku ──
    // Disable SDK retries + set short timeout so we see the REAL error
    // instead of the SDK silently retrying until Vercel kills us at 300s
    const client = new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: 45_000 // 45s per call — Haiku should respond in <20s
    });

    // Quick API health check before processing batches
    console.log('[training-structure] Testing API connection...');
    const pingStart = Date.now();
    try {
      const ping = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say ok' }]
      });
      const pingText =
        ping.content[0].type === 'text' ? ping.content[0].text : '?';
      console.log(
        `[training-structure] API OK in ${Date.now() - pingStart}ms: "${pingText}"`
      );
    } catch (pingErr: any) {
      console.error(
        `[training-structure] API FAILED in ${Date.now() - pingStart}ms:`,
        pingErr?.status || '',
        pingErr?.error?.type || '',
        pingErr?.message || String(pingErr)
      );
      throw new Error(
        `Anthropic API error: ${pingErr?.status || ''} ${pingErr?.message || pingErr}`
      );
    }

    const allRawConvos: Array<any> = [];
    let batchesDone = 0;
    let batchesFailed = 0;

    console.log(
      `[training-structure] Processing ${batches.length} batches sequentially`
    );
    const totalStart = Date.now();

    for (let i = 0; i < batches.length; i++) {
      const batchText = batches[i].join('\n\n---\n\n');
      const estTokens = Math.ceil(batchText.length / 4);
      const t0 = Date.now();

      try {
        console.log(
          `[training-structure] Batch ${i + 1}/${batches.length} starting (${estTokens} tokens)`
        );

        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 4096,
          messages: [
            {
              role: 'user',
              content: `${STRUCTURING_PROMPT}\n\nCONVERSATIONS:\n---\n${batchText}\n---`
            }
          ]
        });

        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `[training-structure] Batch ${i + 1}/${batches.length} done in ${elapsed}s (stop: ${msg.stop_reason})`
        );

        const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
        const convos = parseJsonResponse(text).conversations || [];
        allRawConvos.push(...convos);
        batchesDone++;
      } catch (batchErr: any) {
        batchesFailed++;
        console.error(
          `[training-structure] Batch ${i + 1} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s:`,
          batchErr?.status || '',
          batchErr?.error?.type || '',
          batchErr?.message || String(batchErr)
        );
        // Continue to next batch — don't let one failure kill everything
      }
    }

    const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
    console.log(
      `[training-structure] All LLM calls done in ${totalElapsed}s — ${allRawConvos.length} raw conversations (${batchesDone} OK, ${batchesFailed} failed)`
    );

    if (allRawConvos.length === 0) {
      await prisma.trainingUpload.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: 'No conversations could be extracted'
        }
      });
      return NextResponse.json(
        {
          type: 'error',
          error: 'No conversations could be extracted from this PDF',
          message: 'No conversations could be extracted from this PDF'
        },
        { status: 500 }
      );
    }

    // ── Hydrate, validate, dedup ───────────────────────────
    const hydrated = hydrateConversations(allRawConvos);
    const validation = validateConversations(hydrated);
    const valid = hydrated.filter(
      (_, i) => !validation.errors.some((e) => e.conversationIndex === i)
    );

    let savedCount = 0;
    let dupsSkipped = 0;

    if (valid.length > 0) {
      const hashes = valid.map((c) => c.contentHash);
      const existing = await prisma.trainingConversation.findMany({
        where: { accountId: auth.accountId, contentHash: { in: hashes } },
        select: { contentHash: true }
      });
      const existingSet = new Set(existing.map((c) => c.contentHash));
      const newConvos = valid.filter((c) => !existingSet.has(c.contentHash));
      dupsSkipped = valid.length - newConvos.length;

      // Clean up any leftover conversations from a previous partial run
      await prisma.trainingConversation.deleteMany({ where: { uploadId: id } });

      // Save all in a transaction for speed
      const saveStart = Date.now();
      await prisma.$transaction(async (tx) => {
        for (const conv of newConvos) {
          await tx.trainingConversation.create({
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
      });

      savedCount = newConvos.length;
      console.log(
        `[training-structure] Saved ${savedCount} conversations in ${((Date.now() - saveStart) / 1000).toFixed(1)}s`
      );
    }

    // ── Finalize ───────────────────────────────────────────
    const conversations = await prisma.trainingConversation.findMany({
      where: { uploadId: id },
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
      where: { id },
      data: {
        status: 'COMPLETE',
        conversationCount: conversations.length,
        errorMessage: null
      }
    });

    console.log(
      `[training-structure] Complete: ${conversations.length} conversations (${dupsSkipped} duplicates skipped)`
    );

    return NextResponse.json({
      type: 'complete',
      upload: {
        id,
        status: 'COMPLETE',
        conversationCount: conversations.length
      },
      conversations,
      duplicatesSkipped: dupsSkipped
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

    const { id } = await params;
    try {
      await prisma.trainingUpload.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: `Structuring failed: ${errMsg}`
        }
      });
    } catch {}

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
