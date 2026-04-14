import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';
import { seedDefaultScript } from '@/lib/seed-default-script';

// ---------------------------------------------------------------------------
// GET  /api/settings/scripts — List all scripts for the account
// POST /api/settings/scripts — Create a new script
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

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const scripts = await prisma.script.findMany({
      where: { accountId: auth.accountId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { steps: true } }
      }
    });

    const result = scripts.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      isActive: s.isActive,
      isDefault: s.isDefault,
      stepCount: s._count.steps,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString()
    }));

    return NextResponse.json(result);
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] GET error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();
    const { name, description, fromDefault } = body;

    if (fromDefault) {
      const scriptId = await seedDefaultScript(auth.accountId, prisma as any);
      const script = await prisma.script.findUnique({
        where: { id: scriptId },
        include: DEEP_INCLUDE
      });
      return NextResponse.json(script, { status: 201 });
    }

    // Create blank script with one empty step
    const script = await prisma.script.create({
      data: {
        accountId: auth.accountId,
        name: name || 'New Script',
        description: description || null,
        isActive: false,
        isDefault: false,
        steps: {
          create: {
            stepNumber: 1,
            title: 'Step 1',
            description: '',
            objective: ''
          }
        }
      },
      include: DEEP_INCLUDE
    });

    return NextResponse.json(script, { status: 201 });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] POST error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
