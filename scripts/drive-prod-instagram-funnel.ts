/**
 * Controlled production Instagram conversation test for @iamshazimkhan.
 *
 * A REAL inbound DM must first open Meta's 24-hour messaging window. --run
 * verifies that inbound, waits for its pending work to finish, deletes only
 * this test lead, then drives a fresh Convlo conversation with signed,
 * Instagram-shaped inbound webhooks. Every outbound must have a Meta mid
 * before the driver sends the next lead turn. These injected lead messages
 * appear in Convlo, but not in the native Instagram lead inbox.
 *
 * NODE_PATH=$PWD/node_modules npx tsx scripts/drive-prod-instagram-funnel.ts --check
 * NODE_PATH=$PWD/node_modules npx tsx scripts/drive-prod-instagram-funnel.ts --run
 * ... --run --fast temporarily sets this account's delay to 0 and restores it.
 * After a reset, --window-proof=<real inbound ISO> --window-source=<deleted
 * conversation ID> reuses that same verified Meta window if its reset audit
 * still exists. It expires 22 hours after the native inbound.
 *
 * Optional: E2E_MAX_TURNS=12 E2E_WAIT_SECONDS=600 E2E_SETTLE_SECONDS=20
 */
import { config } from 'dotenv';
import crypto from 'crypto';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { callHaikuText } from '../src/lib/haiku-text';

config({ path: path.resolve(process.cwd(), '.env') });

const ACCOUNT_ID = 'cmpy59zy50000ju04u6fs5o2r'; // Daniel / @daetradez
const ENTRY_ID = '17841403104278070';
const SENDER_ID = '804647389247738'; // @iamshazimkhan on this IG account
const SENDER_HANDLE = 'iamshazimkhan';
const WEBHOOK = 'https://qualifydms.io/api/webhooks/instagram';
const EXPECTED_SCRIPT_ID = 'cmueln1ns0001l3040lwx9oaf';
const MAX_TURNS = Number(process.env.E2E_MAX_TURNS ?? 12);
const WAIT_SECONDS = Number(process.env.E2E_WAIT_SECONDS ?? 600);
const SETTLE_SECONDS = Number(process.env.E2E_SETTLE_SECONDS ?? 20);
const SECRET = process.env.META_APP_SECRET;
const dbUrl = process.env.PROD_DATABASE_URL;

if (!dbUrl) throw new Error('PROD_DATABASE_URL is required');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PERSONA = `You are a TEST lead replying to a trading educator's Instagram DM.
Write exactly one short, casual DM in lowercase. Answer the latest question
directly, using these consistent facts only when relevant: you are new to
futures trading, based in Texas, and want to learn a repeatable process. You
are interested in a free Discord community. Do not invent purchases, account
balances, payment details, or a real email or phone number. Do not mention
testing, webhooks, scripts, or AI. Do not use distress or solicitation language.
Return only the DM text, with no quotation marks.`;

type State = Awaited<ReturnType<typeof readState>>;

async function retry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      console.warn(`DB retry ${attempt + 1}/5: ${label}`);
      await sleep(1000 * (attempt + 1));
    }
  }
  throw last;
}

async function readLead() {
  const leads = await retry('lead', () =>
    prisma.lead.findMany({
      where: {
        accountId: ACCOUNT_ID,
        platform: 'INSTAGRAM',
        platformUserId: SENDER_ID
      },
      select: {
        id: true,
        handle: true,
        conversation: {
          select: {
            id: true,
            currentScriptStep: true,
            aiActive: true,
            awaitingAiResponse: true,
            awaitingHumanReview: true,
            capturedDataPoints: true,
            messages: {
              orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
              select: {
                id: true,
                sender: true,
                content: true,
                timestamp: true,
                platformMessageId: true,
                deliveryStatus: true
              }
            }
          }
        }
      }
    })
  );
  if (leads.length > 1) {
    throw new Error(`Expected at most one test lead, found ${leads.length}`);
  }
  return leads[0] ?? null;
}

async function readState() {
  const lead = await readLead();
  if (!lead?.conversation) return null;
  const queue = await retry('reply queue', () =>
    prisma.scheduledReply.findMany({
      where: { conversationId: lead.conversation!.id },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { id: true, status: true, lastError: true, scheduledFor: true }
    })
  );
  return { lead, conversation: lead.conversation, queue };
}

async function checkConfiguration() {
  const account = await retry('account', () =>
    prisma.account.findUnique({
      where: { id: ACCOUNT_ID },
      select: {
        id: true,
        awayModeInstagram: true,
        generateOnlyInstagram: true,
        responseDelayMin: true,
        responseDelayMax: true
      }
    })
  );
  if (!account) throw new Error('Target account not found');
  const activeScripts = await retry('active script', () =>
    prisma.script.findMany({
      where: { accountId: ACCOUNT_ID, isActive: true },
      select: { id: true, name: true, updatedAt: true }
    })
  );
  if (
    activeScripts.length !== 1 ||
    activeScripts[0].id !== EXPECTED_SCRIPT_ID
  ) {
    throw new Error(
      `Unexpected active script(s): ${activeScripts.map((s) => s.id).join(', ')}`
    );
  }
  const creds = await retry('IG credential', () =>
    prisma.integrationCredential.findMany({
      where: { accountId: ACCOUNT_ID, provider: 'INSTAGRAM', isActive: true },
      select: { metadata: true }
    })
  );
  if (
    !creds.some((cred) =>
      Object.values((cred.metadata ?? {}) as Record<string, unknown>).includes(
        ENTRY_ID
      )
    )
  ) {
    throw new Error(`No active IG credential matches entry ${ENTRY_ID}`);
  }
  console.log(
    `Account ${ACCOUNT_ID} | IG entry ${ENTRY_ID} | sender ${SENDER_ID}`
  );
  console.log(
    `Script ${activeScripts[0].name} | ${activeScripts[0].id} | updated ${activeScripts[0].updatedAt.toISOString()}`
  );
  console.log(
    `awayMode=${account.awayModeInstagram} generateOnly=${account.generateOnlyInstagram} delay=${account.responseDelayMin}-${account.responseDelayMax}s`
  );
  if (!account.awayModeInstagram || account.generateOnlyInstagram) {
    throw new Error('IG is not configured for real auto-send');
  }
}

function latestRealInbound(state: NonNullable<State>) {
  return [...state.conversation.messages]
    .reverse()
    .find(
      (msg) =>
        msg.sender === 'LEAD' &&
        msg.platformMessageId &&
        !msg.platformMessageId.startsWith('ig_e2e_')
    );
}

async function requireOpenWindow() {
  const state = await readState();
  if (!state) throw new Error('No current test conversation or real inbound');
  const proofArg = process.argv.find((arg) =>
    arg.startsWith('--window-proof=')
  );
  if (proofArg) {
    const sourceArg = process.argv.find((arg) =>
      arg.startsWith('--window-source=')
    );
    const sourceId = sourceArg?.slice('--window-source='.length);
    const proofAt = new Date(proofArg.slice('--window-proof='.length));
    const ageMinutes = (Date.now() - proofAt.getTime()) / 60000;
    if (
      !sourceId ||
      !Number.isFinite(ageMinutes) ||
      ageMinutes < 0 ||
      ageMinutes >= 22 * 60
    ) {
      throw new Error('Prior native window proof is missing or expired');
    }
    const audit = await retry('window reset audit', () =>
      prisma.notification.findFirst({
        where: {
          accountId: ACCOUNT_ID,
          title: 'Controlled test conversation reset',
          body: { contains: `conversation ${sourceId},` },
          createdAt: { gte: proofAt }
        },
        select: { id: true, createdAt: true }
      })
    );
    if (!audit)
      throw new Error('No matching test reset audit for window proof');
    console.log(
      `Reusing verified native inbound ${proofAt.toISOString()} (${ageMinutes.toFixed(1)}m ago), reset audit ${audit.id}`
    );
    return state;
  }
  const inbound = latestRealInbound(state);
  if (!inbound) throw new Error('No real Instagram inbound found');
  const ageMinutes = (Date.now() - inbound.timestamp.getTime()) / 60000;
  console.log(
    `Latest real inbound: ${inbound.timestamp.toISOString()} (${ageMinutes.toFixed(1)}m ago), conversation ${state.conversation.id}`
  );
  // A short buffer avoids reaching Meta's 24-hour boundary mid-test.
  if (ageMinutes < 0 || ageMinutes >= 22 * 60) {
    throw new Error('Real Instagram inbound is too old; send one new DM first');
  }
  return state;
}

async function waitForPriorWork(conversationId: string) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const state = await readState();
    if (!state || state.conversation.id !== conversationId) {
      throw new Error('Test conversation changed during reset preflight');
    }
    const busy = state.queue.some(
      (reply) => reply.status === 'PENDING' || reply.status === 'PROCESSING'
    );
    // A quality-gate failure is terminal and intentionally leaves the chat
    // marked for human review. It has no worker left to wait for.
    if (
      !busy &&
      (!state.conversation.awaitingAiResponse || isTerminalReviewHold(state))
    ) {
      return state;
    }
    await sleep(3000);
  }
  throw new Error('Current real inbound is still processing; reset cancelled');
}

function isTerminalReviewHold(state: NonNullable<State>) {
  return (
    state.conversation.awaitingHumanReview &&
    state.queue[0]?.status === 'FAILED_QUALITY_GATE'
  );
}

async function resetTestLead(state: NonNullable<State>) {
  const conversation = state.conversation;
  const cdp = conversation.capturedDataPoints as Record<string, unknown> | null;
  if (cdp?.verificationBaseline === true) {
    throw new Error('Verification baseline: deletion refused');
  }
  if (
    state.queue.some(
      (reply) => reply.status === 'PENDING' || reply.status === 'PROCESSING'
    ) ||
    (conversation.awaitingAiResponse && !isTerminalReviewHold(state))
  ) {
    throw new Error('Pending AI work: deletion refused');
  }
  // Match the dashboard's delete behavior but constrain it to the one
  // account/platform/sender/handle verified above. Notification is the audit.
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.lead.findUnique({
        where: { id: state.lead.id },
        select: {
          accountId: true,
          platform: true,
          platformUserId: true,
          handle: true
        }
      });
      if (
        current?.accountId !== ACCOUNT_ID ||
        current.platform !== 'INSTAGRAM' ||
        current.platformUserId !== SENDER_ID ||
        current.handle.replace(/^@/, '').toLowerCase() !== SENDER_HANDLE
      ) {
        throw new Error('Test-lead identity changed; reset refused');
      }
      await tx.scheduledReply.deleteMany({
        where: { conversationId: conversation.id }
      });
      await tx.notification.create({
        data: {
          accountId: ACCOUNT_ID,
          type: 'SYSTEM',
          title: 'Controlled test conversation reset',
          body: `Authorized @${SENDER_HANDLE} Instagram test reset: conversation ${conversation.id}, lead ${state.lead.id}, ${conversation.messages.length} messages. The real inbound opened the Meta messaging window before the reset.`
        }
      });
      await tx.lead.delete({ where: { id: state.lead.id } });
    });
  } catch (error) {
    // A dropped DB connection can hide a successful commit. Resolve the
    // uncertain result by reading the exact lead before deciding to retry.
    if (await readLead()) throw error;
  }
  if (await readLead()) throw new Error('Test lead still exists after reset');
  console.log(
    `Reset complete: deleted only ${conversation.id} (${conversation.messages.length} messages)`
  );
}

async function sendSignedInbound(content: string) {
  if (!SECRET) throw new Error('META_APP_SECRET is required');
  const time = Date.now();
  const mid = `ig_e2e_${time}_${crypto.randomUUID()}`;
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: ENTRY_ID,
        time,
        messaging: [
          {
            sender: { id: SENDER_ID },
            recipient: { id: ENTRY_ID },
            timestamp: time,
            message: { mid, text: content }
          }
        ]
      }
    ]
  });
  const signature =
    'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  const response = await fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signature
    },
    body
  });
  if (response.status !== 200) {
    throw new Error(`Instagram webhook returned HTTP ${response.status}`);
  }
  return mid;
}

async function waitForDeliveredTurn(mid: string, beforeAiIds: Set<string>) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let lastNewAiAt = 0;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const state = await readState();
    if (!state) {
      await sleep(3000);
      continue;
    }
    const inbound = state.conversation.messages.find(
      (msg) => msg.sender === 'LEAD' && msg.platformMessageId === mid
    );
    if (!inbound) {
      await sleep(3000);
      continue;
    }
    const freshAi = state.conversation.messages.filter(
      (msg) => msg.sender === 'AI' && !beforeAiIds.has(msg.id)
    );
    if (freshAi.length !== lastCount) {
      lastCount = freshAi.length;
      lastNewAiAt = Date.now();
    }
    const terminal = state.queue.find(
      (reply) =>
        reply.status === 'FAILED' || reply.status === 'FAILED_QUALITY_GATE'
    );
    if (terminal && freshAi.length === 0) {
      throw new Error(
        `AI queue ${terminal.status}: ${(terminal.lastError ?? '').slice(0, 180)}`
      );
    }
    if (
      state.conversation.awaitingHumanReview ||
      !state.conversation.aiActive
    ) {
      throw new Error(
        'Conversation paused for human review; no further lead DMs'
      );
    }
    if (
      freshAi.length > 0 &&
      !state.conversation.awaitingAiResponse &&
      Date.now() - lastNewAiAt >= SETTLE_SECONDS * 1000
    ) {
      for (const msg of freshAi) {
        if (!msg.platformMessageId || msg.deliveryStatus === 'FAILED') {
          throw new Error(
            `AI bubble ${msg.id} lacks a delivered Meta message ID`
          );
        }
      }
      return { state, freshAi };
    }
    await sleep(3000);
  }
  throw new Error(
    `Timed out waiting for complete delivered AI turn after ${mid}`
  );
}

async function nextNaturalLeadReply(state: NonNullable<State>, ai: string[]) {
  const transcript = state.conversation.messages
    .map(
      (msg) => `${msg.sender === 'LEAD' ? 'LEAD' : 'SETTER'}: ${msg.content}`
    )
    .join('\n');
  const prompt = `${PERSONA}\n\nTranscript:\n${transcript}\n\nLatest setter turn:\n${ai.join(' ')}\n\nNext lead DM:`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await callHaikuText({
      accountId: null,
      prompt,
      maxTokens: 100,
      temperature: 0.5,
      timeoutMs: 30000,
      logPrefix: `[ig-e2e-lead-${attempt}]`
    });
    const message = result?.text?.trim().replace(/^['"]|['"]$/g, '');
    if (
      message &&
      message.length <= 350 &&
      !/\b(webhook|test|script|ai|suicid|self.harm)\b/i.test(message)
    ) {
      return message;
    }
    await sleep(1000);
  }
  throw new Error('Could not generate a safe natural lead reply');
}

async function readDelay() {
  return retry('response delay', () =>
    prisma.account.findUniqueOrThrow({
      where: { id: ACCOUNT_ID },
      select: { responseDelayMin: true, responseDelayMax: true }
    })
  );
}

async function changeDelay(
  from: { responseDelayMin: number; responseDelayMax: number },
  to: { responseDelayMin: number; responseDelayMax: number }
) {
  try {
    const changed = await prisma.account.updateMany({
      where: { id: ACCOUNT_ID, ...from },
      data: to
    });
    if (changed.count === 1) return;
  } catch {
    // A pooler disconnect can happen after the update committed. Read back
    // before deciding the setting still needs a write.
  }
  const actual = await readDelay();
  if (
    actual.responseDelayMin !== to.responseDelayMin ||
    actual.responseDelayMax !== to.responseDelayMax
  ) {
    throw new Error(
      `Response delay change was not confirmed; actual=${actual.responseDelayMin}-${actual.responseDelayMax}s`
    );
  }
}

async function main() {
  const mode = process.argv[2];
  const fast = process.argv.includes('--fast');
  if (mode !== '--check' && mode !== '--run') {
    throw new Error('Use --check (read-only) or --run (reset + drive)');
  }
  if (fast && mode !== '--run') throw new Error('--fast requires --run');
  await checkConfiguration();
  const initial = await requireOpenWindow();
  console.log(
    `Current step=${initial.conversation.currentScriptStep}, messages=${initial.conversation.messages.length}, queue=${initial.queue.map((q) => q.status).join(',') || 'empty'}`
  );
  if (mode === '--check') return;
  if (!SECRET) throw new Error('META_APP_SECRET is required');
  const originalDelay = fast ? await readDelay() : null;
  if (originalDelay) {
    await changeDelay(originalDelay, {
      responseDelayMin: 0,
      responseDelayMax: 0
    });
    console.log(
      `Temporarily set IG account response delay from ${originalDelay.responseDelayMin}-${originalDelay.responseDelayMax}s to 0s`
    );
  }
  try {
    const settled = await waitForPriorWork(initial.conversation.id);
    await resetTestLead(settled);

    let leadMessage = 'hey, i am new to futures trading. where should i start?';
    let previousAiIds = new Set<string>();
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      const mid = await sendSignedInbound(leadMessage);
      console.log(`\n[${turn}] LEAD: ${leadMessage} | webhook mid=${mid}`);
      const { state, freshAi } = await waitForDeliveredTurn(mid, previousAiIds);
      previousAiIds = new Set(
        state.conversation.messages
          .filter((msg) => msg.sender === 'AI')
          .map((msg) => msg.id)
      );
      for (const msg of freshAi) {
        console.log(`AI: ${msg.content} | Meta mid=${msg.platformMessageId}`);
      }
      console.log(
        `conversation=${state.conversation.id} step=${state.conversation.currentScriptStep} queue=${state.queue[0]?.status ?? 'none'}`
      );
      if (turn === MAX_TURNS) break;
      leadMessage = await nextNaturalLeadReply(
        state,
        freshAi.map((msg) => msg.content)
      );
    }
    console.log(
      'Completed requested turns. Review the native IG inbox and traces.'
    );
  } finally {
    if (originalDelay) {
      await changeDelay(
        { responseDelayMin: 0, responseDelayMax: 0 },
        {
          responseDelayMin: originalDelay.responseDelayMin,
          responseDelayMax: originalDelay.responseDelayMax
        }
      );
      console.log(
        `Restored account response delay to ${originalDelay.responseDelayMin}-${originalDelay.responseDelayMax}s`
      );
    }
  }
}

main()
  .catch((error) => {
    console.error(`STOPPED: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
