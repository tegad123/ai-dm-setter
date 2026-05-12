// Idempotent seeders for the persona harness. Every row created here
// has an id (or slug) that starts with the harness prefix so cleanup
// can find them deterministically.

import type { Prisma } from '@prisma/client';
import { HARNESS_CONFIG, assertTestDb, getPrisma } from './safety-guard';
import type {
  AccountConfigFixture,
  PersonaSeedConfig,
  ScriptFixture,
  TrainingConversationFixture,
  TrainingMessageFixture,
  TrainingUploadFixture
} from '../types';

function asJson(
  v: Record<string, unknown> | undefined
): Prisma.InputJsonValue | undefined {
  return v === undefined ? undefined : (v as Prisma.InputJsonValue);
}

const PREFIX = HARNESS_CONFIG.rowIdPrefix;

export interface SeededAccount {
  id: string;
  slug: string;
}

export interface SeededPersona {
  id: string;
  accountId: string;
  slug: string;
  allowedUrls: string[];
}

export function collectAllowedUrls(config: PersonaSeedConfig): string[] {
  const urls = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.startsWith('http')) urls.add(v);
  };
  add(config.freeValueLink);
  const ds = config.downsellConfig as Record<string, unknown> | undefined;
  if (ds) add(ds['link']);
  const pc = config.promptConfig as Record<string, unknown> | undefined;
  if (pc) {
    for (const k of [
      'bookingTypeformUrl',
      'applicationFormUrl',
      'downsellLink',
      'fallbackContent',
      'freeContentLink'
    ]) {
      add(pc[k]);
    }
  }
  return Array.from(urls);
}

export interface SeededLead {
  id: string;
  conversationId: string;
  platformUserId: string;
}

export async function seedAccount(
  personaSlug: string,
  accountConfig?: AccountConfigFixture
): Promise<SeededAccount> {
  await assertTestDb();
  const prisma = await getPrisma();
  const id = `${PREFIX}acct-${personaSlug}`;
  const slug = `${PREFIX}acct-${personaSlug}`;
  const merged = {
    id,
    slug,
    name: accountConfig?.name ?? `Persona Harness — ${personaSlug}`,
    plan: (accountConfig?.plan as 'FREE' | 'PRO' | 'ENTERPRISE') ?? 'PRO',
    aiProvider: accountConfig?.aiProvider ?? 'anthropic',
    awayModeInstagram: accountConfig?.awayModeInstagram ?? true,
    awayModeFacebook: accountConfig?.awayModeFacebook ?? false,
    ghostThresholdDays: accountConfig?.ghostThresholdDays ?? 7,
    onboardingComplete: true
  };
  const account = await prisma.account.upsert({
    where: { slug },
    create: merged,
    update: {
      aiProvider: merged.aiProvider,
      awayModeInstagram: merged.awayModeInstagram
    }
  });
  return { id: account.id, slug: account.slug };
}

export async function seedIntegrationCredential(
  accountId: string
): Promise<void> {
  await assertTestDb();
  const prisma = await getPrisma();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  await prisma.integrationCredential.upsert({
    where: {
      accountId_provider: { accountId, provider: 'ANTHROPIC' }
    },
    create: {
      accountId,
      provider: 'ANTHROPIC',
      credentials: { apiKey, model: 'claude-sonnet-4-5-20250929' },
      isActive: true,
      verifiedAt: new Date()
    },
    update: {
      credentials: { apiKey, model: 'claude-sonnet-4-5-20250929' },
      isActive: true
    }
  });
}

export async function seedPersona(
  accountId: string,
  personaSlug: string,
  config: PersonaSeedConfig
): Promise<SeededPersona> {
  await assertTestDb();
  const prisma = await getPrisma();
  const id = `${PREFIX}persona-${personaSlug}`;
  const existing = await prisma.aIPersona.findUnique({ where: { id } });

  const data = {
    accountId,
    personaName: config.personaName,
    fullName: config.fullName,
    companyName: config.companyName ?? null,
    tone: config.tone ?? null,
    systemPrompt: config.systemPrompt,
    rawScript: config.rawScript ?? null,
    qualificationFlow: config.qualificationFlow
      ? JSON.parse(config.qualificationFlow)
      : undefined,
    objectionHandling: config.objectionHandling
      ? JSON.parse(config.objectionHandling)
      : undefined,
    voiceNoteDecisionPrompt: config.voiceNoteDecisionPrompt ?? null,
    qualityScoringPrompt: config.qualityScoringPrompt ?? null,
    promptConfig: asJson(config.promptConfig),
    downsellConfig: asJson(config.downsellConfig),
    freeValueLink: config.freeValueLink ?? null,
    customPhrases: asJson(
      config.customPhrases as Record<string, unknown> | undefined
    ),
    styleAnalysis:
      typeof config.styleAnalysis === 'string'
        ? config.styleAnalysis
        : config.styleAnalysis
          ? JSON.stringify(config.styleAnalysis)
          : null,
    financialWaterfall: asJson(config.financialWaterfall),
    knowledgeAssets: asJson(config.knowledgeAssets),
    minimumCapitalRequired: config.minimumCapitalRequired ?? null,
    isActive: true
  };

  const persona = existing
    ? await prisma.aIPersona.update({ where: { id }, data })
    : await prisma.aIPersona.create({ data: { id, ...data } });

  return {
    id: persona.id,
    accountId,
    slug: personaSlug,
    allowedUrls: collectAllowedUrls(config)
  };
}

export async function seedScenarioLead(
  accountId: string,
  personaId: string,
  personaSlug: string,
  scenarioId: string
): Promise<SeededLead> {
  await assertTestDb();
  const prisma = await getPrisma();
  const leadId = `${PREFIX}lead-${personaSlug}-${scenarioId}`;
  const conversationId = `${PREFIX}conv-${personaSlug}-${scenarioId}`;
  const platformUserId = `${PREFIX}platuser-${personaSlug}-${scenarioId}`;

  // Use create — cleanup is per-persona so by the time we seed a new
  // scenario, the previous rows are gone. If a stale row exists,
  // upsert defensively.
  await prisma.lead.upsert({
    where: { id: leadId },
    create: {
      id: leadId,
      accountId,
      name: `Test Lead ${scenarioId}`,
      handle: `${PREFIX}handle_${scenarioId}`,
      platform: 'INSTAGRAM',
      triggerType: 'DM',
      platformUserId
    },
    update: {
      platformUserId
    }
  });

  await prisma.conversation.upsert({
    where: { id: conversationId },
    create: {
      id: conversationId,
      leadId,
      personaId,
      aiActive: true,
      source: 'INBOUND'
    },
    update: {
      personaId,
      aiActive: true
    }
  });

  return { id: leadId, conversationId, platformUserId };
}

// ─── Prod-dump fixture seeders ─────────────────────────────────────

function buildIdResolver(
  personaSlug: string,
  accountId: string,
  personaId: string
): {
  resolve: (placeholder: string | null) => string | null;
  register: (placeholder: string) => string;
} {
  const map = new Map<string, string>();
  map.set('$ACCOUNT_ID$', accountId);
  map.set('$PERSONA_ID$', personaId);
  let counter = 0;
  return {
    register(placeholder: string): string {
      const existing = map.get(placeholder);
      if (existing) return existing;
      counter += 1;
      const realId = `${PREFIX}row-${personaSlug}-${counter}`;
      map.set(placeholder, realId);
      return realId;
    },
    resolve(placeholder: string | null): string | null {
      if (!placeholder) return null;
      const hit = map.get(placeholder);
      if (hit) return hit;
      // Placeholder not pre-registered — allocate one on demand so
      // forward references (e.g. action.branchPlaceholderId pointing
      // at a not-yet-registered branch) still get a stable id.
      counter += 1;
      const realId = `${PREFIX}row-${personaSlug}-${counter}`;
      map.set(placeholder, realId);
      return realId;
    }
  };
}

export interface SeededScript {
  scriptId: string;
  stepIds: string[];
  branchIds: string[];
  actionIds: string[];
  formIds: string[];
}

export async function seedScriptFixture(
  accountId: string,
  personaSlug: string,
  scriptFixture: ScriptFixture,
  resolver: ReturnType<typeof buildIdResolver>
): Promise<SeededScript> {
  await assertTestDb();
  const prisma = await getPrisma();

  // Pre-register every placeholder so FK references resolve to a
  // consistent test-harness id regardless of insertion order.
  const scriptId = resolver.register(scriptFixture.placeholderId);
  scriptFixture.forms.forEach((f) => {
    resolver.register(f.placeholderId);
    f.fields.forEach((fi) => resolver.register(fi.placeholderId));
  });
  scriptFixture.steps.forEach((s) => resolver.register(s.placeholderId));
  scriptFixture.branches.forEach((b) => resolver.register(b.placeholderId));
  scriptFixture.actions.forEach((a) => resolver.register(a.placeholderId));

  await prisma.script.create({
    data: {
      id: scriptId,
      accountId,
      name: scriptFixture.name,
      description: scriptFixture.description,
      isActive: scriptFixture.isActive,
      isDefault: scriptFixture.isDefault,
      // ScriptCreatedVia enum: template | blank | upload_parsed
      createdVia: scriptFixture.createdVia as
        | 'template'
        | 'blank'
        | 'upload_parsed',
      originalUploadText: scriptFixture.originalUploadText
    }
  });

  // Forms (referenced by ScriptAction.formId) — seed before actions.
  for (const f of scriptFixture.forms) {
    const formId = resolver.resolve(f.placeholderId)!;
    await prisma.scriptForm.create({
      data: {
        id: formId,
        scriptId,
        name: f.name,
        description: f.description
      }
    });
    for (const fi of f.fields) {
      await prisma.scriptFormField.create({
        data: {
          id: resolver.resolve(fi.placeholderId)!,
          formId,
          fieldLabel: fi.fieldLabel,
          fieldValue: fi.fieldValue,
          sortOrder: fi.sortOrder
        }
      });
    }
  }

  // Steps
  for (const s of scriptFixture.steps) {
    await prisma.scriptStep.create({
      data: {
        id: resolver.resolve(s.placeholderId)!,
        scriptId,
        stepNumber: s.stepNumber,
        title: s.title,
        description: s.description,
        objective: s.objective,
        stateKey: s.stateKey,
        requiredDataPoints: asJson(
          s.requiredDataPoints as Record<string, unknown> | undefined
        ),
        recoveryActionType: s.recoveryActionType,
        canonicalQuestion: s.canonicalQuestion,
        artifactField: s.artifactField,
        routingRules: asJson(
          s.routingRules as Record<string, unknown> | undefined
        ),
        completionRule: asJson(
          s.completionRule as Record<string, unknown> | undefined
        )
      }
    });
  }

  // Branches
  for (const b of scriptFixture.branches) {
    await prisma.scriptBranch.create({
      data: {
        id: resolver.resolve(b.placeholderId)!,
        stepId: resolver.resolve(b.stepPlaceholderId)!,
        branchLabel: b.branchLabel,
        conditionDescription: b.conditionDescription,
        sortOrder: b.sortOrder
      }
    });
  }

  // Actions
  for (const a of scriptFixture.actions) {
    await prisma.scriptAction.create({
      data: {
        id: resolver.resolve(a.placeholderId)!,
        stepId: resolver.resolve(a.stepPlaceholderId)!,
        branchId: a.branchPlaceholderId
          ? resolver.resolve(a.branchPlaceholderId)
          : null,
        // ScriptActionType is lowercase in the schema (send_message,
        // ask_question, send_voice_note, send_link, send_video,
        // form_reference, runtime_judgment, wait_for_response, ...).
        // The fixture passes through whatever prod stored.
        actionType: a.actionType as
          | 'send_message'
          | 'ask_question'
          | 'send_voice_note'
          | 'send_link'
          | 'send_video'
          | 'form_reference'
          | 'runtime_judgment'
          | 'wait_for_response',
        content: a.content,
        linkUrl: a.linkUrl,
        linkLabel: a.linkLabel,
        formId: a.formPlaceholderId
          ? resolver.resolve(a.formPlaceholderId)
          : null,
        waitDuration: a.waitDuration,
        sortOrder: a.sortOrder
      }
    });
  }

  return {
    scriptId,
    stepIds: scriptFixture.steps.map((s) => resolver.resolve(s.placeholderId)!),
    branchIds: scriptFixture.branches.map(
      (b) => resolver.resolve(b.placeholderId)!
    ),
    actionIds: scriptFixture.actions.map(
      (a) => resolver.resolve(a.placeholderId)!
    ),
    formIds: scriptFixture.forms.map((f) => resolver.resolve(f.placeholderId)!)
  };
}

export interface SeededTraining {
  uploadIds: string[];
  conversationIds: string[];
  messageIds: string[];
}

export async function seedTrainingFixture(
  accountId: string,
  personaId: string,
  personaSlug: string,
  uploads: TrainingUploadFixture[],
  conversations: TrainingConversationFixture[],
  messages: TrainingMessageFixture[],
  resolver: ReturnType<typeof buildIdResolver>
): Promise<SeededTraining> {
  await assertTestDb();
  const prisma = await getPrisma();

  uploads.forEach((u) => resolver.register(u.placeholderId));
  conversations.forEach((c) => resolver.register(c.placeholderId));
  messages.forEach((m) => resolver.register(m.placeholderId));

  for (const u of uploads) {
    await prisma.trainingUpload.create({
      data: {
        id: resolver.resolve(u.placeholderId)!,
        accountId,
        personaId,
        fileName: u.fileName,
        fileHash: `${PREFIX}${u.fileHash}-${personaSlug}`,
        blobUrl: u.blobUrl,
        // UploadStatus: PENDING | EXTRACTING | PREFLIGHT_FAILED |
        // AWAITING_CONFIRMATION | STRUCTURING | COMPLETE | FAILED
        status:
          (u.status as
            | 'PENDING'
            | 'EXTRACTING'
            | 'PREFLIGHT_FAILED'
            | 'AWAITING_CONFIRMATION'
            | 'STRUCTURING'
            | 'COMPLETE'
            | 'FAILED') ?? 'COMPLETE',
        tokenEstimate: u.tokenEstimate,
        conversationCount: u.conversationCount
      }
    });
  }

  for (const c of conversations) {
    await prisma.trainingConversation.create({
      data: {
        id: resolver.resolve(c.placeholderId)!,
        accountId,
        personaId,
        uploadId: resolver.resolve(c.uploadPlaceholderId)!,
        leadIdentifier: c.leadIdentifier,
        // TrainingOutcome: CLOSED_WIN | GHOSTED | OBJECTION_LOST |
        // HARD_NO | BOOKED_NO_SHOW | UNKNOWN
        outcomeLabel:
          (c.outcomeLabel as
            | 'CLOSED_WIN'
            | 'GHOSTED'
            | 'OBJECTION_LOST'
            | 'HARD_NO'
            | 'BOOKED_NO_SHOW'
            | 'UNKNOWN') ?? 'UNKNOWN',
        contentHash: `${PREFIX}${c.contentHash}-${personaSlug}`,
        messageCount: c.messageCount,
        closerMessageCount: c.closerMessageCount,
        leadMessageCount: c.leadMessageCount,
        voiceNoteCount: c.voiceNoteCount,
        startedAt: c.startedAt ? new Date(c.startedAt) : null,
        endedAt: c.endedAt ? new Date(c.endedAt) : null,
        leadType: c.leadType,
        primaryObjectionType: c.primaryObjectionType,
        dominantStage: c.dominantStage
      }
    });
  }

  for (const m of messages) {
    await prisma.trainingMessage.create({
      data: {
        id: resolver.resolve(m.placeholderId)!,
        conversationId: resolver.resolve(m.conversationPlaceholderId)!,
        sender: m.sender,
        text: m.text,
        timestamp: m.timestamp ? new Date(m.timestamp) : null,
        messageType: m.messageType,
        stage: m.stage,
        objectionType: m.objectionType,
        orderIndex: m.orderIndex
      }
    });
  }

  return {
    uploadIds: uploads.map((u) => resolver.resolve(u.placeholderId)!),
    conversationIds: conversations.map(
      (c) => resolver.resolve(c.placeholderId)!
    ),
    messageIds: messages.map((m) => resolver.resolve(m.placeholderId)!)
  };
}

export function newIdResolver(
  personaSlug: string,
  accountId: string,
  personaId: string
): ReturnType<typeof buildIdResolver> {
  return buildIdResolver(personaSlug, accountId, personaId);
}
