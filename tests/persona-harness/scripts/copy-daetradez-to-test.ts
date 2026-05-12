#!/usr/bin/env tsx
/* eslint-disable no-console */
// Copies daetradez prod config + script + training data into the
// repo's persona-harness fixture file. READ-ONLY against prod.
//
// Run:
//   PROD_READ_DATABASE_URL=postgres://readonly:...@prod-host/qdms \
//   npm run db:copy-daetradez
//
// Safety:
//   - PROD_READ_DATABASE_URL must be set and must differ from
//     DATABASE_URL and TEST_DATABASE_URL.
//   - The Prisma client built here is wrapped in a Proxy that only
//     forwards read-method calls (findFirst, findMany, findUnique,
//     count, aggregate, groupBy, $queryRaw). Any mutation attempt
//     throws.
//   - All IDs from prod are replaced with placeholder strings in the
//     fixture; db-seed.ts substitutes test-harness- prefixed IDs at
//     seed time.
//
// PII scrubbing:
//   - lead names from TrainingConversation.leadIdentifier are replaced
//     with "Test Lead N" across every TrainingMessage.text.
//   - @-handles in message text become @test_lead_N.
//   - Phone numbers normalize to 555-0100.
//   - Email addresses become test+N@example.invalid.

import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createHash } from 'crypto';
import { PrismaClient } from '@prisma/client';
import type {
  AccountConfigFixture,
  PersonaSeedConfig,
  ProdDumpFixture,
  ScriptActionFixture,
  ScriptBranchFixture,
  ScriptFixture,
  ScriptFormFieldFixture,
  ScriptFormFixture,
  ScriptStepFixture,
  TrainingConversationFixture,
  TrainingMessageFixture,
  TrainingUploadFixture
} from '../types';

const DAETRADEZ_ACCOUNT_ID = 'cmnc6h63r0000l904c72g18aq';
const FIXTURE_PATH = resolve(__dirname, '../fixtures/daetradez-fixture.ts');
const TRAINING_MESSAGE_LIMIT = 20;

// ─── Env safety ─────────────────────────────────────────────────────

const envFile = resolve(process.cwd(), '.env.test.local');
if (existsSync(envFile)) {
  dotenvConfig({ path: envFile, override: true });
} else {
  dotenvConfig();
}

const PROD_READ_DATABASE_URL = process.env.PROD_READ_DATABASE_URL ?? '';
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const DATABASE_URL = process.env.DATABASE_URL ?? '';

function fail(msg: string): never {
  console.error(`[copy-daetradez] ${msg}`);
  process.exit(1);
}

if (!PROD_READ_DATABASE_URL) {
  fail(
    'PROD_READ_DATABASE_URL is unset. Refusing to run. Provide a READ-ONLY prod Postgres URL.'
  );
}
if (PROD_READ_DATABASE_URL === TEST_DATABASE_URL) {
  fail(
    'PROD_READ_DATABASE_URL is byte-identical to TEST_DATABASE_URL. Refusing.'
  );
}
if (PROD_READ_DATABASE_URL === DATABASE_URL && DATABASE_URL) {
  fail('PROD_READ_DATABASE_URL is byte-identical to DATABASE_URL. Refusing.');
}

// ─── Read-only client ───────────────────────────────────────────────

const ALLOWED_MODEL_METHODS = new Set([
  'findFirst',
  'findMany',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy'
]);
const FORBIDDEN_DOLLAR = new Set([
  '$executeRaw',
  '$executeRawUnsafe',
  '$transaction'
]);

function makeReadOnly(client: PrismaClient): PrismaClient {
  const handler: ProxyHandler<PrismaClient> = {
    get(target, prop) {
      const value = (target as unknown as Record<string | symbol, unknown>)[
        prop
      ];
      if (typeof prop === 'string' && FORBIDDEN_DOLLAR.has(prop)) {
        return () => {
          throw new Error(
            `[copy-daetradez] forbidden read-only client method: ${prop}`
          );
        };
      }
      if (
        value &&
        typeof value === 'object' &&
        typeof prop === 'string' &&
        !prop.startsWith('$') &&
        !prop.startsWith('_')
      ) {
        return new Proxy(value, {
          get(modelTarget, methodName) {
            const method = (modelTarget as Record<string | symbol, unknown>)[
              methodName
            ];
            if (typeof methodName !== 'string') return method;
            if (!ALLOWED_MODEL_METHODS.has(methodName)) {
              return () => {
                throw new Error(
                  `[copy-daetradez] forbidden read-only call: ${prop}.${methodName}`
                );
              };
            }
            return typeof method === 'function'
              ? (method as Function).bind(modelTarget)
              : method;
          }
        });
      }
      return value;
    }
  };
  return new Proxy(client, handler);
}

// ─── PII scrubbing ──────────────────────────────────────────────────

const PHONE_REGEX = /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const EMAIL_REGEX = /\b[\w.+-]+@[\w.-]+\.\w+\b/g;
const HANDLE_REGEX = /@[a-zA-Z0-9_.]{2,}/g;

interface ScrubContext {
  leadNameMap: Map<string, string>;
}

function scrubText(text: string | null, ctx: ScrubContext): string | null {
  if (!text) return text;
  let out = text;
  for (const [real, fake] of Array.from(ctx.leadNameMap.entries())) {
    if (!real) continue;
    const re = new RegExp(escapeRegex(real), 'gi');
    out = out.replace(re, fake);
  }
  out = out.replace(
    EMAIL_REGEX,
    (_m) => `test${randomDigit()}@example.invalid`
  );
  out = out.replace(PHONE_REGEX, '555-0100');
  out = out.replace(HANDLE_REGEX, (m) => {
    // Don't scrub already-scrubbed handles
    if (m.startsWith('@test_lead_')) return m;
    return `@test_lead_${randomDigit()}`;
  });
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let counter = 0;
function randomDigit(): number {
  counter = (counter + 1) % 99;
  return counter;
}

function hashAccount(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 12);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawClient = new PrismaClient({
    datasources: { db: { url: PROD_READ_DATABASE_URL } },
    log: ['error']
  });
  const prisma = makeReadOnly(rawClient);

  console.log(
    `[copy-daetradez] connecting to prod (read-only) via PROD_READ_DATABASE_URL`
  );
  console.log(`[copy-daetradez] source account: ${DAETRADEZ_ACCOUNT_ID}`);

  // ─── Account ──────────────────────────────────────────────────────
  const account = await prisma.account.findUnique({
    where: { id: DAETRADEZ_ACCOUNT_ID }
  });
  if (!account) {
    fail(`account ${DAETRADEZ_ACCOUNT_ID} not found in prod DB`);
  }

  // ─── Persona (most recently updated active persona) ───────────────
  const persona = await prisma.aIPersona.findFirst({
    where: { accountId: DAETRADEZ_ACCOUNT_ID, isActive: true },
    orderBy: { updatedAt: 'desc' }
  });
  if (!persona) {
    fail(`no active AIPersona found for account ${DAETRADEZ_ACCOUNT_ID}`);
  }

  // ─── Script + nested ──────────────────────────────────────────────
  const script = await prisma.script.findFirst({
    where: { accountId: DAETRADEZ_ACCOUNT_ID, isActive: true },
    orderBy: { updatedAt: 'desc' },
    include: {
      steps: {
        include: {
          branches: true,
          actions: true
        }
      },
      forms: { include: { fields: true } }
    }
  });

  // ─── Training data: 20 most recent messages for this persona ──────
  const trainingMessages = await prisma.trainingMessage.findMany({
    where: { conversation: { personaId: persona.id } },
    orderBy: [{ timestamp: 'desc' }, { orderIndex: 'desc' }],
    take: TRAINING_MESSAGE_LIMIT,
    include: { conversation: { include: { upload: true } } }
  });

  const conversationIds = Array.from(
    new Set(trainingMessages.map((m) => m.conversationId))
  );
  const conversations = conversationIds.length
    ? await prisma.trainingConversation.findMany({
        where: { id: { in: conversationIds } }
      })
    : [];

  const uploadIds = Array.from(new Set(conversations.map((c) => c.uploadId)));
  const uploads = uploadIds.length
    ? await prisma.trainingUpload.findMany({
        where: { id: { in: uploadIds } }
      })
    : [];

  console.log(
    `[copy-daetradez] fetched: persona=1 script=${script ? 1 : 0} steps=${script?.steps.length ?? 0} forms=${script?.forms.length ?? 0} trainingMsgs=${trainingMessages.length}`
  );

  // ─── Build placeholder ID maps ────────────────────────────────────
  const idMap = new Map<string, string>();
  const ph = (kind: string, n: number | string): string => `$${kind}_${n}$`;

  idMap.set(account!.id, '$ACCOUNT_ID$');
  idMap.set(persona!.id, '$PERSONA_ID$');
  if (script) idMap.set(script.id, '$SCRIPT_ID$');
  script?.steps.forEach((s, i) => {
    idMap.set(s.id, ph('STEP', i));
    s.branches.forEach((b, j) => idMap.set(b.id, ph(`STEP_${i}_BRANCH`, j)));
    s.actions.forEach((a, j) => idMap.set(a.id, ph(`STEP_${i}_ACTION`, j)));
  });
  script?.forms.forEach((f, i) => {
    idMap.set(f.id, ph('FORM', i));
    f.fields.forEach((fi, j) => idMap.set(fi.id, ph(`FORM_${i}_FIELD`, j)));
  });
  uploads.forEach((u, i) => idMap.set(u.id, ph('UPLOAD', i)));
  conversations.forEach((c, i) => idMap.set(c.id, ph('TRAINING_CONV', i)));
  trainingMessages.forEach((m, i) => idMap.set(m.id, ph('TRAINING_MSG', i)));

  const lookup = (realId: string | null): string | null =>
    realId ? (idMap.get(realId) ?? `$UNMAPPED_${realId.slice(0, 8)}$`) : null;

  // ─── Build PII scrub context (lead names → "Test Lead N") ─────────
  const leadNameMap = new Map<string, string>();
  conversations.forEach((c, i) => {
    if (c.leadIdentifier) {
      leadNameMap.set(c.leadIdentifier, `Test Lead ${i + 1}`);
    }
  });
  const scrubCtx: ScrubContext = { leadNameMap };

  // ─── Translate to fixture shape ───────────────────────────────────
  const accountConfig: AccountConfigFixture = {
    placeholderId: '$ACCOUNT_ID$',
    name: account!.name,
    plan: account!.plan,
    aiProvider: account!.aiProvider,
    awayModeInstagram: account!.awayModeInstagram,
    awayModeFacebook: account!.awayModeFacebook,
    ghostThresholdDays: account!.ghostThresholdDays
  };

  const personaConfig: PersonaSeedConfig = {
    personaName: persona!.personaName,
    fullName: persona!.fullName,
    companyName: persona!.companyName ?? undefined,
    tone: persona!.tone ?? undefined,
    systemPrompt: persona!.systemPrompt,
    rawScript: persona!.rawScript ?? undefined,
    qualificationFlow: persona!.qualificationFlow
      ? JSON.stringify(persona!.qualificationFlow)
      : undefined,
    objectionHandling: persona!.objectionHandling
      ? JSON.stringify(persona!.objectionHandling)
      : undefined,
    voiceNoteDecisionPrompt: persona!.voiceNoteDecisionPrompt ?? undefined,
    qualityScoringPrompt: persona!.qualityScoringPrompt ?? undefined,
    promptConfig:
      (persona!.promptConfig as Record<string, unknown> | null) ?? undefined,
    downsellConfig:
      (persona!.downsellConfig as Record<string, unknown> | null) ?? undefined,
    minimumCapitalRequired: persona!.minimumCapitalRequired ?? undefined,
    freeValueLink: persona!.freeValueLink ?? undefined,
    customPhrases:
      (persona!.customPhrases as Record<string, string> | null) ?? undefined,
    styleAnalysis:
      typeof persona!.styleAnalysis === 'string'
        ? undefined // string analyses go in via separate field; persona seed accepts string|object
        : undefined,
    financialWaterfall:
      (persona!.financialWaterfall as Record<string, unknown> | null) ??
      undefined,
    knowledgeAssets:
      (persona!.knowledgeAssets as Record<string, unknown> | null) ?? undefined
  };

  let scriptFixture: ScriptFixture | null = null;
  if (script) {
    const stepFixtures: ScriptStepFixture[] = script.steps.map((s) => ({
      placeholderId: lookup(s.id)!,
      stepNumber: s.stepNumber,
      title: s.title,
      description: s.description,
      objective: s.objective,
      stateKey: s.stateKey,
      requiredDataPoints: s.requiredDataPoints,
      recoveryActionType: s.recoveryActionType,
      canonicalQuestion: s.canonicalQuestion,
      artifactField: s.artifactField,
      routingRules: s.routingRules,
      completionRule: s.completionRule
    }));
    const branchFixtures: ScriptBranchFixture[] = script.steps.flatMap((s) =>
      s.branches.map((b) => ({
        placeholderId: lookup(b.id)!,
        stepPlaceholderId: lookup(s.id)!,
        branchLabel: b.branchLabel,
        conditionDescription: b.conditionDescription,
        sortOrder: b.sortOrder
      }))
    );
    const actionFixtures: ScriptActionFixture[] = script.steps.flatMap((s) =>
      s.actions.map((a) => ({
        placeholderId: lookup(a.id)!,
        stepPlaceholderId: lookup(s.id)!,
        branchPlaceholderId: a.branchId ? lookup(a.branchId) : null,
        actionType: a.actionType,
        content: a.content,
        linkUrl: a.linkUrl,
        linkLabel: a.linkLabel,
        formPlaceholderId: a.formId ? lookup(a.formId) : null,
        voiceNoteRefStripped: a.voiceNoteId !== null,
        bindingMode: a.bindingMode,
        waitDuration: a.waitDuration,
        sortOrder: a.sortOrder
      }))
    );
    const formFixtures: ScriptFormFixture[] = script.forms.map((f) => ({
      placeholderId: lookup(f.id)!,
      name: f.name,
      description: f.description,
      fields: f.fields.map((fi) => ({
        placeholderId: lookup(fi.id)!,
        formPlaceholderId: lookup(f.id)!,
        fieldLabel: fi.fieldLabel,
        fieldValue: fi.fieldValue,
        sortOrder: fi.sortOrder
      }))
    }));
    scriptFixture = {
      placeholderId: '$SCRIPT_ID$',
      name: script.name,
      description: script.description,
      isActive: script.isActive,
      isDefault: script.isDefault,
      createdVia: script.createdVia,
      originalUploadText: script.originalUploadText,
      steps: stepFixtures,
      branches: branchFixtures,
      actions: actionFixtures,
      forms: formFixtures
    };
  }

  const trainingUploadFixtures: TrainingUploadFixture[] = uploads.map((u) => ({
    placeholderId: lookup(u.id)!,
    fileName: u.fileName,
    fileHash: u.fileHash,
    blobUrl: 'harness://stubbed',
    rawText: null, // strip — can contain raw conversation text
    status: u.status,
    tokenEstimate: u.tokenEstimate,
    conversationCount: u.conversationCount
  }));

  const trainingConvFixtures: TrainingConversationFixture[] = conversations.map(
    (c, i) => ({
      placeholderId: lookup(c.id)!,
      uploadPlaceholderId: lookup(c.uploadId)!,
      leadIdentifier: `test_lead_${i + 1}`,
      outcomeLabel: c.outcomeLabel,
      contentHash: c.contentHash,
      messageCount: c.messageCount,
      closerMessageCount: c.closerMessageCount,
      leadMessageCount: c.leadMessageCount,
      voiceNoteCount: c.voiceNoteCount,
      startedAt: c.startedAt?.toISOString() ?? null,
      endedAt: c.endedAt?.toISOString() ?? null,
      leadType: c.leadType,
      primaryObjectionType: c.primaryObjectionType,
      dominantStage: c.dominantStage
    })
  );

  const trainingMessageFixtures: TrainingMessageFixture[] =
    trainingMessages.map((m) => ({
      placeholderId: lookup(m.id)!,
      conversationPlaceholderId: lookup(m.conversationId)!,
      sender: m.sender,
      text: scrubText(m.text, scrubCtx),
      timestamp: m.timestamp?.toISOString() ?? null,
      messageType: m.messageType,
      stage: m.stage,
      objectionType: m.objectionType,
      orderIndex: m.orderIndex
    }));

  const fixture: ProdDumpFixture = {
    _populated: true,
    capturedAt: new Date().toISOString(),
    sourceAccountIdHash: hashAccount(DAETRADEZ_ACCOUNT_ID),
    accountConfig,
    personaConfig,
    script: scriptFixture,
    trainingUploads: trainingUploadFixtures,
    trainingConversations: trainingConvFixtures,
    trainingMessages: trainingMessageFixtures
  };

  // ─── Write fixture ────────────────────────────────────────────────
  mkdirSync(dirname(FIXTURE_PATH), { recursive: true });
  const body =
    `// AUTO-GENERATED FIXTURE — do not hand-edit.\n` +
    `//\n` +
    `// Re-generate with: npm run db:copy-daetradez\n` +
    `// Captured: ${fixture.capturedAt}\n` +
    `// Source account hash: ${fixture.sourceAccountIdHash}\n` +
    `// (Real account ID is never written to this file.)\n` +
    `\n` +
    `import type { ProdDumpFixture } from '../types';\n` +
    `\n` +
    `export const daetradezFixture: ProdDumpFixture = ${JSON.stringify(fixture, null, 2)};\n`;
  writeFileSync(FIXTURE_PATH, body, 'utf8');

  console.log(
    `[copy-daetradez] wrote ${FIXTURE_PATH} — ${trainingMessageFixtures.length} training msg(s), ${scriptFixture?.steps.length ?? 0} step(s).`
  );

  await rawClient.$disconnect();
}

main().catch(async (err) => {
  console.error('[copy-daetradez] fatal:', err);
  process.exit(1);
});
