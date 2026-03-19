import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

// GET /api/content/[id] — single content attribution with associated leads
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const content = await prisma.contentAttribution.findFirst({
      where: { id, accountId: auth.accountId },
      include: {
        leads: {
          select: {
            id: true,
            name: true,
            handle: true,
            platform: true,
            status: true,
            qualityScore: true,
            revenue: true,
            bookedAt: true,
            createdAt: true
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!content) {
      return NextResponse.json({ error: 'Content not found' }, { status: 404 });
    }

    return NextResponse.json({ content });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/content/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch content attribution' },
      { status: 500 }
    );
  }
}
