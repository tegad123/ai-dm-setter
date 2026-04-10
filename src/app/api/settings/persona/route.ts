import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);

    // Return the most recently updated persona for this account regardless
    // of isActive state. The settings page needs to be able to load drafts
    // that haven't been activated yet — otherwise save → refresh loses the
    // form data because the schema defaults isActive to false on create.
    const persona = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId },
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
      rawScript,
      rawScriptFileName,
      styleAnalysis,
      financialWaterfall,
      knowledgeAssets,
      proofPoints,
      noShowProtocol,
      preCallSequence,
      closerName,
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

    // Find the existing persona for this account — any isActive state.
    // We used to filter by isActive: true here, which caused a nasty bug:
    // the schema defaults isActive to false on create, so the FIRST save
    // would create an inactive persona, then every subsequent save would
    // find `existing = null` (because of the isActive filter) and create
    // ANOTHER inactive row. The settings GET also filtered by isActive so
    // nothing was ever visible on refresh. Now we look up ANY persona for
    // this account and update it in place.
    const existing = await prisma.aIPersona.findFirst({
      where: { accountId: auth.accountId },
      orderBy: { updatedAt: 'desc' }
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
      promptConfig: promptConfig || undefined,
      financialWaterfall: financialWaterfall || undefined,
      knowledgeAssets: knowledgeAssets || undefined,
      proofPoints: proofPoints || undefined,
      noShowProtocol: noShowProtocol || undefined,
      preCallSequence: preCallSequence || undefined,
      closerName: closerName || null
    };

    // Script-first fields (optional, set if provided)
    if (rawScript !== undefined) data.rawScript = rawScript;
    if (rawScriptFileName !== undefined)
      data.rawScriptFileName = rawScriptFileName;
    if (styleAnalysis !== undefined) data.styleAnalysis = styleAnalysis;

    // AI engine settings (optional, only set if provided)
    if (responseDelayMin !== undefined)
      data.responseDelayMin = responseDelayMin;
    if (responseDelayMax !== undefined)
      data.responseDelayMax = responseDelayMax;
    if (voiceNotesEnabled !== undefined)
      data.voiceNotesEnabled = voiceNotesEnabled;
    if (setupStep !== undefined) data.setupStep = setupStep;
    if (setupComplete !== undefined) data.setupComplete = setupComplete;

    // Default to active on save — saving the persona through the settings
    // UI means the user wants this to be THE persona for the account. If
    // the caller explicitly passes isActive, respect that override.
    data.isActive = isActiveParam !== undefined ? isActiveParam : true;

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
