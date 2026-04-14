import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// GET    /api/settings/scripts/[scriptId] — Full script detail
// PUT    /api/settings/scripts/[scriptId] — Update name/description
// DELETE /api/settings/scripts/[scriptId] — Delete script
// ---------------------------------------------------------------------------

const DEEP_INCLUDE = {
  steps: {
    orderBy: { stepNumber: 'asc' as const },
    include: {
      branches: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          actions: {
            orderBy: { sortOrder: 'asc' as const },
            include: {
              voiceNote: {
                select: {
                  id: true,
                  userLabel: true,
                  audioFileUrl: true,
                  durationSeconds: true
                }
              },
              form: {
                include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
              }
            }
          }
        }
      },
      actions: {
        where: { branchId: null },
        orderBy: { sortOrder: 'asc' as const },
        include: {
          voiceNote: {
            select: {
              id: true,
              userLabel: true,
              audioFileUrl: true,
              durationSeconds: true
            }
          },
          form: {
            include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
          }
        }
      }
    }
  },
  forms: {
    include: { fields: { orderBy: { sortOrder: 'asc' as const } } }
  }
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId },
      include: DEEP_INCLUDE
    });

    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    return NextResponse.json(script);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] GET detail error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;
    const body = await req.json();

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    const updated = await prisma.script.update({
      where: { id: scriptId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description })
      },
      include: DEEP_INCLUDE
    });

    return NextResponse.json(updated);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] PUT error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ scriptId: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { scriptId } = await params;

    const script = await prisma.script.findFirst({
      where: { id: scriptId, accountId: auth.accountId }
    });
    if (!script) {
      return NextResponse.json({ error: 'Script not found' }, { status: 404 });
    }

    await prisma.script.delete({ where: { id: scriptId } });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] DELETE error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
