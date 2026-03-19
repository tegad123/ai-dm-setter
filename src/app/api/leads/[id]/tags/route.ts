import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// POST /api/leads/[id]/tags — add a tag to a lead
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId } = await params;
    const body = await req.json();
    const { tagId, appliedBy, confidence } = body;

    if (!tagId) {
      return NextResponse.json({ error: 'tagId is required' }, { status: 400 });
    }

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    // Verify tag belongs to account
    const tag = await prisma.tag.findFirst({
      where: { id: tagId, accountId: auth.accountId }
    });

    if (!tag) {
      return NextResponse.json({ error: 'Tag not found' }, { status: 404 });
    }

    // Upsert — don't error if tag already applied
    const leadTag = await prisma.leadTag.upsert({
      where: { leadId_tagId: { leadId, tagId } },
      update: {
        appliedBy: appliedBy || auth.userId,
        confidence: confidence ?? null
      },
      create: {
        leadId,
        tagId,
        appliedBy: appliedBy || auth.userId,
        confidence: confidence ?? null
      },
      include: { tag: true }
    });

    return NextResponse.json(leadTag, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/leads/[id]/tags error:', error);
    return NextResponse.json({ error: 'Failed to add tag' }, { status: 500 });
  }
}

// DELETE /api/leads/[id]/tags — remove a tag from a lead
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id: leadId } = await params;
    const { searchParams } = req.nextUrl;
    const tagId = searchParams.get('tagId');

    if (!tagId) {
      return NextResponse.json(
        { error: 'tagId query param is required' },
        { status: 400 }
      );
    }

    // Verify lead belongs to account
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, accountId: auth.accountId }
    });

    if (!lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    }

    await prisma.leadTag.deleteMany({
      where: { leadId, tagId }
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/leads/[id]/tags error:', error);
    return NextResponse.json(
      { error: 'Failed to remove tag' },
      { status: 500 }
    );
  }
}
