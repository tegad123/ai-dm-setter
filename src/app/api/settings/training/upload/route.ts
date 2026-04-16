import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
// Vercel Blob removed — PDF base64 stored in DB directly
import Anthropic from '@anthropic-ai/sdk';
import {
  computeFileHash,
  estimateTokens,
  parseConversationsFromText
} from '@/lib/training-parser';
import { PREFLIGHT_PROMPT } from '@/lib/training-prompts';
import type { PreflightResult } from '@/lib/training-parser';

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// POST — Upload PDF, extract text, run pre-flight check, estimate cost
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const {
      pdfBase64,
      fileName,
      rawText: directText
    } = body as {
      pdfBase64?: string;
      fileName?: string;
      rawText?: string;
    };

    // ── TEXT PASTE FLOW — parse directly, no LLM ────────────
    if (directText && typeof directText === 'string') {
      return handleTextPaste(auth, directText, fileName || 'pasted-text');
    }

    // ── PDF UPLOAD FLOW ─────────────────────────────────────
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return NextResponse.json(
        { error: 'pdfBase64 or rawText is required' },
        { status: 400 }
      );
    }
    if (!fileName || !fileName.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json(
        { error: 'fileName must end with .pdf' },
        { status: 400 }
      );
    }

    // ~4MB limit for base64 (Vercel body limit is 4.5MB)
    const MAX_BASE64_SIZE = 4 * 1024 * 1024;
    if (pdfBase64.length > MAX_BASE64_SIZE) {
      return NextResponse.json(
        { error: 'PDF too large. Maximum file size is ~3MB.' },
        { status: 413 }
      );
    }

    // ── Dedup check ─────────────────────────────────────────
    const fileHash = computeFileHash(pdfBase64);
    const existing = await prisma.trainingUpload.findFirst({
      where: { accountId: auth.accountId, fileHash }
    });
    if (existing && existing.status === 'COMPLETE') {
      return NextResponse.json(
        {
          error: 'This PDF has already been uploaded and processed.',
          existingUploadId: existing.id
        },
        { status: 409 }
      );
    }
    // If a previous upload failed or is pending, delete it so user can retry
    if (existing) {
      await prisma.trainingUpload.delete({ where: { id: existing.id } });
    }

    // ── Get active persona ──────────────────────────────────
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true },
      select: { id: true }
    });
    if (!persona) {
      return NextResponse.json(
        { error: 'No active persona found. Please set up your persona first.' },
        { status: 400 }
      );
    }

    // ── Create upload record (store PDF base64 in DB) ───────
    const buffer = Buffer.from(pdfBase64, 'base64');

    const upload = await prisma.trainingUpload.create({
      data: {
        accountId: auth.accountId,
        personaId: persona.id,
        fileName,
        fileHash,
        blobUrl: `data:pdf:${fileName}`, // placeholder — PDF stored in pdfBase64 field
        pdfBase64,
        status: 'EXTRACTING'
      }
    });

    // ── Extract text from PDF ───────────────────────────────
    let rawText: string;
    try {
      // pdf-parse v1 uses CommonJS default export
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(buffer);
      rawText = pdfData.text || '';
    } catch (pdfErr: any) {
      console.error('[training-upload] PDF text extraction failed:', pdfErr);
      await prisma.trainingUpload.update({
        where: { id: upload.id },
        data: {
          status: 'FAILED',
          errorMessage: `PDF text extraction failed: ${pdfErr?.message || 'Unknown error'}`
        }
      });
      return NextResponse.json(
        {
          error: 'Failed to extract text from PDF. The file may be corrupted.'
        },
        { status: 422 }
      );
    }

    if (rawText.trim().length < 50) {
      await prisma.trainingUpload.update({
        where: { id: upload.id },
        data: {
          status: 'FAILED',
          errorMessage: 'PDF contains very little or no readable text'
        }
      });
      return NextResponse.json(
        {
          error:
            'PDF contains very little or no readable text. It may be image-based — please use a text-based export.'
        },
        { status: 422 }
      );
    }

    // Store raw text for later use
    await prisma.trainingUpload.update({
      where: { id: upload.id },
      data: { rawText }
    });

    // ── Pre-flight check via Claude Haiku ────────────────────
    let preflight: PreflightResult;
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

      const client = new Anthropic({ apiKey });
      const sample = rawText.slice(0, 2000);

      const message = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: `${PREFLIGHT_PROMPT}\n\nDOCUMENT (first 2000 chars):\n---\n${sample}\n---`
          }
        ]
      });

      const responseText =
        message.content[0].type === 'text' ? message.content[0].text : '';

      try {
        preflight = JSON.parse(responseText);
      } catch {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        preflight = jsonMatch
          ? JSON.parse(jsonMatch[0])
          : {
              isConversationExport: false,
              reason: 'Failed to parse pre-flight response',
              estimatedConversations: 0,
              closerName: null
            };
      }
    } catch (llmErr: any) {
      console.error('[training-upload] Pre-flight LLM call failed:', llmErr);
      // Non-fatal — proceed with a permissive default
      preflight = {
        isConversationExport: true,
        reason: 'Pre-flight check skipped (LLM error)',
        estimatedConversations: 0,
        closerName: null
      };
    }

    if (!preflight.isConversationExport) {
      await prisma.trainingUpload.update({
        where: { id: upload.id },
        data: {
          status: 'PREFLIGHT_FAILED',
          errorMessage: preflight.reason
        }
      });
      return NextResponse.json(
        {
          upload: { id: upload.id, status: 'PREFLIGHT_FAILED', fileName },
          preflight: { passed: false, ...preflight }
        },
        { status: 200 }
      );
    }

    // ── Token estimation ────────────────────────────────────
    const estimate = estimateTokens(rawText);

    await prisma.trainingUpload.update({
      where: { id: upload.id },
      data: {
        status: 'AWAITING_CONFIRMATION',
        tokenEstimate: estimate.inputTokens,
        conversationCount: preflight.estimatedConversations || null
      }
    });

    // ── Return result ───────────────────────────────────────
    const updatedUpload = await prisma.trainingUpload.findUnique({
      where: { id: upload.id },
      select: {
        id: true,
        fileName: true,
        status: true,
        tokenEstimate: true,
        conversationCount: true,
        createdAt: true
      }
    });

    return NextResponse.json({
      upload: updatedUpload,
      preflight: { passed: true, ...preflight },
      estimate
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack =
      error instanceof Error
        ? error.stack?.split('\n').slice(0, 3).join(' | ')
        : '';
    console.error(
      'POST /api/settings/training/upload error:',
      errMsg,
      errStack
    );
    return NextResponse.json(
      {
        error: `Failed to process upload: ${errMsg}`,
        _debug: errStack
      },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Text paste handler — no LLM, pure rule-based parsing
// ---------------------------------------------------------------------------

async function handleTextPaste(
  auth: { accountId: string },
  rawText: string,
  fileName: string
) {
  if (rawText.trim().length < 50) {
    return NextResponse.json(
      {
        error: 'Text is too short. Please paste the full conversation export.'
      },
      { status: 400 }
    );
  }

  // Dedup via text hash
  const crypto = await import('crypto');
  const fileHash = crypto.createHash('sha256').update(rawText).digest('hex');

  const existing = await prisma.trainingUpload.findFirst({
    where: { accountId: auth.accountId, fileHash }
  });
  if (existing && existing.status === 'COMPLETE') {
    return NextResponse.json(
      {
        error: 'This text has already been uploaded and processed.',
        existingUploadId: existing.id
      },
      { status: 409 }
    );
  }
  if (existing) {
    await prisma.trainingConversation.deleteMany({
      where: { uploadId: existing.id }
    });
    await prisma.trainingUpload.delete({ where: { id: existing.id } });
  }

  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: auth.accountId, isActive: true },
    select: { id: true }
  });
  if (!persona) {
    return NextResponse.json(
      { error: 'No active persona found. Please set up your persona first.' },
      { status: 400 }
    );
  }

  // Parse conversations using rule-based parser (no LLM!)
  const parsed = parseConversationsFromText(rawText);
  console.log(
    `[training-upload] Text paste: parsed ${parsed.length} conversations from ${rawText.length} chars`
  );

  if (parsed.length === 0) {
    return NextResponse.json(
      {
        error:
          'Could not detect any conversations in the pasted text. Supported formats: Instagram PDF export (with timestamps), or labeled format ([YOU]/[LEAD] with ## CONVERSATION headers).'
      },
      { status: 422 }
    );
  }

  // Create upload record
  const upload = await prisma.trainingUpload.create({
    data: {
      accountId: auth.accountId,
      personaId: persona.id,
      fileName,
      fileHash,
      blobUrl: 'text:paste',
      rawText,
      status: 'STRUCTURING'
    }
  });

  // Save conversations to DB (dedup against existing conversations in the account)
  const saved: Array<any> = [];
  const hashes = parsed.map((c) => c.contentHash);
  const existingConvos = await prisma.trainingConversation.findMany({
    where: { accountId: auth.accountId, contentHash: { in: hashes } },
    select: { contentHash: true }
  });
  const existingSet = new Set(existingConvos.map((c) => c.contentHash));
  const newConvos = parsed.filter((c) => !existingSet.has(c.contentHash));

  console.log(
    `[training-upload] Dedup: ${parsed.length} parsed, ${existingSet.size} already exist, ${newConvos.length} new to save`
  );

  for (const conv of newConvos) {
    const created = await prisma.trainingConversation.create({
      data: {
        uploadId: upload.id,
        accountId: auth.accountId,
        personaId: persona.id,
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
    saved.push(created);
  }

  // Mark complete
  await prisma.trainingUpload.update({
    where: { id: upload.id },
    data: {
      status: 'COMPLETE',
      conversationCount: saved.length,
      tokenEstimate: Math.ceil(rawText.length / 4),
      errorMessage: null
    }
  });

  console.log(
    `[training-upload] Text paste complete: ${saved.length} conversations saved`
  );

  return NextResponse.json({
    upload: {
      id: upload.id,
      fileName,
      status: 'COMPLETE',
      tokenEstimate: Math.ceil(rawText.length / 4),
      conversationCount: saved.length,
      createdAt: new Date().toISOString()
    },
    conversations: saved,
    duplicatesSkipped: parsed.length - newConvos.length
  });
}

// ---------------------------------------------------------------------------
// GET — List uploads for the current account
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const uploads = await prisma.trainingUpload.findMany({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        fileName: true,
        status: true,
        tokenEstimate: true,
        conversationCount: true,
        errorMessage: true,
        createdAt: true,
        conversations: {
          select: {
            id: true,
            leadIdentifier: true,
            outcomeLabel: true,
            messageCount: true,
            closerMessageCount: true,
            leadMessageCount: true,
            voiceNoteCount: true
          }
        }
      }
    });

    return NextResponse.json({ uploads });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/training/upload error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch uploads' },
      { status: 500 }
    );
  }
}
