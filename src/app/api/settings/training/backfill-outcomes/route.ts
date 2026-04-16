import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { parseConversationsFromText } from '@/lib/training-parser';

// ---------------------------------------------------------------------------
// POST /api/settings/training/backfill-outcomes
// ---------------------------------------------------------------------------
// One-time migration: re-parses raw upload text to extract outcome labels
// for existing conversations that are stuck on UNKNOWN.
// Safe to run multiple times — only updates UNKNOWN conversations.
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // 1. Find all uploads with raw text for this account
    const uploads = await prisma.trainingUpload.findMany({
      where: {
        accountId: auth.accountId,
        rawText: { not: null },
        status: 'COMPLETE'
      },
      select: {
        id: true,
        rawText: true,
        fileName: true
      }
    });

    if (uploads.length === 0) {
      return NextResponse.json({
        message: 'No uploads with raw text found',
        updated: 0
      });
    }

    let totalUpdated = 0;
    let totalSkipped = 0;
    const details: Array<{
      uploadId: string;
      fileName: string;
      updated: number;
      skipped: number;
      matched: number;
    }> = [];

    for (const upload of uploads) {
      if (!upload.rawText) continue;

      // 2. Re-parse the raw text with the updated parser (now extracts outcomeLabel)
      const parsed = parseConversationsFromText(upload.rawText);

      // 3. Load existing UNKNOWN conversations for this upload
      const existingConvos = await prisma.trainingConversation.findMany({
        where: {
          uploadId: upload.id,
          outcomeLabel: 'UNKNOWN'
        },
        select: {
          id: true,
          contentHash: true,
          leadIdentifier: true
        }
      });

      if (existingConvos.length === 0) {
        details.push({
          uploadId: upload.id,
          fileName: upload.fileName,
          updated: 0,
          skipped: 0,
          matched: 0
        });
        continue;
      }

      // 4. Build contentHash → outcomeLabel map from re-parsed data
      const hashToOutcome = new Map<string, string>();
      for (const conv of parsed) {
        if (conv.outcomeLabel !== 'UNKNOWN') {
          hashToOutcome.set(conv.contentHash, conv.outcomeLabel);
        }
      }

      // 5. Match by contentHash and update
      let updated = 0;
      let skipped = 0;
      let matched = 0;

      for (const existing of existingConvos) {
        const outcome = hashToOutcome.get(existing.contentHash);
        if (outcome) {
          matched++;
          await prisma.trainingConversation.update({
            where: { id: existing.id },
            data: { outcomeLabel: outcome as any }
          });
          updated++;
        } else {
          // Try matching by leadIdentifier as fallback
          const byName = parsed.find(
            (p) =>
              p.leadIdentifier === existing.leadIdentifier &&
              p.outcomeLabel !== 'UNKNOWN'
          );
          if (byName) {
            matched++;
            await prisma.trainingConversation.update({
              where: { id: existing.id },
              data: { outcomeLabel: byName.outcomeLabel as any }
            });
            updated++;
          } else {
            skipped++;
          }
        }
      }

      totalUpdated += updated;
      totalSkipped += skipped;
      details.push({
        uploadId: upload.id,
        fileName: upload.fileName,
        updated,
        skipped,
        matched
      });
    }

    console.log(
      `[backfill-outcomes] Updated ${totalUpdated} conversations, skipped ${totalSkipped}`
    );

    return NextResponse.json({
      message: `Backfill complete: ${totalUpdated} conversations updated, ${totalSkipped} could not be matched`,
      totalUpdated,
      totalSkipped,
      uploads: details
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error('[backfill-outcomes] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Backfill failed' },
      { status: 500 }
    );
  }
}
