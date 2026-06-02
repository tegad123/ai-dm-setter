import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { LeadStage, Platform, Prisma } from '@prisma/client';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    // `stage` accepts a single enum (exact match) OR a comma-separated list
    // (matched with `in`). The comma form lets the Leads list reconcile with
    // Analytics: e.g. the "Booked" filter sends the full booked SET
    // (BOOKED,SHOWED,NO_SHOWED,RESCHEDULED,CLOSED_WON) so a lead that
    // progressed past BOOKED to SHOWED still appears — matching the
    // "Booked: 2" the Overview counts.
    const stageRaw = searchParams.get('stage');
    const stageList = stageRaw
      ? (stageRaw.split(',').map((s) => s.trim()).filter(Boolean) as LeadStage[])
      : [];
    const platform = searchParams.get('platform') as Platform | null;
    const search = (
      searchParams.get('search') ?? searchParams.get('q')
    )?.trim();
    const handleSearch = search?.replace(/^@+/, '') ?? '';
    const tag = searchParams.get('tag'); // Filter by tag name
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    // Pipeline Kanban needs a larger ceiling so it can populate every stage
    // column (otherwise the newest 100 leads — typically all NEW_LEAD — drown
    // out the smaller qualified/booked columns). Search stays tight at 50.
    // Stage-filtered board fetches request up to 200 per column.
    const maxLimit = search ? 50 : 1000;
    const limit = Math.max(
      1,
      Math.min(maxLimit, parseInt(searchParams.get('limit') || '20', 10))
    );
    const skip = (page - 1) * limit;

    const where: Prisma.LeadWhereInput = { accountId: auth.accountId };

    if (stageList.length > 0 && !search) {
      where.stage =
        stageList.length === 1 ? stageList[0] : { in: stageList };
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
      // Explicit tag filter — show that tag's leads as-is (incl. cold-pitch if
      // the operator filters by it). This replaces the default exclusion.
      where.tags = {
        some: { tag: { name: tag } }
      };
    } else {
      // Default: exclude cold-pitch so the list total reconciles with the
      // Dashboard / Analytics totals (which all exclude it). Without this the
      // list showed 6773 while Analytics showed 6768 (the 5 cold-pitch leads).
      where.tags = {
        none: { tag: { name: 'cold-pitch' } }
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

    // POLICY (2026-05-06): new conversations are created with AI OFF.
    // The operator must explicitly toggle AI on before the system will
    // auto-respond. awayMode no longer auto-enables AI on new leads.
    const { resolveActivePersonaIdForCreate } = await import(
      '@/lib/active-persona'
    );
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
            aiActive: false
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
