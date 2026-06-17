import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { parseTakeoverThread } from '@/lib/conversation-takeover-parser';
import { importTakeoverMessages } from '@/lib/conversation-takeover-importer';

/** POST /api/leads/[id]/takeover?action=parse|import */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId } = await params;
    const action = req.nextUrl.searchParams.get('action') ?? 'parse';

    // Verify lead belongs to this account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId },
      include: { conversation: { select: { id: true } } }
    });
    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }
    if (!lead.conversation) {
      return NextResponse.json(
        { error: 'Lead has no conversation yet' },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));

    if (action === 'parse') {
      const { rawText } = body as { rawText?: string };
      if (!rawText?.trim()) {
        return NextResponse.json(
          { error: 'rawText is required' },
          { status: 400 }
        );
      }
      const result = await parseTakeoverThread(rawText);
      return NextResponse.json(result);
    }

    if (action === 'import') {
      const { messages } = body as { messages?: unknown[] };
      if (!Array.isArray(messages) || messages.length === 0) {
        return NextResponse.json(
          { error: 'messages array is required' },
          { status: 400 }
        );
      }
      const result = await importTakeoverMessages(
        lead.conversation.id,
        messages as Parameters<typeof importTakeoverMessages>[1]
      );
      return NextResponse.json({ ok: true, ...result });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[takeover]', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
