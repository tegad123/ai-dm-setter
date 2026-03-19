import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true },
      orderBy: { updatedAt: 'desc' }
    });

    if (!persona) {
      return NextResponse.json({ persona: null });
    }

    return NextResponse.json({ persona });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/settings/persona error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch persona' },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    const body = await req.json();

    const {
      personaName,
      fullName,
      companyName,
      tone,
      systemPrompt,
      qualificationFlow,
      objectionHandling,
      voiceNoteDecisionPrompt,
      qualityScoringPrompt,
      freeValueLink,
      customPhrases,
      promptConfig,
      responseDelayMin,
      responseDelayMax,
      voiceNotesEnabled,
      setupStep,
      setupComplete,
      isActive: isActiveParam
    } = body;

    if (!personaName || !fullName) {
      return NextResponse.json(
        { error: 'Missing required fields: personaName, fullName' },
        { status: 400 }
      );
    }

    // Find existing active persona for this account
    const existing = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId, isActive: true }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {
      personaName,
      fullName,
      companyName: companyName || null,
      tone: tone || null,
      systemPrompt: systemPrompt || 'MASTER_TEMPLATE',
      qualificationFlow: qualificationFlow || undefined,
      objectionHandling: objectionHandling || undefined,
      voiceNoteDecisionPrompt: voiceNoteDecisionPrompt || null,
      qualityScoringPrompt: qualityScoringPrompt || null,
      freeValueLink: freeValueLink || null,
      customPhrases: customPhrases || undefined,
      promptConfig: promptConfig || undefined
    };

    // AI engine settings (optional, only set if provided)
    if (responseDelayMin !== undefined)
      data.responseDelayMin = responseDelayMin;
    if (responseDelayMax !== undefined)
      data.responseDelayMax = responseDelayMax;
    if (voiceNotesEnabled !== undefined)
      data.voiceNotesEnabled = voiceNotesEnabled;
    if (setupStep !== undefined) data.setupStep = setupStep;
    if (setupComplete !== undefined) data.setupComplete = setupComplete;
    if (isActiveParam !== undefined) data.isActive = isActiveParam;

    let persona;
    if (existing) {
      persona = await prisma.aIPersona.update({
        where: { id: existing.id },
        data
      });
    } else {
      persona = await prisma.aIPersona.create({
        data: {
          accountId: auth.accountId,
          ...data
        }
      });
    }

    return NextResponse.json({ persona });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('PUT /api/settings/persona error:', error);
    return NextResponse.json(
      { error: 'Failed to update persona' },
      { status: 500 }
    );
  }
}
