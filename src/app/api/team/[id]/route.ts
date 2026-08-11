import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { isAssignableTeamRole } from '@/lib/team-roles';
import { NextRequest, NextResponse } from 'next/server';

const userSelectWithoutPassword = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarUrl: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  leadsHandled: true,
  callsBooked: true,
  closeRate: true
} as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const user = await prisma.user.findFirst({
      where: { id, accountId: auth.accountId },
      select: userSelectWithoutPassword
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json(user);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/team/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch team member' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Leak-audit finding 5-1 (CRITICAL): this route previously copied
    // `role` straight from the body with no caller gate and no value
    // allowlist, letting any tenant user self-promote to SUPER_ADMIN and
    // flip isPlatformOperator() — defeating every cross-tenant guard in
    // the app. Same contract as the invite route now: ADMIN-only,
    // allowlisted roles, and nobody edits their own role/isActive.
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can edit team members.' },
        { status: 403 }
      );
    }

    // Verify user belongs to this account
    const existing = await prisma.user.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const body = await req.json();

    if (body.role !== undefined && !isAssignableTeamRole(body.role)) {
      return NextResponse.json(
        { error: `Unsupported role "${String(body.role)}".` },
        { status: 400 }
      );
    }
    if (
      id === auth.userId &&
      (body.role !== undefined || body.isActive !== undefined)
    ) {
      return NextResponse.json(
        { error: 'You cannot change your own role or active status.' },
        { status: 403 }
      );
    }

    const allowedFields = ['name', 'email', 'role', 'isActive'];
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: userSelectWithoutPassword
    });

    return NextResponse.json(user);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PATCH /api/team/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update team member' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    // Same class as finding 5-1: removing teammates is an admin action.
    if (auth.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can remove team members.' },
        { status: 403 }
      );
    }

    // Verify user belongs to this account
    const existing = await prisma.user.findFirst({
      where: { id, accountId: auth.accountId }
    });
    if (!existing) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    await prisma.user.delete({ where: { id } });

    return NextResponse.json({ message: 'Team member removed' });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('DELETE /api/team/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to delete team member' },
      { status: 500 }
    );
  }
}
