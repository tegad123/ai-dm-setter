import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
// Vercel Blob removed — PDF base64 stored in DB directly
import Anthropic from '@anthropic-ai/sdk';
import { computeFileHash, estimateTokens } from '@/lib/training-parser';
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
    const { pdfBase64, fileName } = body as {
      pdfBase64?: string;
      fileName?: string;
    };

    // ── Validate input ──────────────────────────────────────
    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return NextResponse.json(
        { error: 'pdfBase64 is required' },
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
        error: `Failed to process PDF upload: ${errMsg}`,
        _debug: errStack
      },
      { status: 500 }
    );
  }
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
