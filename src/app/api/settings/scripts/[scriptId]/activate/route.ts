import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth-guard';
import prisma from '@/lib/prisma';

// ---------------------------------------------------------------------------
// POST /api/settings/scripts/[scriptId]/activate
// Activates this script and deactivates all others for the account.
// ---------------------------------------------------------------------------

export async function POST(
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

    await prisma.$transaction([
      prisma.script.updateMany({
        where: { accountId: auth.accountId, isActive: true },
        data: { isActive: false }
      }),
      prisma.script.update({
        where: { id: scriptId },
        data: { isActive: true }
      })
    ]);

    return NextResponse.json({ success: true, scriptId });
  } catch (err: any) {
    if (err?.statusCode === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[scripts] activate error:', err);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
