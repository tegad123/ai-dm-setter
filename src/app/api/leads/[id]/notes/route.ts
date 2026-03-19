import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/leads/[id]/notes — list team notes for a lead
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId } = await params;

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId },
      select: { id: true }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const { searchParams } = req.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(
      1,
      Math.min(50, parseInt(searchParams.get('limit') || '20', 10))
    );
    const skip = (page - 1) * limit;

    const [notes, total] = await Promise.all([
      prisma.teamNote.findMany({
        where: { leadId, accountId: auth.accountId },
        include: {
          author: {
            select: { id: true, name: true, role: true, avatarUrl: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.teamNote.count({
        where: { leadId, accountId: auth.accountId }
      })
    ]);

    return NextResponse.json({ notes, total, page, limit });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/leads/[id]/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notes' },
      { status: 500 }
    );
  }
}

// POST /api/leads/[id]/notes — create a team note
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId } = await params;
    const body = await req.json();
    const { content } = body;

    if (!content || typeof content !== 'string' || !content.trim()) {
      return NextResponse.json(
        { error: 'Note content is required' },
        { status: 400 }
      );
    }

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId },
      select: { id: true, name: true }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    const note = await prisma.teamNote.create({
      data: {
        content: content.trim(),
        leadId,
        authorId: auth.userId,
        accountId: auth.accountId
      },
      include: {
        author: {
          select: { id: true, name: true, role: true, avatarUrl: true }
        }
      }
    });

    // Notify team members assigned to this lead (team-wide notification)
    await prisma.notification.create({
      data: {
        accountId: auth.accountId,
        type: 'TEAM_NOTE',
        title: 'New Team Note',
        body: `${auth.name} left a note on ${lead.name}: "${content.trim().slice(0, 80)}${content.trim().length > 80 ? '...' : ''}"`,
        leadId
      }
    });

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/leads/[id]/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to create note' },
      { status: 500 }
    );
  }
}
