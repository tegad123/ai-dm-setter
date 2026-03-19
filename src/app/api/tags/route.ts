import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/tags — list all tags for the account
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const tags = await prisma.tag.findMany({
      where: { accountId: auth.accountId },
      include: {
        _count: { select: { leads: true } }
      },
      orderBy: { name: 'asc' }
    });

    const result = tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      isAuto: t.isAuto,
      leadsCount: t._count.leads,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString()
    }));

    return NextResponse.json({ tags: result });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/tags error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch tags' },
      { status: 500 }
    );
  }
}

// POST /api/tags — create a new tag
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { name, color, isAuto } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Tag name is required' },
        { status: 400 }
      );
    }

    // Normalize tag name to UPPER_SNAKE_CASE
    const normalizedName = name
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '_')
      .replace(/[^A-Z0-9_]/g, '');

    if (!normalizedName) {
      return NextResponse.json({ error: 'Invalid tag name' }, { status: 400 });
    }

    // Check for duplicate
    const existing = await prisma.tag.findUnique({
      where: {
        accountId_name: { accountId: auth.accountId, name: normalizedName }
      }
    });

    if (existing) {
      return NextResponse.json(
        { error: `Tag "${normalizedName}" already exists` },
        { status: 409 }
      );
    }

    const tag = await prisma.tag.create({
      data: {
        accountId: auth.accountId,
        name: normalizedName,
        color: color || '#6B7280',
        isAuto: isAuto ?? false
      }
    });

    return NextResponse.json(tag, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/tags error:', error);
    return NextResponse.json(
      { error: 'Failed to create tag' },
      { status: 500 }
    );
  }
}
