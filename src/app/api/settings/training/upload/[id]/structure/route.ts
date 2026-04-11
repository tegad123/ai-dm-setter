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
// POST — Trigger LLM structuring + validation on an uploaded PDF
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // ── Fetch upload ────────────────────────────────────────
    const upload = await prisma.trainingUpload.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!upload) {
      return NextResponse.json({ error: 'Upload not found' }, { status: 404 });
    }

    if (upload.status !== 'AWAITING_CONFIRMATION') {
      return NextResponse.json(
        {
          error: `Upload is in status "${upload.status}" — expected "AWAITING_CONFIRMATION"`
        },
        { status: 400 }
      );
    }

    // ── Mark as structuring ─────────────────────────────────
    await prisma.trainingUpload.update({
      where: { id },
      data: { status: 'STRUCTURING' }
    });

    // ── Init Anthropic ──────────────────────────────────────
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

    // ── Decide structuring approach ─────────────────────────
    // Native PDF (base64 document type) when feasible, text chunks as fallback
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

    const rawText = upload.rawText || '';
    const estimatedTokens = Math.ceil(rawText.length / 4);

    try {
      if (estimatedTokens < 120_000 && upload.pdfBase64) {
        // ── Strategy A: Send PDF via native document support ──
        console.log(
          `[training-structure] Using native PDF approach (${estimatedTokens} est. tokens)`
        );

        const pdfBase64 = upload.pdfBase64;

        const message = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 16384,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: pdfBase64
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
      } else {
        // ── Strategy B: Chunked text approach ────────────────
        console.log(
          `[training-structure] Using chunked text approach (${estimatedTokens} est. tokens)`
        );

        const conversationTexts = detectConversationBoundaries(rawText);
        const batches = chunkForLLM(conversationTexts);
        console.log(
          `[training-structure] Split into ${batches.length} batch(es) from ${conversationTexts.length} conversations`
        );

        for (let b = 0; b < batches.length; b++) {
          const batchText = batches[b].join('\n\n---\n\n');
          console.log(
            `[training-structure] Processing batch ${b + 1}/${batches.length} (${Math.ceil(batchText.length / 4)} est. tokens)`
          );

          const message = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 16384,
            messages: [
              {
                role: 'user',
                content: `${STRUCTURING_PROMPT}\n\nCONVERSATIONS:\n---\n${batchText}\n---`
              }
            ]
          });

          const responseText =
            message.content[0].type === 'text' ? message.content[0].text : '';
          const parsed = parseJsonResponse(responseText);
          allRawConversations.push(...(parsed.conversations || []));
        }
      }
    } catch (llmErr: any) {
      console.error('[training-structure] LLM structuring failed:', llmErr);
      await prisma.trainingUpload.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: `LLM structuring failed: ${llmErr?.message || 'Unknown error'}`
        }
      });
      return NextResponse.json(
        { error: 'Failed to structure conversations. Please try again.' },
        { status: 500 }
      );
    }

    if (allRawConversations.length === 0) {
      await prisma.trainingUpload.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorMessage: 'No conversations found in the PDF'
        }
      });
      return NextResponse.json(
        { error: 'No conversations could be extracted from this PDF.' },
        { status: 422 }
      );
    }

    // ── Hydrate with computed fields ────────────────────────
    const conversations = hydrateConversations(allRawConversations);

    // ── Validate ────────────────────────────────────────────
    const validation = validateConversations(conversations);
    console.log(
      `[training-structure] Validation: ${validation.conversationCount} convos, ` +
        `${validation.errors.length} errors, ${validation.warnings.length} warnings`
    );

    // Filter out conversations that have critical errors (no speakers, < 2 messages)
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
      return NextResponse.json(
        { error: 'All conversations failed validation.', validation },
        { status: 422 }
      );
    }

    // ── Dedup against existing conversations ────────────────
    const contentHashes = validConversations.map((c) => c.contentHash);
    const existingConvos = await prisma.trainingConversation.findMany({
      where: {
        accountId: auth.accountId,
        contentHash: { in: contentHashes }
      },
      select: { contentHash: true }
    });
    const existingHashes = new Set(existingConvos.map((c) => c.contentHash));
    const newConversations = validConversations.filter(
      (c) => !existingHashes.has(c.contentHash)
    );
    const duplicatesSkipped =
      validConversations.length - newConversations.length;

    // ── Persist to database ─────────────────────────────────
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

    // ── Update upload status ────────────────────────────────
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

    return NextResponse.json({
      upload: {
        id,
        status: 'COMPLETE',
        conversationCount: createdConversations.length
      },
      conversations: createdConversations,
      validation,
      duplicatesSkipped
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'POST /api/settings/training/upload/[id]/structure error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to structure conversations' },
      { status: 500 }
    );
  }
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

  console.error(
    '[training-structure] Failed to parse LLM response:',
    text.slice(0, 500)
  );
  return { conversations: [] };
}
