import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { LeadStatus, Platform } from '@prisma/client';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const status = searchParams.get('status') as LeadStatus | null;
    const platform = searchParams.get('platform') as Platform | null;
    const search = searchParams.get('search');
    const tag = searchParams.get('tag'); // Filter by tag name
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.max(
      1,
      Math.min(100, parseInt(searchParams.get('limit') || '20', 10))
    );
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { accountId: auth.accountId };

    if (status) {
      where.status = status;
    }
    if (platform) {
      where.platform = platform;
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { handle: { contains: search, mode: 'insensitive' } }
      ];
    }
    if (tag) {
      where.tags = {
        some: { tag: { name: tag } }
      };
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: {
          conversation: {
            select: { id: true, aiActive: true, unreadCount: true }
          },
          tags: {
            include: {
              tag: { select: { id: true, name: true, color: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.lead.count({ where })
    ]);

    return NextResponse.json({ leads, total, page, limit });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/leads error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch leads' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const body = await req.json();
    const { name, handle, platform, triggerType, triggerSource, status } = body;

    if (!name || !handle || !platform || !triggerType) {
      return NextResponse.json(
        {
          error: 'Missing required fields: name, handle, platform, triggerType'
        },
        { status: 400 }
      );
    }

    const lead = await prisma.lead.create({
      data: {
        accountId: auth.accountId,
        name,
        handle,
        platform,
        triggerType,
        triggerSource: triggerSource || null,
        status: status || 'NEW_LEAD',
        conversation: {
          create: {
            aiActive: true
          }
        }
      },
      include: {
        conversation: true
      }
    });

    return NextResponse.json(lead, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/leads error:', error);
    return NextResponse.json(
      { error: 'Failed to create lead' },
      { status: 500 }
    );
  }
}
