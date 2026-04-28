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

    // Manual join to User for "last edited by" attribution in the editor.
    // We don't model contextUpdatedByUserId as a Prisma relation (see
    // schema.prisma notes), so resolve the display name here. Falls back
    // gracefully if the user was deleted.
    let contextUpdatedByUser: { name: string; email: string } | null = null;
    if (persona.contextUpdatedByUserId) {
      const user = await prisma.user.findUnique({
        where: { id: persona.contextUpdatedByUserId },
        select: { name: true, email: true }
      });
      if (user) contextUpdatedByUser = { name: user.name, email: user.email };
    }

    return NextResponse.json({ persona, contextUpdatedByUser });
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
      activeCampaignsContext,
      minimumCapitalRequired,
      capitalVerificationPrompt,
      outOfScopeTopics,
      verifiedDetails,
      skipR24ScriptInject,
      allowEarlyFinancialScreening,
      multiBubbleEnabled,
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

    // Persona Editor day-to-day context fields. activeCampaignsContext
    // is free-form operator-maintained text; on any touch (including
    // setting it back to empty to clear expired campaigns), we record
    // who updated the persona and when so the editor UI can render
    // "Last updated by X, N ago".
    if (activeCampaignsContext !== undefined) {
      data.activeCampaignsContext =
        typeof activeCampaignsContext === 'string' &&
        activeCampaignsContext.trim().length > 0
          ? activeCampaignsContext.trim()
          : null;
    }
    // R24/R26 day-to-day fields. minimumCapitalRequired accepts numeric
    // strings too since HTML number inputs sometimes send them that way;
    // coerce and validate, null out on empty/invalid so turning off the
    // threshold is as easy as clearing the field.
    if (minimumCapitalRequired !== undefined) {
      const n =
        typeof minimumCapitalRequired === 'number'
          ? minimumCapitalRequired
          : typeof minimumCapitalRequired === 'string' &&
              minimumCapitalRequired.trim().length > 0
            ? parseInt(minimumCapitalRequired, 10)
            : null;
      data.minimumCapitalRequired =
        typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
    }
    if (capitalVerificationPrompt !== undefined) {
      data.capitalVerificationPrompt =
        typeof capitalVerificationPrompt === 'string' &&
        capitalVerificationPrompt.trim().length > 0
          ? capitalVerificationPrompt.trim()
          : null;
    }
    if (outOfScopeTopics !== undefined) {
      data.outOfScopeTopics =
        typeof outOfScopeTopics === 'string' &&
        outOfScopeTopics.trim().length > 0
          ? outOfScopeTopics.trim()
          : null;
    }
    if (verifiedDetails !== undefined) {
      data.verifiedDetails =
        typeof verifiedDetails === 'string' && verifiedDetails.trim().length > 0
          ? verifiedDetails.trim()
          : null;
    }
    // Script-restructuring flags. Coerce to boolean defensively since
    // checkboxes sometimes serialize to truthy strings or "on".
    if (skipR24ScriptInject !== undefined) {
      data.skipR24ScriptInject = Boolean(skipR24ScriptInject);
    }
    if (allowEarlyFinancialScreening !== undefined) {
      data.allowEarlyFinancialScreening = Boolean(allowEarlyFinancialScreening);
    }
    if (multiBubbleEnabled !== undefined) {
      data.multiBubbleEnabled = Boolean(multiBubbleEnabled);
    }
    data.contextUpdatedAt = new Date();
    data.contextUpdatedByUserId = auth.userId || null;

    // AI engine settings (optional, only set if provided).
    // Validate against floor/ceiling — instant replies (<30s) read as bot.
    const RESPONSE_DELAY_MIN_FLOOR = 30;
    const RESPONSE_DELAY_MAX_CEILING = 3600;
    if (responseDelayMin !== undefined) {
      if (
        typeof responseDelayMin !== 'number' ||
        !Number.isFinite(responseDelayMin) ||
        responseDelayMin < RESPONSE_DELAY_MIN_FLOOR ||
        responseDelayMin > RESPONSE_DELAY_MAX_CEILING
      ) {
        return NextResponse.json(
          {
            error: `responseDelayMin must be between ${RESPONSE_DELAY_MIN_FLOOR} and ${RESPONSE_DELAY_MAX_CEILING} seconds (instant replies look like a bot)`
          },
          { status: 400 }
        );
      }
      data.responseDelayMin = Math.floor(responseDelayMin);
    }
    if (responseDelayMax !== undefined) {
      if (
        typeof responseDelayMax !== 'number' ||
        !Number.isFinite(responseDelayMax) ||
        responseDelayMax < RESPONSE_DELAY_MIN_FLOOR ||
        responseDelayMax > RESPONSE_DELAY_MAX_CEILING
      ) {
        return NextResponse.json(
          {
            error: `responseDelayMax must be between ${RESPONSE_DELAY_MIN_FLOOR} and ${RESPONSE_DELAY_MAX_CEILING} seconds`
          },
          { status: 400 }
        );
      }
      data.responseDelayMax = Math.floor(responseDelayMax);
    }
    if (
      typeof data.responseDelayMin === 'number' &&
      typeof data.responseDelayMax === 'number' &&
      data.responseDelayMax < data.responseDelayMin
    ) {
      data.responseDelayMax = data.responseDelayMin;
    }
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
