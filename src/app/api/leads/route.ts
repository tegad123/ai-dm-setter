import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { LeadStage, Platform, Prisma } from '@prisma/client';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const stage = searchParams.get('stage') as LeadStage | null;
    const platform = searchParams.get('platform') as Platform | null;
    const search = (
      searchParams.get('search') ?? searchParams.get('q')
    )?.trim();
    const handleSearch = search?.replace(/^@+/, '') ?? '';
    const tag = searchParams.get('tag'); // Filter by tag name
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const maxLimit = search ? 50 : 100;
    const limit = Math.max(
      1,
      Math.min(maxLimit, parseInt(searchParams.get('limit') || '20', 10))
    );
    const skip = (page - 1) * limit;

    const where: Prisma.LeadWhereInput = { accountId: auth.accountId };

    if (stage && !search) {
      where.stage = stage;
    }
    if (platform) {
      where.platform = platform;
    }
    if (search) {
      where.OR = [
        { id: { equals: search } },
        { platformUserId: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { handle: { contains: handleSearch || search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        {
          conversation: {
            is: { leadPhone: { contains: search, mode: 'insensitive' } }
          }
        },
        {
          conversation: {
            is: { leadEmail: { contains: search, mode: 'insensitive' } }
          }
        }
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
            select: {
              id: true,
              aiActive: true,
              unreadCount: true,
              lastMessageAt: true,
              outcome: true,
              source: true,
              leadEmail: true,
              leadPhone: true
            }
          },
          tags: {
            include: {
              tag: { select: { id: true, name: true, color: true } }
            }
          }
        },
        orderBy: search
          ? [{ conversation: { lastMessageAt: 'desc' } }, { updatedAt: 'desc' }]
          : { createdAt: 'desc' },
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
    const { name, handle, platform, triggerType, triggerSource, stage } = body;

    if (!name || !handle || !platform || !triggerType) {
      return NextResponse.json(
        {
          error: 'Missing required fields: name, handle, platform, triggerType'
        },
        { status: 400 }
      );
    }

    const [{ resolveActivePersonaIdForCreate }, account] = await Promise.all([
      import('@/lib/active-persona'),
      prisma.account.findUnique({
        where: { id: auth.accountId },
        select: { awayModeInstagram: true, awayModeFacebook: true }
      })
    ]);
    const aiActiveForNew =
      platform === 'INSTAGRAM'
        ? (account?.awayModeInstagram ?? false)
        : platform === 'FACEBOOK'
          ? (account?.awayModeFacebook ?? false)
          : false;
    const personaId = await resolveActivePersonaIdForCreate(auth.accountId);
    const lead = await prisma.lead.create({
      data: {
        accountId: auth.accountId,
        name,
        handle,
        platform,
        triggerType,
        triggerSource: triggerSource || null,
        stage: (stage as any) || 'NEW_LEAD',
        conversation: {
          create: {
            personaId,
            aiActive: aiActiveForNew
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
