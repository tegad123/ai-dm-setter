import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import Anthropic from '@anthropic-ai/sdk';
import { SECTION_REGENERATE_PROMPT } from '@/lib/persona-breakdown-prompts';

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// PUT — Edit an existing section or add a new custom section
// ---------------------------------------------------------------------------

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    const {
      sectionId,
      title,
      content,
      userApproved,
      sectionType,
      sourceExcerpts
    } = body;

    // Verify breakdown belongs to account
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    let section;

    if (!sectionId) {
      // ── Create new custom section ──────────────────────────
      if (!title || !content) {
        return NextResponse.json(
          { error: 'title and content are required for new sections' },
          { status: 400 }
        );
      }

      // Determine next orderIndex
      const maxOrder = await prisma.breakdownSection.aggregate({
        where: { breakdownId: id },
        _max: { orderIndex: true }
      });
      const nextIndex = (maxOrder._max.orderIndex ?? -1) + 1;

      section = await prisma.breakdownSection.create({
        data: {
          breakdownId: id,
          sectionType: sectionType || 'custom',
          title,
          content,
          sourceExcerpts: sourceExcerpts || [],
          userEdited: true,
          userApproved: true,
          orderIndex: nextIndex
        }
      });
    } else {
      // ── Update existing section ────────────────────────────
      // Verify section belongs to this breakdown
      const existing = await prisma.breakdownSection.findFirst({
        where: { id: sectionId, breakdownId: id }
      });

      if (!existing) {
        return NextResponse.json(
          { error: 'Section not found' },
          { status: 404 }
        );
      }

      const updateData: Record<string, unknown> = {};
      if (title !== undefined) updateData.title = title;
      if (content !== undefined) {
        updateData.content = content;
        updateData.userEdited = true;
      }
      if (userApproved !== undefined) updateData.userApproved = userApproved;
      if (sectionType !== undefined) updateData.sectionType = sectionType;
      if (sourceExcerpts !== undefined)
        updateData.sourceExcerpts = sourceExcerpts;

      section = await prisma.breakdownSection.update({
        where: { id: sectionId },
        data: updateData
      });
    }

    return NextResponse.json({ section });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'PUT /api/settings/persona/script/[id]/section error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to update section' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — Remove a section
// ---------------------------------------------------------------------------

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const sectionId = req.nextUrl.searchParams.get('sectionId');
    if (!sectionId) {
      return NextResponse.json(
        { error: 'sectionId query parameter is required' },
        { status: 400 }
      );
    }

    // Verify breakdown belongs to account
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    // Delete section — must match both id and breakdownId
    const deleted = await prisma.breakdownSection.deleteMany({
      where: { id: sectionId, breakdownId: id }
    });

    if (deleted.count === 0) {
      return NextResponse.json({ error: 'Section not found' }, { status: 404 });
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'DELETE /api/settings/persona/script/[id]/section error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to delete section' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST — Regenerate a single section via LLM
// ---------------------------------------------------------------------------

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    const { sectionId, guidance } = body;

    if (!sectionId) {
      return NextResponse.json(
        { error: 'sectionId is required' },
        { status: 400 }
      );
    }

    // Verify breakdown belongs to account
    const breakdown = await prisma.personaBreakdown.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!breakdown) {
      return NextResponse.json(
        { error: 'Breakdown not found' },
        { status: 404 }
      );
    }

    // Verify section belongs to this breakdown
    const existingSection = await prisma.breakdownSection.findFirst({
      where: { id: sectionId, breakdownId: id }
    });

    if (!existingSection) {
      return NextResponse.json({ error: 'Section not found' }, { status: 404 });
    }

    // ── Build LLM prompt ─────────────────────────────────────
    let prompt = `${SECTION_REGENERATE_PROMPT}\n\n`;
    prompt += `SECTION TYPE: ${existingSection.sectionType}\n`;
    prompt += `SECTION TITLE: ${existingSection.title}\n`;
    if (guidance) {
      prompt += `\nUSER GUIDANCE: ${guidance}\n`;
    }
    prompt += `\nFULL SCRIPT:\n---\n${breakdown.sourceText}\n---`;

    // ── Call Claude ───────────────────────────────────────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Anthropic API key not configured' },
        { status: 500 }
      );
    }

    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText =
      message.content[0].type === 'text' ? message.content[0].text : '';

    // ── Parse JSON response ──────────────────────────────────
    const parsed = parseRegenerateResponse(responseText);
    if (!parsed) {
      return NextResponse.json(
        { error: 'Failed to parse LLM response' },
        { status: 500 }
      );
    }

    // ── Update section ───────────────────────────────────────
    const section = await prisma.breakdownSection.update({
      where: { id: sectionId },
      data: {
        title: parsed.title,
        content: parsed.content,
        sourceExcerpts: parsed.source_excerpts || [],
        confidence: parsed.confidence || 'medium',
        userEdited: false,
        userApproved: false
      }
    });

    return NextResponse.json({ section });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error(
      'POST /api/settings/persona/script/[id]/section error:',
      error
    );
    return NextResponse.json(
      { error: 'Failed to regenerate section' },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// JSON parse helper for section regeneration responses
// ---------------------------------------------------------------------------

function parseRegenerateResponse(text: string): {
  section_type: string;
  title: string;
  content: string;
  source_excerpts: string[];
  confidence: string;
} | null {
  // Try direct parse
  try {
    return JSON.parse(text);
  } catch {
    // noop
  }

  // Try extracting JSON object from markdown code block or surrounding text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // noop
    }
  }

  console.error(
    '[section-regenerate] Failed to parse LLM response:',
    text.slice(0, 500)
  );
  return null;
}
