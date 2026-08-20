// ---------------------------------------------------------------------------
// Fix D — Phase 0: egress gate (shadow, then authoritative at cutover).
// ---------------------------------------------------------------------------
// Called from the physical send choke point.
//
// SHADOW mode (default): the live code has already decided to send, so the
// verdict is logged only — every disagreement row (machineAllow=false) is the
// review queue. Returns { block:false } always; nothing is prevented.
//
// AUTHORITATIVE mode (cutover): when FIX_D_CANSEND_AUTHORITATIVE names a
// platform (e.g. "FACEBOOK") the machine's verdict is ENFORCED for that
// platform — a blocked send returns { block:true } and the caller aborts the
// send. IG stays shadow until its own window (cutover condition 3).
//
// Flags:
//   FIX_D_EGRESS_SHADOW           default ON  — log-only shadow rows.
//   FIX_D_CANSEND_AUTHORITATIVE   csv of platforms to ENFORCE (default none).
//
// Fail-open invariant: any error resolving state fails OPEN (never blocks a
// real send on our own bug) but logs loudly. NO_CONVERSATION_STATE is the
// one exception under authoritative — it blocks and alerts (cond 2), because
// a send we can't attribute to a conversation is exactly what the gate is for.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { canSend, deriveMachineState } from './can-send';

const SHADOW_ENABLED = process.env.FIX_D_EGRESS_SHADOW !== 'false';

function isAuthoritativeForPlatform(platform: string | null): boolean {
  const raw = process.env.FIX_D_CANSEND_AUTHORITATIVE;
  if (!raw) return false;
  const set = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (set.includes('ALL')) return true;
  return platform ? set.includes(platform.toUpperCase()) : false;
}

// Best-effort shadow-log write. Swallows its OWN errors so a flaky DB write
// (the intermittent pooler init error) can never bubble into the gate's
// enforcement path and fail it open. Test 4 root cause: the log create() was
// inline, so its failure allowed a send that the verdict said to block.
async function logShadowRow(data: {
  accountId: string;
  conversationId: string | null;
  sendPath: string;
  draftPreview: string;
  machineAllow: boolean;
  machineReason: string | null;
  machineHold: string | null;
  agreed: boolean;
}): Promise<void> {
  try {
    await prisma.egressShadowLog.create({ data });
  } catch (err) {
    console.error(
      '[fix-d/egress] shadow-log write failed (non-fatal, enforcement unaffected):',
      err instanceof Error ? err.message : err
    );
  }
}

export interface EgressGateResult {
  block: boolean;
  reason?: string;
  detail?: string;
}

// Coarse caller tag from the stack — first app frame outside this module and
// the send module. Diagnostic only; never load-bearing.
function inferSendPath(): string {
  try {
    const frames = (new Error().stack ?? '').split('\n').slice(1);
    const app = frames.find(
      (f) =>
        f.includes('/src/') &&
        !f.includes('/state-machine/') &&
        !f.includes('/instagram')
    );
    const m = app && /\/src\/(.+?\.ts)/.exec(app);
    return m ? m[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function shadowEgressCheck(params: {
  accountId: string;
  recipientId: string;
  messageText: string;
  platform?: string | null;
  // The conversation this send targets. When provided, the gate resolves
  // state from THIS exact conversation — the authoritative, correct path.
  // Test 4 (Tega 2026-08-19) failed because, absent this, the gate fell back
  // to a heuristic (latest lead by platformUserId → latest conversation by
  // lastMessageAt) and, for a lead with multiple conversations, checked a
  // DIFFERENT conversation than the one being sent to — so a held
  // conversation's send was allowed. Every send path that knows its
  // conversationId (nearly all) must pass it; the heuristic is a last resort.
  conversationId?: string | null;
  // true for sends a human explicitly initiated (manual reply / approved
  // suggestion routes pass this once call sites adopt it; default false =
  // treat as AI-initiated, the conservative shadow reading).
  operatorInitiated?: boolean;
}): Promise<EgressGateResult> {
  const authoritative = isAuthoritativeForPlatform(params.platform ?? null);
  // Shadow logging can be off while authoritative is on (post-cutover we may
  // keep logging; the flags are independent). If BOTH are off, no-op allow.
  if (!SHADOW_ENABLED && !authoritative) return { block: false };
  // AWAITABLE (was fire-and-forget): on Vercel the serverless function can
  // be frozen the moment the handler returns, killing a detached promise
  // mid-write. That silently dropped every shadow row on the normal reply
  // path (the send returns immediately) while the distress path — which
  // awaits more work after the send — logged fine. The body is wrapped so
  // a shadow failure still never breaks a real send; callers await it (a
  // couple of cheap indexed reads + one insert).
  {
    try {
      const convSelect = {
        id: true,
        aiActive: true,
        distressDetected: true,
        schedulingConflict: true,
        awaitingHumanReview: true
      } as const;

      // PRIMARY: resolve the exact conversation the caller named. This is the
      // authoritative path — no guessing. (Test 4 fix.)
      let conv = params.conversationId
        ? await prisma.conversation.findUnique({
            where: { id: params.conversationId },
            select: convSelect
          })
        : null;

      // FALLBACK (heuristic): only when the caller didn't pass a
      // conversationId. Latest lead by platformUserId → latest conversation.
      // Ambiguous for a lead with multiple conversations; logged as such so
      // any remaining un-threaded call site is visible in the shadow data.
      let resolvedByHeuristic = false;
      if (!conv) {
        const lead = await prisma.lead.findFirst({
          where: {
            accountId: params.accountId,
            platformUserId: params.recipientId
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true }
        });
        conv = lead
          ? await prisma.conversation.findFirst({
              where: { leadId: lead.id },
              orderBy: { lastMessageAt: 'desc' },
              select: convSelect
            })
          : null;
        resolvedByHeuristic = Boolean(conv);
        if (resolvedByHeuristic) {
          console.warn(
            `[fix-d/egress] conversation resolved by HEURISTIC (no conversationId passed) for ` +
              `account ${params.accountId} recipient ${params.recipientId} → conv ${conv?.id}. ` +
              `This send path should thread conversationId for a correct gate decision.`
          );
        }
      }

      // No conversation resolvable — machine has no state to gate on.
      // Cutover condition 2: under authoritative this is BLOCK-and-alert (a
      // send we can't attribute to a conversation shouldn't ship); under
      // shadow it's logged allow, as before.
      if (!conv) {
        const blockNoState = authoritative;
        // Log is BEST-EFFORT (Test 4 fix): a log-write failure must NEVER
        // change the enforcement decision. Previously the create() ran before
        // the block return, so a flaky DB write threw into the outer catch and
        // failed OPEN — allowing a send that should have blocked.
        await logShadowRow({
          accountId: params.accountId,
          conversationId: null,
          sendPath: inferSendPath(),
          draftPreview: params.messageText.slice(0, 300),
          machineAllow: !blockNoState,
          machineReason: 'NO_CONVERSATION_STATE',
          machineHold: null,
          agreed: !blockNoState
        });
        if (blockNoState) {
          console.error(
            `[fix-d/egress] BLOCKED (authoritative): NO_CONVERSATION_STATE for ` +
              `account ${params.accountId} recipient ${params.recipientId} — ` +
              `send has no resolvable conversation to gate on.`
          );
          return {
            block: true,
            reason: 'NO_CONVERSATION_STATE',
            detail: 'no resolvable conversation for this send'
          };
        }
        return { block: false };
      }

      // Distinguish gate-exhaustion holds from generic review holds for the
      // typed-reason requirement.
      let qualityGateHeld = false;
      if (conv.awaitingHumanReview) {
        const gateFail = await prisma.voiceQualityFailure.findFirst({
          where: {
            accountId: params.accountId,
            createdAt: { gte: new Date(Date.now() - 48 * 60 * 60 * 1000) }
          },
          select: { id: true }
        });
        qualityGateHeld = Boolean(gateFail);
      }

      const state = deriveMachineState({ ...conv, qualityGateHeld });
      const verdict = canSend(state, {
        text: params.messageText,
        operatorInitiated: params.operatorInitiated ?? false
      });

      // Log is BEST-EFFORT and happens AFTER the verdict is decided. The
      // enforcement return below does not depend on this write succeeding.
      await logShadowRow({
        accountId: params.accountId,
        conversationId: conv.id,
        sendPath: inferSendPath(),
        draftPreview: params.messageText.slice(0, 300),
        machineAllow: verdict.allow,
        machineReason: verdict.allow ? null : verdict.reason,
        machineHold: verdict.allow ? null : (verdict.hold ?? null),
        agreed: authoritative ? true : verdict.allow
      });

      if (authoritative && !verdict.allow) {
        console.warn(
          `[fix-d/egress] BLOCKED (authoritative): ${verdict.reason}` +
            `${verdict.hold ? ` (${verdict.hold})` : ''} on conv ${conv.id} — ` +
            verdict.detail
        );
        return {
          block: true,
          reason: verdict.reason,
          detail: verdict.detail
        };
      }
      return { block: false };
    } catch (err) {
      // Fail-open ONLY for state-resolution failures (the reads needed to
      // DECIDE). A log-write failure can no longer reach here — logShadowRow
      // swallows its own errors — so a blocked send is never allowed just
      // because logging hiccuped (the Test 4 root cause).
      console.error(
        '[fix-d/egress] gate STATE RESOLUTION failed (failing OPEN, send proceeds):',
        err
      );
      return { block: false };
    }
  }
}
