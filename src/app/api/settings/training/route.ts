import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';
import { TrainingCategory } from '@prisma/client';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const { searchParams } = req.nextUrl;
    const category = searchParams.get('category') as TrainingCategory | null;

    const where: Record<string, unknown> = { accountId: auth.accountId };
    if (category) {
      where.category = category;
    }

    const examples = await prisma.trainingExample.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        persona: {
          select: { id: true, personaName: true }
        }
      }
    });

    return NextResponse.json({ examples });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/training error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch training examples' },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();

    const { personaId, category, leadMessage, idealResponse, notes } = body;

    if (!personaId || !category || !leadMessage || !idealResponse) {
      return NextResponse.json(
        {
          error:
            'Missing required fields: personaId, category, leadMessage, idealResponse'
        },
        { status: 400 }
      );
    }

    // Validate persona belongs to this account
    const persona = await prisma.aIPersona.findFirst({
      where: { id: personaId, accountId: auth.accountId }
    });
    if (!persona) {
      return NextResponse.json(
        { error: 'Persona not found or does not belong to this account' },
        { status: 404 }
      );
    }

    const example = await prisma.trainingExample.create({
      data: {
        accountId: auth.accountId,
        personaId,
        category,
        leadMessage,
        idealResponse,
        notes: notes || null
      },
      include: {
        persona: {
          select: { id: true, personaName: true }
        }
      }
    });

    return NextResponse.json(example, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('POST /api/settings/training error:', error);
    return NextResponse.json(
      { error: 'Failed to create training example' },
      { status: 500 }
    );
  }
}
