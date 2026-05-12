// Idempotent seeders for the persona harness. Every row created here
// has an id (or slug) that starts with the harness prefix so cleanup
// can find them deterministically.

import type { Prisma } from '@prisma/client';
import { HARNESS_CONFIG, assertTestDb, getPrisma } from './safety-guard';
import type { PersonaSeedConfig } from '../types';

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
}

export interface SeededLead {
  id: string;
  conversationId: string;
  platformUserId: string;
}

export async function seedAccount(personaSlug: string): Promise<SeededAccount> {
  await assertTestDb();
  const prisma = await getPrisma();
  const id = `${PREFIX}acct-${personaSlug}`;
  const slug = `${PREFIX}acct-${personaSlug}`;
  const account = await prisma.account.upsert({
    where: { slug },
    create: {
      id,
      slug,
      name: `Persona Harness — ${personaSlug}`,
      plan: 'PRO',
      aiProvider: 'anthropic',
      awayModeInstagram: true,
      onboardingComplete: true
    },
    update: {
      aiProvider: 'anthropic',
      awayModeInstagram: true
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

  return { id: persona.id, accountId, slug: personaSlug };
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
