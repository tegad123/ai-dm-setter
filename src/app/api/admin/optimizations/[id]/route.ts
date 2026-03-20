import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import {
  applyOptimization,
  revertOptimization
} from '@/lib/optimization-engine';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;

    const suggestion = await prisma.optimizationSuggestion.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!suggestion) {
      return NextResponse.json(
        { error: 'Optimization suggestion not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ suggestion });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/optimizations/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch optimization suggestion' },
      { status: 500 }
    );
  }
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['APPLIED'],
  APPLIED: ['REVERTED']
};

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAuth(req);
    const { id } = await params;
    const body = await req.json();

    const { status, adminNotes } = body;

    if (!status) {
      return NextResponse.json(
        { error: 'Missing required field: status' },
        { status: 400 }
      );
    }

    const existing = await prisma.optimizationSuggestion.findFirst({
      where: { id, accountId: auth.accountId }
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Optimization suggestion not found' },
        { status: 404 }
      );
    }

    const allowedNext = ALLOWED_TRANSITIONS[existing.status] || [];
    if (!allowedNext.includes(status)) {
      return NextResponse.json(
        {
          error: `Invalid status transition: ${existing.status} -> ${status}. Allowed: ${allowedNext.join(', ') || 'none'}`
        },
        { status: 400 }
      );
    }

    // Execute side effects for specific transitions
    if (status === 'APPLIED') {
      await applyOptimization(auth.accountId, id);
    } else if (status === 'REVERTED') {
      await revertOptimization(auth.accountId, id);
    }

    const updateData: Record<string, unknown> = { status };
    if (adminNotes !== undefined) {
      updateData.adminNotes = adminNotes;
    }
    if (['APPROVED', 'REJECTED', 'APPLIED', 'REVERTED'].includes(status)) {
      updateData.resolvedAt = new Date();
    }

    const suggestion = await prisma.optimizationSuggestion.update({
      where: { id },
      data: updateData
    });

    return NextResponse.json({ suggestion });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/admin/optimizations/[id] error:', error);
    return NextResponse.json(
      { error: 'Failed to update optimization suggestion' },
      { status: 500 }
    );
  }
}
