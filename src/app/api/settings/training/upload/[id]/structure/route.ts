import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import Anthropic from '@anthropic-ai/sdk';
import {
  detectConversationBoundaries,
  chunkForLLM,
  hydrateConversations,
  validateConversations,
  type ParsedConversation
} from '@/lib/training-parser';
import { STRUCTURING_PROMPT } from '@/lib/training-prompts';

export const maxDuration = 300; // Vercel Pro max — structuring many convos takes time

// ---------------------------------------------------------------------------
// Types for streaming events
// ---------------------------------------------------------------------------

type ProgressEvent = {
  type: 'progress';
  percent: number;
  message: string;
  conversationsFound?: number;
};

type CompleteEvent = {
  type: 'complete';
  upload: { id: string; status: string; conversationCount: number };
  conversations: any[];
  duplicatesSkipped: number;
};

type ErrorEvent = {
  type: 'error';
  message: string;
};

type StreamEvent = ProgressEvent | CompleteEvent | ErrorEvent;

// ---------------------------------------------------------------------------
// POST — Trigger LLM structuring with streaming progress
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // ── Auth & validation (before streaming) ─────────────────
  let auth: { accountId: string };
  try {
    auth = await requireAuth(req);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
      {
        error: `Upload is in status "${upload.status}" — expected "AWAITING_CONFIRMATION" or "FAILED"`
      },
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

  // ── Create streaming response ────────────────────────────
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          // Stream may have been closed
        }
      };

      try {
        // Mark as structuring
        await prisma.trainingUpload.update({
          where: { id },
          data: { status: 'STRUCTURING' }
        });

        send({ type: 'progress', percent: 2, message: 'Preparing...' });

        const client = new Anthropic({ apiKey });
        const rawText = upload.rawText || '';
        const estimatedTokens = Math.ceil(rawText.length / 4);

        let allRawConversations: Array<{
          leadIdentifier: string;
          messages: Array<{
            sender: string;
            text: string | null;
            timestamp: string | null;
            messageType: string;
            orderIndex: number;
          }>;
        }> = [];

        let useNativePdf =
          estimatedTokens < 120_000 && Boolean(upload.pdfBase64);

        // ── Strategy A: Try native PDF ──────────────────────
        if (useNativePdf) {
          try {
            send({
              type: 'progress',
              percent: 5,
              message: 'Analyzing PDF with AI...'
            });

            const message = await client.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 32000,
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'document',
                      source: {
                        type: 'base64',
                        media_type: 'application/pdf',
                        data: upload.pdfBase64!
                      }
                    },
                    { type: 'text', text: STRUCTURING_PROMPT }
                  ]
                }
              ]
            });

            const responseText =
              message.content[0].type === 'text' ? message.content[0].text : '';
            const parsed = parseJsonResponse(responseText);
            allRawConversations = parsed.conversations || [];

            send({
              type: 'progress',
              percent: 85,
              message: `Found ${allRawConversations.length} conversations`,
              conversationsFound: allRawConversations.length
            });
          } catch (pdfErr: any) {
            const msg = pdfErr?.message || '';
            if (
              msg.includes('PDF pages') ||
              msg.includes('pdf') ||
              msg.includes('document')
            ) {
              console.log(
                `[training-structure] Native PDF failed (${msg}), falling back to chunked text`
              );
              useNativePdf = false;
              send({
                type: 'progress',
                percent: 5,
                message:
                  'PDF too large for direct analysis, switching to text mode...'
              });
            } else {
              throw pdfErr;
            }
          }
        }

        // ── Strategy B: Chunked text ────────────────────────
        if (!useNativePdf) {
          console.log(
            `[training-structure] Using chunked text approach (${estimatedTokens} est. tokens)`
          );

          const conversationTexts = detectConversationBoundaries(rawText);
          // Use smaller batches (25K tokens) so output fits within max_tokens
          const batches = chunkForLLM(conversationTexts, 25_000);
          const totalBatches = batches.length;

          console.log(
            `[training-structure] Split into ${totalBatches} batch(es) from ${conversationTexts.length} chunk(s)`
          );

          send({
            type: 'progress',
            percent: 5,
            message: `Analyzing ${totalBatches} batch${totalBatches > 1 ? 'es' : ''} of conversations...`
          });

          for (let b = 0; b < totalBatches; b++) {
            const batchText = batches[b].join('\n\n---\n\n');
            const batchPercent =
              5 + Math.round(((b + 0.5) / totalBatches) * 80);

            send({
              type: 'progress',
              percent: batchPercent,
              message: `Processing batch ${b + 1} of ${totalBatches}...`,
              conversationsFound: allRawConversations.length
            });

            console.log(
              `[training-structure] Processing batch ${b + 1}/${totalBatches} (${Math.ceil(batchText.length / 4)} est. tokens)`
            );

            const message = await client.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 32000,
              messages: [
                {
                  role: 'user',
                  content: `${STRUCTURING_PROMPT}\n\nCONVERSATIONS:\n---\n${batchText}\n---`
                }
              ]
            });

            if (message.stop_reason === 'max_tokens') {
              console.warn(
                `[training-structure] Batch ${b + 1} output truncated — hit max_tokens`
              );
            }

            const responseText =
              message.content[0].type === 'text' ? message.content[0].text : '';
            const parsed = parseJsonResponse(responseText);
            allRawConversations.push(...(parsed.conversations || []));

            const donePercent = 5 + Math.round(((b + 1) / totalBatches) * 80);
            send({
              type: 'progress',
              percent: donePercent,
              message: `Batch ${b + 1} complete — ${allRawConversations.length} conversations found so far`,
              conversationsFound: allRawConversations.length
            });
          }
        }

        // ── No conversations found ──────────────────────────
        if (allRawConversations.length === 0) {
          await prisma.trainingUpload.update({
            where: { id },
            data: {
              status: 'FAILED',
              errorMessage: 'No conversations found in the PDF'
            }
          });
          send({
            type: 'error',
            message: 'No conversations could be extracted from this PDF.'
          });
          controller.close();
          return;
        }

        // ── Hydrate & validate ──────────────────────────────
        send({
          type: 'progress',
          percent: 88,
          message: 'Validating conversations...'
        });

        const conversations = hydrateConversations(allRawConversations);
        const validation = validateConversations(conversations);

        console.log(
          `[training-structure] Validation: ${validation.conversationCount} convos, ` +
            `${validation.errors.length} errors, ${validation.warnings.length} warnings`
        );

        const validConversations = conversations.filter((_, i) => {
          return !validation.errors.some((e) => e.conversationIndex === i);
        });

        if (validConversations.length === 0) {
          await prisma.trainingUpload.update({
            where: { id },
            data: {
              status: 'FAILED',
              errorMessage: `All ${conversations.length} conversations failed validation`
            }
          });
          send({
            type: 'error',
            message: `All ${conversations.length} conversations failed validation.`
          });
          controller.close();
          return;
        }

        // ── Dedup ───────────────────────────────────────────
        send({
          type: 'progress',
          percent: 92,
          message: 'Checking for duplicates...'
        });

        const contentHashes = validConversations.map((c) => c.contentHash);
        const existingConvos = await prisma.trainingConversation.findMany({
          where: {
            accountId: auth.accountId,
            contentHash: { in: contentHashes }
          },
          select: { contentHash: true }
        });
        const existingHashes = new Set(
          existingConvos.map((c) => c.contentHash)
        );
        const newConversations = validConversations.filter(
          (c) => !existingHashes.has(c.contentHash)
        );
        const duplicatesSkipped =
          validConversations.length - newConversations.length;

        // ── Persist ─────────────────────────────────────────
        send({
          type: 'progress',
          percent: 95,
          message: `Saving ${newConversations.length} conversations...`
        });

        const createdConversations = await prisma.$transaction(async (tx) => {
          const results = [];

          for (const conv of newConversations) {
            const convo = await tx.trainingConversation.create({
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
              },
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
            results.push(convo);
          }

          return results;
        });

        // ── Update upload status ────────────────────────────
        await prisma.trainingUpload.update({
          where: { id },
          data: {
            status: 'COMPLETE',
            conversationCount: createdConversations.length
          }
        });

        console.log(
          `[training-structure] Complete: ${createdConversations.length} conversations created, ${duplicatesSkipped} duplicates skipped`
        );

        send({
          type: 'complete',
          upload: {
            id,
            status: 'COMPLETE',
            conversationCount: createdConversations.length
          },
          conversations: createdConversations,
          duplicatesSkipped
        });
      } catch (err: any) {
        console.error('[training-structure] Error:', err);
        const errMsg = err?.message || 'Unknown error';
        try {
          await prisma.trainingUpload.update({
            where: { id },
            data: {
              status: 'FAILED',
              errorMessage: `Structuring failed: ${errMsg}`
            }
          });
        } catch {
          // DB update may fail if already in terminal state
        }
        send({ type: 'error', message: `Structuring failed: ${errMsg}` });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
  });
}

// ---------------------------------------------------------------------------
// JSON parse helper — handles clean JSON and markdown-wrapped JSON
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
  closerName?: string;
} {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  // Try extracting JSON from markdown code block
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // noop
    }
  }

  // Try extracting JSON array
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const arr = JSON.parse(arrayMatch[0]);
      return { conversations: arr };
    } catch {
      // noop
    }
  }

  // ── Truncated JSON recovery ──────────────────────────────
  // If the LLM hit max_tokens, the JSON is cut off mid-stream.
  // Try to salvage complete conversation objects by finding all
  // {...leadIdentifier...messages:[...]...} blocks.
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

/**
 * Attempts to extract complete conversation objects from truncated JSON.
 * Finds each top-level object boundary within a "conversations" array.
 */
function salvageTruncatedConversations(text: string): Array<any> {
  const results: Array<any> = [];

  // Find the conversations array start
  const arrStart = text.indexOf('"conversations"');
  if (arrStart === -1) return results;

  const bracketStart = text.indexOf('[', arrStart);
  if (bracketStart === -1) return results;

  // Walk through the text finding complete {...} objects
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
        const objStr = text.slice(objStart, i + 1);
        try {
          const obj = JSON.parse(objStr);
          if (obj.leadIdentifier && Array.isArray(obj.messages)) {
            results.push(obj);
          }
        } catch {
          // Incomplete object, skip
        }
        objStart = -1;
      }
    } else if (ch === '"') {
      // Skip string contents to avoid counting braces inside strings
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++; // skip escaped char
        i++;
      }
    }
  }

  return results;
}
