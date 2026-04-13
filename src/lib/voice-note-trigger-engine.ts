// ---------------------------------------------------------------------------
// Voice Note Trigger Evaluation Engine
// ---------------------------------------------------------------------------
// Evaluates structured triggers against the current conversation context to
// select the best-matching library voice note. Runs after AI reply generation
// but before delivery.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { classifyContentIntent } from '@/lib/content-intent-classifier';
import {
  checkCooldown,
  checkGlobalFrequencyCap
} from '@/lib/voice-note-send-log';
import {
  parseTriggerJson,
  GLOBAL_VOICE_NOTE_FREQUENCY_CAP,
  type VoiceNoteTrigger,
  type ContentIntent
} from '@/lib/voice-note-triggers';

// ─── Types ────────────────────────────────────────────────────────────────

export interface TriggerEvaluationContext {
  accountId: string;
  leadId: string;
  leadStage: string; // Current LeadStage (UPPER_CASE)
  conversationId: string;
  lastLeadMessage: string;
  recentMessages: Array<{ sender: string; content: string }>;
  currentMessageIndex: number;
}

export interface TriggerEvaluationResult {
  matchedVoiceNote: {
    id: string;
    audioFileUrl: string;
    triggerType: string;
    priority: number;
  } | null;
  candidatesEvaluated: number;
  intentDetected: string | null;
}

interface CandidateMatch {
  id: string;
  audioFileUrl: string;
  triggerType: string;
  priority: number;
  lastEditedAt: Date;
}

// Trigger type precedence for ranking (lower = higher priority)
const TRIGGER_TYPE_PRECEDENCE: Record<string, number> = {
  stage_transition: 0,
  content_intent: 1,
  conversational_move: 2
};

// ─── Main Evaluation ──────────────────────────────────────────────────────

/**
 * Evaluate all active library voice notes' structured triggers against
 * the current conversation context. Returns the best match or null.
 */
export async function evaluateTriggers(
  ctx: TriggerEvaluationContext
): Promise<TriggerEvaluationResult> {
  const candidates: CandidateMatch[] = [];
  let intentDetected: string | null = null;

  // ── Step 1: Fetch all active voice notes with triggers ────────────
  const voiceNotes = await prisma.voiceNoteLibraryItem.findMany({
    where: {
      accountId: ctx.accountId,
      status: 'ACTIVE',
      active: true,
      triggers: { not: Prisma.JsonNull }
    },
    select: {
      id: true,
      audioFileUrl: true,
      triggers: true,
      priority: true,
      lastEditedAt: true
    }
  });

  // Filter out items with empty triggers arrays
  const withTriggers = voiceNotes.filter((vn) => {
    const parsed = parseTriggerJson(vn.triggers);
    return parsed.length > 0;
  });

  if (withTriggers.length === 0) {
    return { matchedVoiceNote: null, candidatesEvaluated: 0, intentDetected };
  }

  // ── Step 2 & 3: Check stage_transition and content_intent in parallel
  const [recentTransition, intentResult] = await Promise.all([
    // Get most recent stage transition for this lead
    prisma.leadStageTransition.findFirst({
      where: { leadId: ctx.leadId },
      orderBy: { createdAt: 'desc' },
      select: { fromStage: true, toStage: true, createdAt: true }
    }),
    // Classify content intent from last lead message
    (async () => {
      if (!ctx.lastLeadMessage.trim()) return null;
      const context = ctx.recentMessages
        .slice(-5)
        .map((m) => `${m.sender}: ${m.content}`)
        .join('\n');
      return classifyContentIntent(ctx.accountId, ctx.lastLeadMessage, context);
    })()
  ]);

  if (intentResult?.intent) {
    intentDetected = intentResult.intent;
  }

  // ── Evaluate each voice note's triggers ───────────────────────────
  for (const vn of withTriggers) {
    const triggers = parseTriggerJson(vn.triggers);

    for (const trigger of triggers) {
      const match = await evaluateSingleTrigger(trigger, {
        recentTransition,
        detectedIntent: intentResult?.intent ?? null,
        leadStage: ctx.leadStage,
        leadId: ctx.leadId,
        voiceNoteId: vn.id,
        currentMessageIndex: ctx.currentMessageIndex
      });

      if (match) {
        candidates.push({
          id: vn.id,
          audioFileUrl: vn.audioFileUrl,
          triggerType: trigger.type,
          priority: vn.priority,
          lastEditedAt: vn.lastEditedAt
        });
        break; // One match per voice note is enough — move to next VN
      }
    }
  }

  if (candidates.length === 0) {
    return {
      matchedVoiceNote: null,
      candidatesEvaluated: withTriggers.length,
      intentDetected
    };
  }

  // ── Step 5: Rank candidates ───────────────────────────────────────
  candidates.sort((a, b) => {
    // 1. Priority descending
    if (b.priority !== a.priority) return b.priority - a.priority;
    // 2. Trigger type precedence
    const precA = TRIGGER_TYPE_PRECEDENCE[a.triggerType] ?? 99;
    const precB = TRIGGER_TYPE_PRECEDENCE[b.triggerType] ?? 99;
    if (precA !== precB) return precA - precB;
    // 3. Most recently edited
    return b.lastEditedAt.getTime() - a.lastEditedAt.getTime();
  });

  // ── Step 6: Global frequency cap ─────────────────────────────────
  const capOk = await checkGlobalFrequencyCap({
    leadId: ctx.leadId,
    currentMessageIndex: ctx.currentMessageIndex,
    cap: GLOBAL_VOICE_NOTE_FREQUENCY_CAP
  });

  if (!capOk) {
    return {
      matchedVoiceNote: null,
      candidatesEvaluated: withTriggers.length,
      intentDetected
    };
  }

  const winner = candidates[0];
  return {
    matchedVoiceNote: {
      id: winner.id,
      audioFileUrl: winner.audioFileUrl,
      triggerType: winner.triggerType,
      priority: winner.priority
    },
    candidatesEvaluated: withTriggers.length,
    intentDetected
  };
}

// ─── Single Trigger Evaluation ────────────────────────────────────────────

interface SingleTriggerContext {
  recentTransition: {
    fromStage: string;
    toStage: string;
    createdAt: Date;
  } | null;
  detectedIntent: ContentIntent | null;
  leadStage: string;
  leadId: string;
  voiceNoteId: string;
  currentMessageIndex: number;
}

async function evaluateSingleTrigger(
  trigger: VoiceNoteTrigger,
  ctx: SingleTriggerContext
): Promise<boolean> {
  switch (trigger.type) {
    case 'stage_transition': {
      if (!ctx.recentTransition) return false;

      // Check if the transition is recent (within last 5 minutes)
      const ageMs = Date.now() - ctx.recentTransition.createdAt.getTime();
      if (ageMs > 5 * 60 * 1000) return false;

      // Match to_stage
      if (
        trigger.to_stage.toUpperCase() !==
        ctx.recentTransition.toStage.toUpperCase()
      ) {
        return false;
      }

      // Match from_stage (or "any")
      if (
        trigger.from_stage !== 'any' &&
        trigger.from_stage.toUpperCase() !==
          ctx.recentTransition.fromStage.toUpperCase()
      ) {
        return false;
      }

      return true;
    }

    case 'content_intent': {
      if (!ctx.detectedIntent) return false;
      return trigger.intent === ctx.detectedIntent;
    }

    case 'conversational_move': {
      // Gate 1: Stage check
      const stageMatch = trigger.required_pipeline_stages.some(
        (s) => s.toUpperCase() === ctx.leadStage.toUpperCase()
      );
      if (!stageMatch) return false;

      // Gate 2: Cooldown check
      const cooldownOk = await checkCooldown({
        leadId: ctx.leadId,
        voiceNoteId: ctx.voiceNoteId,
        cooldown: trigger.cooldown,
        currentMessageIndex: ctx.currentMessageIndex
      });
      if (!cooldownOk) return false;

      // Gate 3: AI judgment — in v1, we pass if gates 1+2 pass.
      // The suggested_moments field is used for description/display.
      // Future: could add Haiku-based moment matching here.
      return true;
    }

    default:
      return false;
  }
}
