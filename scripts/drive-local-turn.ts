// Drive ONE lead turn against the LOCAL webhook (Facebook Messenger or
// Instagram), signed like Meta does, then report what the engine did:
// new AI bubbles (with their gate verdicts), conversation flags, script step,
// and any guard holds. Text or an image attachment. Dev-only.
//
// Usage:
//   NODE_PATH=$PWD/node_modules npx tsx scripts/drive-local-turn.ts "lead text"
//   NODE_PATH=$PWD/node_modules npx tsx scripts/drive-local-turn.ts --image https://example.com/pic.jpg
//   PLATFORM=ig NODE_PATH=$PWD/node_modules npx tsx scripts/drive-local-turn.ts "hey"
//   NEW=1 ... starts a fresh lead (new sender id suffix) so flows don't bleed into each other.
//
// Env (defaults = shazim local harness): PAGE_ID, SENDER_PSID, IG_BUSINESS_ID,
// SENDER_IGSID, WEBHOOK_BASE (http://localhost:3000), WAIT_S (120).
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env'), override: true });
import crypto from 'crypto';
import prisma from '../src/lib/prisma';

const PLATFORM = (process.env.PLATFORM ?? 'fb').toLowerCase();
const PAGE_ID = process.env.PAGE_ID ?? '1100557749811046';
const SENDER_PSID = process.env.SENDER_PSID ?? '27262754836683290';
const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID ?? '17841445698923309';
const SENDER_IGSID = process.env.SENDER_IGSID ?? '1474847644133208';
const BASE = process.env.WEBHOOK_BASE ?? 'http://localhost:3000';
const WAIT_S = Number(process.env.WAIT_S ?? 120);
// Seconds of silence after the last bubble before the group counts as done
// (the drip delay between bubbles can be 10-20s).
const SETTLE_S = Number(process.env.SETTLE_S ?? 25);
const SECRET = process.env.META_APP_SECRET;

async function snapshot() {
  const msgs = await prisma.message.findMany({
    where: { sender: 'AI' },
    select: { id: true }
  });
  const gate = await prisma.egressShadowLog.count();
  return { ids: new Set(msgs.map((m) => m.id)), gate };
}

async function main() {
  if (!SECRET) throw new Error('META_APP_SECRET not set');
  if (!(process.env.DATABASE_URL ?? '').includes('localhost'))
    throw new Error('DATABASE_URL must be localhost');
  const args = process.argv.slice(2);
  const imgIdx = args.indexOf('--image');
  const imageUrl = imgIdx >= 0 ? args[imgIdx + 1] : null;
  const text = imgIdx >= 0 ? null : args.join(' ');
  if (!text && !imageUrl) throw new Error('give lead text or --image <url>');

  const before = await snapshot();
  const ts = Date.now();
  const mid = `drive_${ts}_${Math.random().toString(36).slice(2)}`;
  const message: Record<string, unknown> = { mid };
  if (text) message.text = text;
  if (imageUrl)
    message.attachments = [{ type: 'image', payload: { url: imageUrl } }];

  const isIg = PLATFORM === 'ig' || PLATFORM === 'instagram';
  const senderId = isIg ? SENDER_IGSID : SENDER_PSID;
  const recipientId = isIg ? IG_BUSINESS_ID : PAGE_ID;
  const payload = JSON.stringify({
    object: isIg ? 'instagram' : 'page',
    entry: [
      {
        id: recipientId,
        time: ts,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: recipientId },
            timestamp: ts,
            message
          }
        ]
      }
    ]
  });
  const sig =
    'sha256=' +
    crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  const url = `${BASE}/api/webhooks/${isIg ? 'instagram' : 'facebook'}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: payload
  });
  console.log(
    `\n>>> LEAD (${isIg ? 'IG' : 'FB'}): ${text ?? `[image ${imageUrl}]`}   (webhook HTTP ${res.status})`
  );

  const deadline = Date.now() + WAIT_S * 1000;
  let settledAt: number | null = null;
  let lastCount = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = await prisma.message.findMany({
      where: { sender: 'AI', id: { notIn: Array.from(before.ids) } },
      orderBy: { timestamp: 'asc' },
      select: { content: true, platformMessageId: true, timestamp: true }
    });
    if (fresh.length > 0 && fresh.length === lastCount) {
      // no new bubble for SETTLE_S after the last one → the group is done
      if (settledAt && Date.now() - settledAt > SETTLE_S * 1000) break;
      if (!settledAt) settledAt = Date.now();
    } else {
      settledAt = null;
      lastCount = fresh.length;
    }
  }

  const fresh = await prisma.message.findMany({
    where: { sender: 'AI', id: { notIn: Array.from(before.ids) } },
    orderBy: { timestamp: 'asc' },
    select: { content: true, platformMessageId: true, timestamp: true }
  });
  for (const f of fresh)
    console.log(
      `<<< AI: ${f.content}   ${f.platformMessageId ? '[delivered]' : '[NOT delivered]'}`
    );
  if (fresh.length === 0) console.log('<<< (no AI message)');

  const conv = await prisma.conversation.findFirst({
    where: { lead: { platformUserId: senderId } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      currentScriptStep: true,
      systemStage: true,
      aiActive: true,
      awaitingHumanReview: true,
      distressDetected: true,
      awaitingAiResponse: true,
      capturedDataPoints: true,
      lead: { select: { stage: true } }
    }
  });
  const dp = (conv?.capturedDataPoints ?? {}) as Record<string, unknown>;
  const fsm = dp.fsmCursor as
    | { stepNumber?: number; selectedBranchLabel?: string | null }
    | undefined;
  console.log(
    `    conv=${conv?.id} step=${conv?.currentScriptStep} fsm=${fsm?.stepNumber ?? '-'}/${fsm?.selectedBranchLabel ?? '-'} stage=${conv?.systemStage} lead=${conv?.lead.stage} aiActive=${conv?.aiActive} review=${conv?.awaitingHumanReview} distress=${conv?.distressDetected} awaitingAi=${conv?.awaitingAiResponse}`
  );
  const gate = await prisma.egressShadowLog.findMany({
    where: { conversationId: conv?.id },
    orderBy: { createdAt: 'asc' },
    skip: Math.max(0, before.gate - 0),
    select: {
      machineAllow: true,
      machineReason: true,
      sendPath: true,
      draftPreview: true,
      createdAt: true
    }
  });
  const recent = gate.filter((g) => g.createdAt.getTime() >= ts);
  for (const g of recent)
    console.log(
      `    gate ${g.machineAllow ? 'ALLOW' : 'HOLD ' + g.machineReason} [${g.sendPath}] "${(g.draftPreview ?? '').slice(0, 70)}"`
    );
  const suggestions = await prisma.aISuggestion.findMany({
    where: { conversationId: conv?.id, generatedAt: { gte: new Date(ts) } },
    select: { responseText: true, messageBubbles: true }
  });
  for (const s of suggestions) {
    const b = Array.isArray(s.messageBubbles)
      ? (s.messageBubbles as string[])
      : [s.responseText];
    if (fresh.length === 0)
      console.log(
        `    suggestion (not delivered): ${b.join(' / ').slice(0, 300)}`
      );
  }
  const routing = await prisma.routingShadowLog.findMany({
    where: { conversationId: conv?.id, createdAt: { gte: new Date(ts) } },
    select: {
      stepNumber: true,
      legacyBranchLabel: true,
      fsmBranchLabel: true,
      fsmReason: true,
      legacyNextStep: true,
      fsmNextStep: true
    }
  });
  for (const r of routing)
    console.log(
      `    routing step=${r.stepNumber} legacy=${JSON.stringify(r.legacyBranchLabel)} fsm=${JSON.stringify(r.fsmBranchLabel)} (${(r.fsmReason ?? '').slice(0, 60)}) advance ${r.legacyNextStep ?? '-'}→${r.fsmNextStep ?? '-'}`
    );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(1);
});
