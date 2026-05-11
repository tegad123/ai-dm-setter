import prisma from '@/lib/prisma';
import { escalate } from '@/lib/escalation-dispatch';
import { broadcastAIStatusChange, broadcastNotification } from '@/lib/realtime';
import { detectDistress } from '@/lib/distress-detector';
import { attemptSelfRecovery } from '@/lib/script-state-recovery';
import type { ScriptHistoryMessage } from '@/lib/script-state-recovery';
import {
  scoreVoiceQualityGroup,
  isExplicitAcceptance
} from '@/lib/voice-quality-gate';
import { processScheduledReply } from '@/lib/webhook-processor';

// Raised 5 → 10 min on 2026-05-05. The first iteration of the active-
// conversation guard was correct in theory but bit @shepherdgushe.zw
// in production: the cron tick at 15:02:00 UTC fired the silent-stop
// 51 s after a fresh deploy went Ready, very likely from the OLD
// pre-fix function instance still warm in Vercel's edge before
// promotion. Aligning the silence threshold with the active window
// (both 10 min) makes the SQL pre-filter alone strong enough — even
// without any JS guard, a lead message inside the active window can
// never satisfy `lastMessageAt < threshold`, so no candidate is
// returned. Plus matches the user's "longer for keepalive" intent
// (their spec called out 5 min for heartbeat / longer for keepalive
// — the silent-stop fallback is the keepalive flavor).
const SILENCE_THRESHOLD_MS = 10 * 60 * 1000;
// Window over which we look for "did the lead just speak / has the
// bot side spoken recently" when deciding the conversation is still
// active. If both sides have messaged within this window — or the AI
// is still mid-generation (awaitingAiResponse=true) — we never fire
// the silent-stop fallback. Prevents the @arro_.92 incident: lead
// burst-typed 5 messages 7:03–7:05, AI followed up at 7:06, and the
// 5-min `awaitingSince` clock still tripped a "yo bro you still
// around?" at 7:13 even though the conversation was clearly live.
const ACTIVE_WINDOW_MS = 10 * 60 * 1000;
// Raised from 60s → 2h on 2026-05-05. The previous dedup let the same
// conversation re-fire the silent-stop ~60×/hr; one well-timed nudge
// per 2h is enough and matches `window-keepalive`'s philosophy
// (DEDUP_WINDOW_MS = 20h there, much longer cadence).
const DETECTION_DEDUP_MS = 2 * 60 * 60 * 1000;
const MAX_HEARTBEAT_BATCH = 25;
const SPIKE_WINDOW_MS = 60 * 60 * 1000;
const RECOVERY_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface Diagnosis {
  reason:
    | 'gate_rejection_no_fallback'
    | 'regen_exhaustion'
    | 'exception_thrown'
    | 'token_limit_hit'
    | 'no_generation_log_found'
    | 'scheduled_reply_failed'
    | 'unknown';
  lastGateViolation: string | null;
  regenAttempts: number;
}

interface SafetyResult {
  safe: boolean;
  reason: string | null;
}

interface RecoveryDraft {
  success: boolean;
  action: string;
  messages: string[];
  stage: string;
  subStage: string | null;
  capitalOutcome:
    | 'passed'
    | 'failed'
    | 'hedging'
    | 'ambiguous'
    | 'not_asked'
    | 'not_evaluated';
  reason: string;
}

export interface SilentStopHeartbeatResult {
  scanned: number;
  detected: number;
  autoTriggered: number;
  operatorReview: number;
  failed: number;
  // ManyChat-handoff'd conversations whose `awaitingAiResponse` flag was
  // never set (because the operator's flow ends silently — no completion
  // webhook fires). The fallback flips them BEFORE the main scan so the
  // same heartbeat tick can route them through the standard recovery
  // path. Counter exposed for ops visibility.
  manyChatRecovered: number;
}

export type StalledConversation = Awaited<
  ReturnType<typeof fetchStalledConversations>
>[number];

function historyFromMessages(
  messages: Array<{
    id: string;
    sender: string;
    content: string;
    timestamp: Date;
  }>
): ScriptHistoryMessage[] {
  return messages
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((message) => ({
      id: message.id,
      sender: message.sender,
      content: message.content,
      timestamp: message.timestamp
    }));
}

function latestLeadMessage(conversation: StalledConversation) {
  return conversation.messages
    .slice()
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .find((message) => message.sender === 'LEAD');
}

// A conversation is "active" — and therefore must NOT be silent-
// stopped — when the lead has spoken in the last ACTIVE_WINDOW_MS AND
// either the AI has also spoken in that window OR awaitingAiResponse
// is still true. The first arm catches genuine back-and-forth; the
// second catches the case where the lead just spoke and the AI is
// still mid-generation. The fallback "yo bro you still around?" only
// makes sense when the lead has gone dark for >ACTIVE_WINDOW_MS after
// the AI's last reply — the original `awaitingSince`-only check tripped
// during burst typing because the timer started on the FIRST inbound
// message and didn't account for subsequent lead activity.
function isConversationActive(conversation: StalledConversation): boolean {
  const cutoff = Date.now() - ACTIVE_WINDOW_MS;
  const recentLead = conversation.messages.some(
    (m) => m.sender === 'LEAD' && m.timestamp.getTime() >= cutoff
  );
  if (!recentLead) return false;
  // "Bot side" includes both AI auto-replies AND HUMAN messages —
  // operator manually responding from the dashboard or their phone is
  // still "someone responded to the lead". Without HUMAN here, an
  // operator dropping a quick reply from their phone (humanSource=
  // PHONE) within the active window would still let the silent-stop
  // soft-close fire 5–10 min later — the @shepherdgushe.zw 2026-05-05
  // incident showed exactly this shape (HUMAN at 9:54, lead at 9:57,
  // silent-stop at 10:02).
  const recentBotSide = conversation.messages.some(
    (m) =>
      (m.sender === 'AI' || m.sender === 'HUMAN') &&
      m.timestamp.getTime() >= cutoff
  );
  return recentBotSide || conversation.awaitingAiResponse === true;
}

export const ACTIVE_WINDOW_MS_FOR_TEST = ACTIVE_WINDOW_MS;
export function isConversationActiveForTest(args: {
  awaitingAiResponse: boolean;
  messages: Array<{ sender: string; timestamp: Date }>;
}): boolean {
  return isConversationActive(args as unknown as StalledConversation);
}

function latestNonSystemMessage(conversation: StalledConversation) {
  return conversation.messages
    .slice()
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .find((message) => message.sender !== 'SYSTEM');
}

function latestLeadAlreadyAnswered(conversation: StalledConversation): boolean {
  const lastLead = latestLeadMessage(conversation);
  const latest = latestNonSystemMessage(conversation);
  if (!lastLead || !latest) return false;
  if (latest.timestamp.getTime() <= lastLead.timestamp.getTime()) return false;
  return latest.sender === 'AI' || latest.sender === 'HUMAN';
}

export function latestLeadAlreadyAnsweredForTest(args: {
  messages: Array<{ sender: string; content?: string; timestamp: Date }>;
}): boolean {
  return latestLeadAlreadyAnswered(args as unknown as StalledConversation);
}

async function repairAnsweredAwaitingState(
  conversation: StalledConversation
): Promise<void> {
  const latest = latestNonSystemMessage(conversation);
  if (!latest) return;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      awaitingAiResponse: false,
      awaitingSince: null,
      lastMessageAt: latest.timestamp
    }
  });
}

function countAiMessages(conversation: StalledConversation): number {
  return conversation.messages.filter((message) => message.sender === 'AI')
    .length;
}

function capturedDataPointsAsRecord(
  conversation: StalledConversation
): Record<string, unknown> {
  const points = conversation.capturedDataPoints;
  if (!points || typeof points !== 'object' || Array.isArray(points)) {
    return {};
  }
  return points as Record<string, unknown>;
}

function capturedPointHasValue(
  points: Record<string, unknown>,
  key: string
): boolean {
  const point = points[key];
  if (point === null || point === undefined || point === '') return false;
  if (typeof point === 'object' && !Array.isArray(point) && 'value' in point) {
    const value = (point as { value?: unknown }).value;
    return value !== null && value !== undefined && value !== '';
  }
  return true;
}

function isManyChatOpeningHandoff(conversation: StalledConversation): boolean {
  if (conversation.source !== 'MANYCHAT') return false;
  if (countAiMessages(conversation) > 3) return false;

  // Lead must have engaged at least once (button click on the opener
  // gets stored as a LEAD message). The original check required the
  // LATEST non-system message to be LEAD — too strict for realistic
  // flows where ManyChat sends additional automation DMs after the
  // button click ("Perfect…6 minutes of sauce", "Did You Give it a
  // watch?"). Those land as MANYCHAT messages and shifted the latest-
  // non-system pointer off LEAD, causing the discovery bridge to
  // skip and the regular AI engine to take over → R24/Fix B gates
  // exhausted → escalation. Just check that LEAD has shown up at all.
  const hasLeadEngagement = conversation.messages.some(
    (message) => message.sender === 'LEAD'
  );
  if (!hasLeadEngagement) return false;

  const points = capturedDataPointsAsRecord(conversation);
  return (
    !capturedPointHasValue(points, 'workBackground') &&
    !capturedPointHasValue(points, 'incomeGoal')
  );
}

// Eligibility for the canned discovery-bridge: the lead's only message
// is a button-click acceptance (e.g. "Yes, send it over!"). When the
// lead has sent additional free-text content, the canned response would
// ignore that context (e.g. lead says "I've trade for around 1.5years"
// and the bridge still asks "what's your trading background"). Routing
// such conversations through the regular AI recovery path lets the
// engine read and react to what was actually said.
function onlyButtonClickAcceptanceReceived(
  conversation: StalledConversation
): boolean {
  const leadMessages = conversation.messages.filter(
    (message) => message.sender === 'LEAD'
  );
  if (leadMessages.length === 0) return true;
  if (leadMessages.length > 1) return false;
  return isExplicitAcceptance(leadMessages[0].content);
}

function hasUsablePlatformRecipient(
  conversation: StalledConversation
): boolean {
  if (conversation.lead.platform !== 'INSTAGRAM') return true;
  return /^\d{12,}$/.test(conversation.lead.platformUserId?.trim() || '');
}

function manyChatOutboundReference(conversation: StalledConversation): string {
  const opener = conversation.manyChatOpenerMessage?.trim() || '';
  if (/\bsession\s+liquidity\s+model\b/i.test(opener)) {
    return 'the Session Liquidity Model';
  }
  if (/\bslm\b/i.test(opener)) {
    return 'the SLM';
  }
  if (/\bliquidity\s+model\b/i.test(opener)) {
    return 'the liquidity model';
  }
  if (/\b(breakdown|training|video|resource|course)\b/i.test(opener)) {
    return 'that breakdown';
  }
  return 'that breakdown';
}

function buildManyChatOpeningRecovery(
  conversation: StalledConversation
): RecoveryDraft {
  const reference = manyChatOutboundReference(conversation);
  return {
    success: true,
    action: 'manychat_opening_discovery_bridge',
    messages: [
      `sick, since you wanted ${reference}, what's your trading background right now, been at it for a while or pretty new?`
    ],
    stage: 'DISCOVERY',
    subStage: null,
    capitalOutcome: 'not_evaluated',
    reason: 'manychat_opening_discovery_bridge'
  };
}

export function buildManyChatOpeningRecoveryForTest(
  conversation: StalledConversation
): RecoveryDraft {
  return buildManyChatOpeningRecovery(conversation);
}

export function isManyChatOpeningHandoffForTest(
  conversation: StalledConversation
): boolean {
  return isManyChatOpeningHandoff(conversation);
}

function buildSilentStopVoiceQualityOptions(
  conversation: StalledConversation,
  draft: RecoveryDraft
) {
  return {
    conversationSource: conversation.source,
    aiMessageCount: countAiMessages(conversation) + draft.messages.length,
    capturedDataPoints: capturedDataPointsAsRecord(conversation)
  };
}

function shouldSuppressManyChatOpeningEscalation(
  conversation: StalledConversation,
  reason: string
): boolean {
  if (!isManyChatOpeningHandoff(conversation)) return false;
  return !/\b(distress|human|requested_human)\b/i.test(reason);
}

function containsExplicitHumanRequest(messages: { content: string }[]) {
  const text = messages.map((message) => message.content).join('\n');
  return /\b(human|real person|person|operator|someone else|manager|admin)\b.{0,40}\b(help|reply|respond|talk|speak|handle)\b/i.test(
    text
  );
}

function containsOffScriptQuestion(messages: { content: string }[]) {
  const text = messages.map((message) => message.content).join('\n');
  return (
    /\b(refund|lawsuit|legal|taxes|medical|visa|immigration|guarantee|contract)\b/i.test(
      text
    ) || /\?$/.test(text.trim())
  );
}

function classifyContextualPattern(text: string): string | null {
  const lower = text.trim().toLowerCase();
  if (
    /^(it could be|maybe|i think so|kind of|kinda|sometimes|i guess|both)\b/i.test(
      lower
    )
  ) {
    return 'hedging_answer';
  }
  if (
    /(lord'?s|god'?s|faith|trust(ing)? the (process|timing)|blessing|amen)\b/i.test(
      lower
    )
  ) {
    return 'religious_framing';
  }
  // Jefferson @namejeffe 2026-05-03 — positive volunteered disclosure.
  // Lead self-reports forward motion (paper trade account, started
  // reading, in progress on a prop firm, etc.) without being asked.
  // The existing patterns don't catch this and the AI freezes instead
  // of bridging to capital. More specific than `vague_motivation`, so
  // place it before that branch but after the more-specific
  // hedging/religious patterns.
  if (
    /\b(already|been|started|in progress|just\s+(got|started|did))\b.{0,80}\b(account|setup|trading|practice|paper|prop|funded|reading|learning|studying|grinding)\b/i.test(
      lower
    )
  ) {
    return 'positive_volunteered_disclosure';
  }
  if (
    /(figure it out|see what happens|just want to|some day|someday|eventually)\b/i.test(
      lower
    )
  ) {
    return 'vague_motivation';
  }
  return null;
}

export function buildContextualSilentStopReEngagementForTest(text: string) {
  return buildContextualReEngagement(text);
}

function buildContextualReEngagement(text: string): RecoveryDraft | null {
  const pattern = classifyContextualPattern(text);

  if (pattern === 'religious_framing') {
    return {
      success: true,
      action: 'faith_respectful_capital_bridge',
      messages: [
        'respect bro, faith and patience are real',
        "but while we wait on the timing, what's your capital situation looking like for the markets right now? just so i can point you to something that fits where you're at"
      ],
      stage: 'FINANCIAL_SCREENING',
      subStage: 'CAPITAL_QUALIFICATION',
      capitalOutcome: 'not_asked',
      reason: 'religious_framing_bridge'
    };
  }

  if (pattern === 'hedging_answer') {
    return {
      success: true,
      action: 'capital_bridge',
      messages: [
        'fair enough bro. shifting gears, what we working with capital-wise on the markets side? just wanna make sure i steer you right'
      ],
      stage: 'FINANCIAL_SCREENING',
      subStage: 'CAPITAL_QUALIFICATION',
      capitalOutcome: 'not_asked',
      reason: 'hedging_answer_bridge'
    };
  }

  if (pattern === 'vague_motivation') {
    return {
      success: true,
      action: 'specificity_push',
      messages: [
        "real quick bro, what's your capital situation like for the markets right now? just so i know where you're at"
      ],
      stage: 'FINANCIAL_SCREENING',
      subStage: 'CAPITAL_QUALIFICATION',
      capitalOutcome: 'not_asked',
      reason: 'vague_motivation_bridge'
    };
  }

  if (pattern === 'positive_volunteered_disclosure') {
    // First introduction of templated-with-randomness in this module.
    // Three near-equivalent acknowledge-and-bridge variants so the
    // template doesn't get pattern-detected by leads who see it more
    // than once across re-tests / repeat conversations.
    const templates = [
      "that's fire bro 🔥 love that you're already moving on it. real quick, what's your capital situation looking like for the markets right now? just so i can point you to something that fits where you're at",
      "respect bro 💪🏿 that's exactly the energy that separates serious from talkers. before we go deeper, what we working with capital-wise on the markets side?",
      "bet bro that's wassup, you're already ahead of most. what's the capital situation though? just wanna make sure i steer you right"
    ];
    const message = templates[Math.floor(Math.random() * templates.length)];
    return {
      success: true,
      action: 'positive_disclosure_capital_bridge',
      messages: [message],
      stage: 'FINANCIAL_SCREENING',
      subStage: 'CAPITAL_QUALIFICATION',
      capitalOutcome: 'not_asked',
      reason: 'positive_disclosure_bridge'
    };
  }

  return null;
}

function buildSoftClose(): RecoveryDraft {
  return {
    success: true,
    action: 'soft_close',
    messages: [
      "yo bro you still around? wanna make sure i don't leave you hanging"
    ],
    stage: 'QUALIFYING',
    subStage: null,
    capitalOutcome: 'not_evaluated',
    reason: 'fallback_soft_close'
  };
}

function buildStoredGeneratedResult(draft: RecoveryDraft, eventId: string) {
  return {
    reply: draft.messages[0] || '',
    messages: draft.messages,
    stage: draft.stage,
    subStage: draft.subStage,
    stageConfidence: 1,
    sentimentScore: 0,
    experiencePath: null,
    objectionDetected: null,
    stallType: null,
    affirmationDetected: false,
    followUpNumber: null,
    softExit: false,
    escalateToHuman: false,
    leadTimezone: null,
    selectedSlotIso: null,
    leadEmail: null,
    shouldVoiceNote: false,
    voiceNoteAction: null,
    suggestedTag: '',
    suggestedTags: [],
    suggestedDelay: 0,
    systemPromptVersion: 'silent-stop-recovery-v1',
    suggestionId: null,
    capitalOutcome: draft.capitalOutcome,
    selfRecovered: true,
    selfRecoveryEventId: eventId,
    selfRecoveryReason: draft.reason,
    systemStage: draft.stage,
    currentScriptStep: null
  };
}

async function fetchStalledConversations(now = new Date()) {
  const threshold = new Date(now.getTime() - SILENCE_THRESHOLD_MS);
  const dedupCutoff = new Date(now.getTime() - DETECTION_DEDUP_MS);

  return prisma.conversation.findMany({
    where: {
      aiActive: true,
      awaitingAiResponse: true,
      awaitingHumanReview: false,
      awaitingSince: { lt: threshold },
      // Belt-and-suspenders DB-side filter mirroring the
      // isConversationActive guard. `lastMessageAt` is bumped on every
      // message write, so requiring it to be older than the silence
      // threshold rules out the burst-typing case before we even
      // hydrate the conversation in JS.
      lastMessageAt: { lt: threshold },
      OR: [
        { lastSilentStopAt: null },
        { lastSilentStopAt: { lt: dedupCutoff } }
      ]
    },
    include: {
      lead: true,
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 40,
        select: {
          id: true,
          sender: true,
          content: true,
          timestamp: true
        }
      }
    },
    orderBy: { awaitingSince: 'asc' },
    take: MAX_HEARTBEAT_BATCH
  });
}

// Time-based fallback for ManyChat-handoff'd conversations stuck because
// the operator's automation never fired the completion webhook
// (manychat-complete). The handoff webhook fires EARLY (when the lead
// taps the opener button) and intentionally leaves `awaitingAiResponse`
// false because the ManyChat sequence is still in flight. The completion
// webhook is supposed to flip it to true at the end. If the operator
// forgets to wire that final step, this fallback flips the flag once the
// lead's last message has been sitting unanswered for >5 min — same
// signal the existing heartbeat already uses.
//
// Idempotent. Skips rows already-flipped, rows whose latest message is
// not from LEAD, and rows recently touched by a recovery attempt
// (`lastSilentStopAt` dedup window matches the main fetcher's).
async function recoverManyChatStuckConversations(
  now = new Date()
): Promise<number> {
  const threshold = new Date(now.getTime() - SILENCE_THRESHOLD_MS);
  const dedupCutoff = new Date(now.getTime() - DETECTION_DEDUP_MS);

  const candidates = await prisma.conversation.findMany({
    where: {
      source: 'MANYCHAT',
      awaitingAiResponse: false,
      lead: { stage: { in: ['NEW_LEAD', 'ENGAGED'] } },
      OR: [
        { lastSilentStopAt: null },
        { lastSilentStopAt: { lt: dedupCutoff } }
      ]
    },
    select: {
      id: true,
      awaitingSince: true,
      lead: { select: { handle: true } },
      messages: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { sender: true, timestamp: true }
      }
    },
    take: MAX_HEARTBEAT_BATCH
  });

  let flipped = 0;
  for (const conv of candidates) {
    const last = conv.messages[0];
    if (!last || last.sender !== 'LEAD') continue;
    if (last.timestamp >= threshold) continue;

    // Race vs the completion endpoint: if the endpoint already set
    // `awaitingSince=now()` and our scan ran first this tick, we'd
    // clobber forward in time with `lastLead.timestamp`, making the row
    // look LESS stale than it is. Pick the newer of the two.
    const existing = conv.awaitingSince ? conv.awaitingSince.getTime() : 0;
    const fromLead = last.timestamp.getTime();
    const awaitingSince = new Date(Math.max(existing, fromLead));

    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        aiActive: true,
        awaitingAiResponse: true,
        awaitingSince
      }
    });
    flipped += 1;
    console.log(
      `[silent-stop] manychat fallback flipped ${conv.id} @${conv.lead?.handle ?? 'unknown'} awaitingSince=${awaitingSince.toISOString()}`
    );
  }
  return flipped;
}

async function diagnoseStopReason(
  conversation: StalledConversation,
  lastLeadAt: Date
): Promise<Diagnosis> {
  const scheduled = await prisma.scheduledReply.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
    select: { status: true, attempts: true, lastError: true }
  });

  if (scheduled?.status === 'FAILED') {
    return {
      reason: 'scheduled_reply_failed',
      lastGateViolation: scheduled.lastError,
      regenAttempts: scheduled.attempts
    };
  }

  const latestFailure = await prisma.voiceQualityFailure.findFirst({
    where: {
      accountId: conversation.lead.accountId,
      createdAt: { gte: lastLeadAt }
    },
    orderBy: { createdAt: 'desc' },
    select: { hardFails: true, attempt: true }
  });

  if (latestFailure) {
    const hardFails = JSON.stringify(latestFailure.hardFails);
    return {
      reason:
        latestFailure.attempt >= 3
          ? 'regen_exhaustion'
          : 'gate_rejection_no_fallback',
      lastGateViolation: hardFails.slice(0, 500),
      regenAttempts: latestFailure.attempt
    };
  }

  if (!scheduled) {
    return {
      reason: 'no_generation_log_found',
      lastGateViolation: null,
      regenAttempts: 0
    };
  }

  return {
    reason: 'unknown',
    lastGateViolation: scheduled.lastError,
    regenAttempts: scheduled.attempts
  };
}

async function checkAutoTriggerSafety(
  conversation: StalledConversation
): Promise<SafetyResult> {
  const recent = conversation.messages.slice(0, 10);
  if (
    conversation.distressDetected ||
    recent.some((message) => detectDistress(message.content).detected)
  ) {
    return { safe: false, reason: 'distress_detected_requires_human' };
  }

  if (containsExplicitHumanRequest(conversation.messages.slice(0, 3))) {
    return { safe: false, reason: 'lead_requested_human' };
  }

  if (isManyChatOpeningHandoff(conversation)) {
    if (!hasUsablePlatformRecipient(conversation)) {
      return { safe: false, reason: 'manychat_missing_instagram_recipient_id' };
    }
    return { safe: true, reason: null };
  }

  if (conversation.silentStopCount >= 2) {
    return { safe: false, reason: 'repeated_silent_stops_pattern_failure' };
  }

  if (
    conversation.silentStopCount > 0 &&
    containsOffScriptQuestion(conversation.messages.slice(0, 3))
  ) {
    return { safe: false, reason: 'off_script_question_unhandled' };
  }

  return { safe: true, reason: null };
}

async function triggerAiSelfRecovery(
  conversation: StalledConversation,
  diagnosis: Diagnosis
): Promise<RecoveryDraft> {
  if (
    isManyChatOpeningHandoff(conversation) &&
    onlyButtonClickAcceptanceReceived(conversation)
  ) {
    return buildManyChatOpeningRecovery(conversation);
  }

  const history = historyFromMessages(conversation.messages);
  const lastLead = latestLeadMessage(conversation);
  const contextual = lastLead
    ? buildContextualReEngagement(lastLead.content)
    : null;
  const stateMachineRecovery = await attemptSelfRecovery({
    accountId: conversation.lead.accountId,
    conversationId: conversation.id,
    history,
    triggerReason: `silent_stop_${diagnosis.reason}`,
    approvalMode: false
  }).catch((err) => {
    console.error('[silent-stop] state-machine recovery failed:', err);
    return null;
  });

  if (stateMachineRecovery?.recovered) {
    if (
      contextual &&
      (stateMachineRecovery.recoveryAction === 'ASK_QUESTION' ||
        stateMachineRecovery.capitalOutcome === 'not_asked')
    ) {
      return contextual;
    }
    return {
      success: true,
      action: stateMachineRecovery.recoveryAction || 'state_machine_advance',
      messages: stateMachineRecovery.messages,
      stage: stateMachineRecovery.stage || 'QUALIFYING',
      subStage: stateMachineRecovery.subStage,
      capitalOutcome: stateMachineRecovery.capitalOutcome,
      reason: stateMachineRecovery.reason
    };
  }

  if (contextual) return contextual;

  return buildSoftClose();
}

async function routeToOperatorReview(params: {
  conversation: StalledConversation;
  eventId: string;
  reason: string;
}) {
  const { conversation, eventId, reason } = params;
  if (shouldSuppressManyChatOpeningEscalation(conversation, reason)) {
    await prisma.silentStopEvent.update({
      where: { id: eventId },
      data: {
        recoveryStatus: 'FAILED',
        recoveryAction: 'manychat_opening_escalation_suppressed',
        recoveryAttempted: true,
        triggeredAt: new Date()
      }
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        aiActive: true,
        awaitingAiResponse: false,
        awaitingSince: null,
        lastSilentStopAt: new Date()
      }
    });
    broadcastAIStatusChange(conversation.lead.accountId, {
      conversationId: conversation.id,
      aiActive: true
    });
    console.warn(
      `[silent-stop] suppressed ManyChat opening escalation for convo ${conversation.id}: ${reason}`
    );
    return;
  }

  await prisma.silentStopEvent.update({
    where: { id: eventId },
    data: {
      recoveryStatus: 'OPERATOR_REVIEW',
      recoveryAction: 'escalation',
      recoveryAttempted: false,
      triggeredAt: new Date()
    }
  });
  // We notify the operator (escalate() below) and tally the silent-stop
  // counter, but we DO NOT flip aiActive=false. Previously this path
  // permanently disabled the AI for the conversation, which meant a
  // lead returning later with high-intent ("I'm ready to take best
  // things who improve me") got NO reply because aiActive was stuck
  // off. The operator alert is enough; if they want to take over they
  // can toggle Human=ON from the UI.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      awaitingAiResponse: false,
      awaitingSince: null,
      silentStopCount: { increment: 1 },
      lastSilentStopAt: new Date()
    }
  });
  const origin = process.env.NEXT_PUBLIC_APP_URL || '';
  const link = origin
    ? `${origin.replace(/\/$/, '')}/dashboard/conversations?conversationId=${conversation.id}`
    : undefined;
  await escalate({
    type: 'ai_stuck',
    accountId: conversation.lead.accountId,
    leadId: conversation.lead.id,
    conversationId: conversation.id,
    leadName: conversation.lead.name,
    leadHandle: conversation.lead.handle,
    title: 'Silent stop needs operator review',
    body: `${conversation.lead.name} (@${conversation.lead.handle}) went silent after a lead reply. Auto-trigger was blocked: ${reason}.`,
    details: `SilentStopEvent ${eventId}: ${reason}`,
    link
  }).catch((err) =>
    console.error('[silent-stop] operator escalation failed:', err)
  );
}

async function maybeAlertSilentStopSpike(accountId: string) {
  const now = Date.now();
  const recentEvents = await prisma.silentStopEvent.findMany({
    where: {
      detectedAt: { gte: new Date(now - SPIKE_WINDOW_MS) },
      conversation: { lead: { accountId } }
    },
    select: { id: true }
  });
  if (recentEvents.length <= 5) return;

  const existing = await prisma.notification.findFirst({
    where: {
      accountId,
      title: { contains: 'Silent stops spike' },
      createdAt: { gte: new Date(now - SPIKE_WINDOW_MS) }
    },
    select: { id: true }
  });
  if (existing) return;

  const title = `Silent stops spike: ${recentEvents.length} in 1h`;
  const body =
    'Silent-stop heartbeat detected more than 5 stalled AI responses in the last hour. Check recent gate failures, tokens, and webhook logs.';
  await prisma.notification
    .create({
      data: { accountId, type: 'SYSTEM', title, body }
    })
    .catch((err) =>
      console.error('[silent-stop] spike notification failed:', err)
    );
  broadcastNotification(accountId, { type: 'SYSTEM', title });

  if (process.env.SLACK_WEBHOOK_URL) {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${title}: ${body}` })
    }).catch((err) =>
      console.error('[silent-stop] spike Slack alert failed:', err)
    );
  }
}

async function maybeAlertLowRecoveryRate(accountId: string) {
  const windowStart = new Date(Date.now() - RECOVERY_RATE_WINDOW_MS);
  const events = await prisma.silentStopEvent.findMany({
    where: {
      detectedAt: { gte: windowStart },
      recoveryAttempted: true,
      conversation: { lead: { accountId } }
    },
    select: { recoveryStatus: true }
  });
  if (events.length < 5) return;
  const successes = events.filter(
    (event) => event.recoveryStatus === 'AUTO_TRIGGERED'
  ).length;
  const successRate = successes / events.length;
  if (successRate >= 0.7) return;

  const existing = await prisma.notification.findFirst({
    where: {
      accountId,
      title: { contains: 'Silent stop recovery rate low' },
      createdAt: { gte: windowStart }
    },
    select: { id: true }
  });
  if (existing) return;

  const title = 'Silent stop recovery rate low';
  const body = `Silent-stop auto-recovery success is ${Math.round(successRate * 100)}% over the last 24h (${successes}/${events.length}). Review failed recoveries before they cool off leads.`;
  await prisma.notification
    .create({
      data: { accountId, type: 'SYSTEM', title, body }
    })
    .catch((err) =>
      console.error('[silent-stop] low recovery notification failed:', err)
    );
  broadcastNotification(accountId, { type: 'SYSTEM', title });

  if (process.env.SLACK_WEBHOOK_URL) {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${title}: ${body}` })
    }).catch((err) =>
      console.error('[silent-stop] low recovery Slack alert failed:', err)
    );
  }
}

export async function handleSilentStop(
  conversation: StalledConversation
): Promise<'AUTO_TRIGGERED' | 'OPERATOR_REVIEW' | 'FAILED' | 'SKIPPED'> {
  const lastLead = latestLeadMessage(conversation);
  if (!lastLead) return 'SKIPPED';

  // If an AI/HUMAN row exists after the latest lead row, the lead was
  // already answered. A stale Conversation.awaitingAiResponse flag can
  // happen if a long multi-bubble delivery times out after writing the
  // bubbles but before the final conversation-row update. Do not create
  // a silent-stop event in that state; repair the row and skip.
  if (latestLeadAlreadyAnswered(conversation)) {
    console.log(
      `[silent-stop] inner skip ${conversation.id}: latest lead already answered; repairing stale awaiting state`
    );
    await repairAnsweredAwaitingState(conversation);
    return 'SKIPPED';
  }

  // Belt-and-suspenders re-check at the inner level. The
  // silentStopHeartbeat caller already filters by
  // isConversationActive, but a deploy-timing race between cron
  // promotion and code load could let an active conversation slip
  // past — re-evaluate against the same invariant here so the
  // soft-close cannot ship in that window.
  if (isConversationActive(conversation)) {
    console.log(
      `[silent-stop] inner skip ${conversation.id}: lead still active (last 10 min)`
    );
    return 'SKIPPED';
  }

  const now = new Date();
  const diagnosis = await diagnoseStopReason(conversation, lastLead.timestamp);
  const event = await prisma.silentStopEvent.create({
    data: {
      conversationId: conversation.id,
      detectedAt: now,
      lastLeadMessageAt: lastLead.timestamp,
      silenceDurationMs: now.getTime() - lastLead.timestamp.getTime(),
      detectedReason: diagnosis.reason,
      lastGateViolation: diagnosis.lastGateViolation,
      lastRegenAttempts: diagnosis.regenAttempts,
      recoveryStatus: 'PENDING'
    }
  });

  const safety = await checkAutoTriggerSafety(conversation);
  if (!safety.safe) {
    await routeToOperatorReview({
      conversation,
      eventId: event.id,
      reason: safety.reason || 'unsafe_for_auto_trigger'
    });
    return 'OPERATOR_REVIEW';
  }

  const draft = await triggerAiSelfRecovery(conversation, diagnosis);
  const quality = scoreVoiceQualityGroup(
    draft.messages,
    buildSilentStopVoiceQualityOptions(conversation, draft)
  );
  if (!quality.passed) {
    await prisma.silentStopEvent.update({
      where: { id: event.id },
      data: {
        recoveryAttempted: true,
        recoveryAction: draft.action,
        recoveryMessageSent: draft.messages.join('\n'),
        recoveryStatus: 'FAILED',
        triggeredAt: new Date()
      }
    });
    await routeToOperatorReview({
      conversation,
      eventId: event.id,
      reason: `recovery_quality_gate_failed:${quality.hardFails.join(',')}`
    });
    return 'FAILED';
  }

  await prisma.silentStopEvent.update({
    where: { id: event.id },
    data: {
      recoveryAttempted: true,
      recoveryAction: draft.action,
      recoveryMessageSent: draft.messages.join('\n'),
      recoveryStatus: 'AUTO_TRIGGERED',
      triggeredAt: new Date()
    }
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      silentStopCount: { increment: 1 },
      silentStopRecoveredCount: { increment: 1 },
      lastSilentStopAt: new Date()
    }
  });

  try {
    await processScheduledReply(conversation.id, conversation.lead.accountId, {
      generatedResult: buildStoredGeneratedResult(draft, event.id),
      createdAt: new Date(),
      messageType: 'silent_stop_recovery'
    });

    const latest = await prisma.message.findFirst({
      where: { conversationId: conversation.id, sender: { not: 'SYSTEM' } },
      orderBy: { timestamp: 'desc' },
      select: { sender: true }
    });
    if (latest?.sender === 'LEAD') {
      throw new Error('silent_stop_recovery_no_message_sent');
    }

    await prisma.silentStopEvent.update({
      where: { id: event.id },
      data: { resolvedAt: new Date() }
    });
    return 'AUTO_TRIGGERED';
  } catch (err) {
    console.error('[silent-stop] auto-trigger send failed:', err);
    await prisma.silentStopEvent.update({
      where: { id: event.id },
      data: {
        recoveryStatus: 'FAILED',
        recoveryAction: draft.action,
        recoveryMessageSent: draft.messages.join('\n')
      }
    });
    await routeToOperatorReview({
      conversation,
      eventId: event.id,
      reason: err instanceof Error ? err.message : 'auto_trigger_failed'
    });
    return 'FAILED';
  }
}

export async function silentStopHeartbeat(): Promise<SilentStopHeartbeatResult> {
  // Run the ManyChat-stuck recovery FIRST so any rows it flips become
  // visible to the main `fetchStalledConversations` query in this same
  // heartbeat tick (no 1-minute wait for the next cron run).
  const manyChatRecovered = await recoverManyChatStuckConversations();

  const candidates = await fetchStalledConversations();
  // Final in-memory guard. The DB query already filters by
  // `lastMessageAt < threshold`, but a conversation could still slip
  // through if the row was hydrated with messages whose timestamps
  // race the conversation-row update. isConversationActive enforces
  // the invariant against the actual message rows we read.
  const stalled: StalledConversation[] = [];
  for (const c of candidates) {
    if (latestLeadAlreadyAnswered(c)) {
      console.log(
        `[silent-stop] skip ${c.id}: latest lead already answered; repairing stale awaiting state`
      );
      await repairAnsweredAwaitingState(c);
      continue;
    }
    if (isConversationActive(c)) {
      console.log(
        `[silent-stop] skip ${c.id}: lead still active (last 10 min)`
      );
      continue;
    }
    stalled.push(c);
  }
  const result: SilentStopHeartbeatResult = {
    scanned: stalled.length,
    detected: 0,
    autoTriggered: 0,
    operatorReview: 0,
    failed: 0,
    manyChatRecovered
  };
  const accountIds = new Set<string>();

  for (const conversation of stalled) {
    accountIds.add(conversation.lead.accountId);
    const status = await handleSilentStop(conversation);
    if (status === 'SKIPPED') continue;
    result.detected++;
    if (status === 'AUTO_TRIGGERED') result.autoTriggered++;
    if (status === 'OPERATOR_REVIEW') result.operatorReview++;
    if (status === 'FAILED') result.failed++;
  }

  await Promise.all(
    Array.from(accountIds).map(async (accountId) => {
      await maybeAlertSilentStopSpike(accountId);
      await maybeAlertLowRecoveryRate(accountId);
    })
  );

  return result;
}
