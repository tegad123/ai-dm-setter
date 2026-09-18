import prisma from '@/lib/prisma';
import { z } from 'zod';
import { resolveActivePersonaIdForCreate } from '@/lib/active-persona';
import { resolveAndUpgradeInstagramNumericId } from '@/lib/manychat-resolve-ig-id';
import { getCredentials } from '@/lib/credential-store';
import { findSubscriberById } from '@/lib/manychat';

// ManyChat's {{contact.ig_username}} returns the raw numeric IGSID instead of
// the actual username when its subscriber cache is degraded — most commonly
// right after an Instagram re-auth event. Detect and resolve before persisting.
const NUMERIC_IGSID = /^\d{12,}$/;

const MANYCHAT_TRIGGER_TYPES = [
  'new_follower',
  'comment',
  'story_reply',
  'post_dm',
  'other'
] as const;

const manyChatBoolean = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());

const manyChatHandoffFields = z.object({
  // Coerce to string because ManyChat's variable picker outputs numeric
  // IDs as JSON numbers (not strings) for `user.id` — Zod's z.string()
  // would reject those without coercion.
  //
  // 2026-08-04 (Effa Fouda, launch blocker root cause): these two fields were
  // REQUIRED min(1). A Facebook contact has NO Instagram identity, so
  // ManyChat's External Request sends them empty (or omits them) for every
  // FB contact — and the schema 400'd EVERY real Facebook handoff, silently.
  // That is why zero genuinely-new FB contacts ever landed: the handoff
  // could never have succeeded regardless of ManyChat's wiring. They are now
  // optional at the field level; the superRefine below still REQUIRES both
  // for INSTAGRAM handoffs, so every existing IG config keeps its exact
  // contract.
  instagramUserId: z.coerce.string().optional().default(''),
  instagramUsername: z.string().optional().default(''),
  // Facebook contact identity (optional). For Messenger, ManyChat's
  // subscriber id IS the page-scoped PSID, so when this is absent the
  // handler falls back to manyChatSubscriberId — the same id Meta's FB
  // webhook delivers, so a later organic DM merges into this lead instead
  // of creating a duplicate.
  facebookUserId: z.coerce.string().optional(),
  // Display name for contacts without an IG username (FB contacts).
  contactName: z.string().max(200).optional(),
  // Platform of the ManyChat contact (2026-08-04, Tega item 2b). ManyChat
  // runs Instagram AND Facebook automations; the handler was Instagram-only,
  // so a brand-new FACEBOOK contact from Daniel's live automation was created
  // as an INSTAGRAM lead with an IG-shaped id the FB send path can't match —
  // the launch-blocking "Convlo shows no sign of it" for new FB contacts.
  // Optional + defaulted to INSTAGRAM so every existing ManyChat config keeps
  // working unchanged; FB automations add platform:"facebook".
  platform: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
      z.enum(['INSTAGRAM', 'FACEBOOK'])
    )
    .optional()
    .default('INSTAGRAM'),
  openerMessage: z.string().min(1).max(2000),
  triggerType: z.enum(MANYCHAT_TRIGGER_TYPES),
  commentText: z.string().max(2000).optional(),
  // The native question ManyChat's automation asked before handing off
  // (Tega B5, 2026-07-30). Optional — only present when the automation is
  // configured to send it. Stored so the AI won't re-ask it.
  nativeQuestion: z.string().max(2000).optional(),
  postUrl: z.string().max(2000).optional(),
  manyChatSubscriberId: z.coerce.string().min(1),
  // Optional in the wire format — ManyChat doesn't always expose a ready
  // ISO-8601 timestamp variable in their picker. When absent, the
  // handler defaults to server-time `new Date()` (set in
  // processManyChatHandoff below). When present it must still be a
  // valid datetime so we don't ingest gibberish.
  firedAt: z.string().datetime().optional(),
  // Lead's button-click response inside the ManyChat flow (e.g. "Yes,
  // send it over!" — what they tapped after the opener). Button taps
  // are internal to ManyChat — they don't fire IG webhooks, so without
  // this field the conversation in Convlo would show only the
  // opener and never the lead's first engagement signal. When the
  // operator wires a SECOND External Request in ManyChat right after
  // the button-click step, this field carries the button label back
  // and we insert it as a LEAD-side Message in the thread so the AI
  // sees it on its next turn.
  leadResponseText: z.string().min(1).max(2000).optional(),
  // Most ManyChat flows keep running after this External Request
  // (send the resource, wait, follow up). In that setup the request is
  // only a context sync and Convlo should wait for the next real
  // lead DM before AI takes over. Set scheduleAi=true only for flows
  // where this request is the final handoff point.
  scheduleAi: manyChatBoolean.optional().default(false),
  processingMode: z
    .enum(['legacy', 'queued_first_reply'])
    .optional()
    .default('legacy')
});

// Platform inference (2026-08-04): when the External Request body doesn't set
// `platform`, infer it — complete IG identity -> INSTAGRAM; facebookUserId
// present -> FACEBOOK; otherwise leave INSTAGRAM so the superRefine below
// produces a LOUD, specific error instead of a silent generic 400.
// Sentinel garbage ManyChat emits for unfilled variables. Proven live
// 2026-08-05: a Test Request created a lead whose name, handle AND
// platformUserId were the literal string "undefined" — and a second such
// handoff would MATCH that lead by platformUserId and merge different
// people together. Sentinels are treated as absent BEFORE validation.
const MANYCHAT_SENTINEL_RE = /^(undefined|null|none|\(unknown\)|\{\{.*\}\})$/i;
function stripSentinel(v: unknown): unknown {
  if (v == null) return v;
  const s = String(v).trim();
  if (s.length === 0 || MANYCHAT_SENTINEL_RE.test(s)) return undefined;
  return v;
}

export const manyChatHandoffSchema = z
  .preprocess((raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = { ...(raw as Record<string, unknown>) };
      // Sanitize identity-bearing fields first — "undefined"/"null"/"{{var}}"
      // must never become a lead identity or a merge key.
      for (const k of [
        'instagramUserId',
        'instagramUsername',
        'facebookUserId',
        'contactName'
      ]) {
        o[k] = stripSentinel(o[k]);
      }
      // subscriberId is REQUIRED and coerced — undefined would coerce back to
      // the string "undefined" via String(undefined). Map sentinel to '' so
      // min(1) rejects it loudly: a handoff with no usable subscriber id
      // cannot identify a contact at all.
      o.manyChatSubscriberId = stripSentinel(o.manyChatSubscriberId) ?? '';
      const hasPlatform =
        typeof o.platform === 'string' && o.platform.trim().length > 0;
      if (!hasPlatform) {
        const igId =
          o.instagramUserId != null ? String(o.instagramUserId).trim() : '';
        const igUser =
          typeof o.instagramUsername === 'string'
            ? o.instagramUsername.trim()
            : '';
        const fbId =
          o.facebookUserId != null ? String(o.facebookUserId).trim() : '';
        o.platform =
          igId && igUser ? 'INSTAGRAM' : fbId ? 'FACEBOOK' : 'INSTAGRAM';
      }
      return o;
    }
    return raw;
  }, manyChatHandoffFields)
  .superRefine((data, ctx) => {
    if (
      data.platform === 'INSTAGRAM' &&
      (!data.instagramUserId.trim() || !data.instagramUsername.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['instagramUserId'],
        message:
          'Instagram handoff requires instagramUserId and instagramUsername. For a FACEBOOK contact, add "platform": "facebook" to the External Request body (and optionally facebookUserId / contactName).'
      });
    }
  });

export type ManyChatHandoffPayload = z.infer<typeof manyChatHandoffSchema>;

interface ManyChatHandoffResult {
  ok: true;
  duplicate: boolean;
  accountId: string;
  leadId: string;
  conversationId: string;
}

export class ManyChatHandoffError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManyChatHandoffError';
    this.status = status;
  }
}

export function cleanInstagramUsername(username: string): string {
  return username.replace(/^@+/, '').trim();
}

function looksLikeInstagramRecipientId(
  value: string,
  manyChatSubscriberId?: string
): boolean {
  const trimmed = value.trim();
  if (manyChatSubscriberId && trimmed === manyChatSubscriberId.trim()) {
    return false;
  }
  return /^\d{12,}$/.test(trimmed);
}

export async function processManyChatHandoff(params: {
  webhookKey: string | null;
  payload: unknown;
}): Promise<ManyChatHandoffResult> {
  const webhookKey = params.webhookKey?.trim();
  if (!webhookKey) {
    throw new ManyChatHandoffError('Missing X-QualifyDMs-Key', 401);
  }

  const account = await prisma.account.findUnique({
    where: { manyChatWebhookKey: webhookKey },
    select: {
      id: true,
      awayModeInstagram: true,
      awayModeFacebook: true,
      defaultAiActive: true,
      generateOnlyInstagram: true,
      generateOnlyFacebook: true
    }
  });
  if (!account) {
    throw new ManyChatHandoffError('Invalid webhook key', 401);
  }

  const parsed = manyChatHandoffSchema.safeParse(params.payload);
  if (!parsed.success) {
    // 2026-08-04: a rejected handoff used to 400 with a generic message and
    // write NOTHING — a critical integration failing 100% invisibly (every
    // real Facebook handoff was dropped this way; see schema comment). Now:
    // field-level detail goes back to ManyChat's request log AND a throttled
    // operator notification lands, so a config gap surfaces in minutes, not
    // weeks.
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'payload'}: ${i.message}`)
      .join('; ');
    console.error(
      `[manychat-handoff] payload REJECTED for account ${account.id}: ${detail}`
    );
    try {
      // Noise fix (Tega 2026-08-22): an UNCHANGED rejection reason is a
      // standing config gap, not news. It previously re-notified every 30
      // min, so a persistent empty-subscriberId issue produced 8 identical
      // notifications over ~30h that buried the AI-held alerts the operator
      // actually needed. Now: dedupe on the REASON — the same rejection
      // reason re-notifies at most once per 24h; a DIFFERENT reason (a new
      // config problem) still surfaces within the 30-min flap floor.
      const REASON_REMIND_MS = 24 * 60 * 60 * 1000;
      const FLAP_FLOOR_MS = 30 * 60 * 1000;
      const reasonTag = `\nreason:${detail.slice(0, 120)}`;
      const last = await prisma.notification.findFirst({
        where: { accountId: account.id, title: 'ManyChat handoff rejected' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, body: true }
      });
      let shouldNotify = true;
      if (last) {
        const age = Date.now() - last.createdAt.getTime();
        const sameReason = (last.body ?? '').includes(reasonTag.trim());
        if (age < FLAP_FLOOR_MS) shouldNotify = false;
        else if (sameReason && age < REASON_REMIND_MS) shouldNotify = false;
      }
      if (shouldNotify) {
        await prisma.notification.create({
          data: {
            accountId: account.id,
            type: 'SYSTEM',
            title: 'ManyChat handoff rejected',
            body: `A ManyChat External Request reached Convlo but its payload was rejected, so the handoff was dropped and the lead will arrive as a plain inbound DM instead. Reason: ${detail.slice(0, 800)}. Fix the External Request body in ManyChat to match.${reasonTag}`
          }
        });
      }
    } catch {
      // notification is best-effort; the 400 detail below still surfaces
    }
    throw new ManyChatHandoffError(`Invalid ManyChat payload — ${detail}`, 400);
  }
  const payload = parsed.data;
  // ManyChat omits `firedAt` from many flow setups — see schema. Default
  // to server-time on the assumption the External Request fires within
  // milliseconds of the trigger event, which is true for ManyChat's
  // synchronous flow execution model.
  const firedAt = payload.firedAt ? new Date(payload.firedAt) : new Date();
  // Contact identity, per platform (2026-08-04). FACEBOOK: prefer the explicit
  // facebookUserId; fall back to the ManyChat subscriber id, which for
  // Messenger IS the page-scoped PSID Meta's FB webhook delivers — so a later
  // organic DM matches this same lead instead of duplicating it.
  const isFacebookContact = payload.platform === 'FACEBOOK';
  const contactUserId = isFacebookContact
    ? payload.facebookUserId?.trim() || payload.manyChatSubscriberId
    : payload.instagramUserId;
  let handle = isFacebookContact
    ? payload.contactName?.trim() ||
      payload.instagramUsername.trim() ||
      contactUserId
    : cleanInstagramUsername(payload.instagramUsername);

  // When ManyChat's subscriber cache is degraded (typically right after an
  // Instagram re-auth), {{contact.ig_username}} resolves to the raw numeric
  // IGSID instead of the actual username. Detect this and resolve the real
  // handle via ManyChat's subscriber API before we write anything to the DB.
  // Without this guard the lead's handle AND display name both become the
  // 15-digit IGSID and are effectively unreadable in the dashboard.
  if (!isFacebookContact && NUMERIC_IGSID.test(handle)) {
    console.warn(
      `[manychat-handoff] numeric instagramUsername "${handle}" received — ManyChat subscriber cache likely degraded. Resolving real username via subscriber ${payload.manyChatSubscriberId}.`
    );
    try {
      const creds = await getCredentials(account.id, 'MANYCHAT');
      if (creds?.apiKey && typeof creds.apiKey === 'string') {
        const sub = await findSubscriberById(
          creds.apiKey,
          payload.manyChatSubscriberId
        );
        if (sub?.ig_username) {
          handle = cleanInstagramUsername(sub.ig_username);
          console.log(
            `[manychat-handoff] resolved @${handle} from subscriber ${payload.manyChatSubscriberId} (was "${payload.instagramUsername}")`
          );
        } else {
          console.warn(
            `[manychat-handoff] subscriber ${payload.manyChatSubscriberId} has no ig_username — persisting numeric handle as fallback`
          );
        }
      }
    } catch (err) {
      console.warn(
        '[manychat-handoff] subscriber username resolution failed (non-fatal):',
        err
      );
    }
  }

  const leadName = handle || contactUserId;
  let canSendViaInstagramApi = isFacebookContact
    ? /^\d{5,}$/.test(contactUserId)
    : looksLikeInstagramRecipientId(
        contactUserId,
        payload.manyChatSubscriberId
      );
  const triggerSource =
    payload.triggerType === 'comment'
      ? payload.postUrl || 'manychat:comment'
      : `manychat:${payload.triggerType}`;

  const existingLead = await prisma.lead.findFirst({
    where: {
      accountId: account.id,
      platform: payload.platform,
      OR: [
        { platformUserId: contactUserId },
        { handle: { equals: handle, mode: 'insensitive' } }
      ]
    },
    include: { conversation: true }
  });

  // Note: dedup is enforced at the Message level by ensureOpenerMessage and
  // ensureLeadResponseMessage (content-keyed). Earlier logic returned early
  // on any ManyChat handoff fired in the last hour, which silently dropped
  // legitimate follow-up events — most importantly the second External
  // Request that carries the lead's button-click as `leadResponseText`.
  // Multi-step ManyChat sequences fire several events in close succession
  // and each one needs to land in the thread.

  let conversationId: string;
  let leadId: string;
  let leadResponseInserted = false;
  let aiActiveOnConversation = false;

  // AI-active decision for a NEWLY-CREATED ManyChat conversation (item 2a,
  // Tega 2026-08-04, DECIDED: no ManyChat bypass — Away Mode applies to
  // ManyChat leads IDENTICALLY to organic ones, per platform). This mirrors
  // the organic new-lead gate in webhook-processor exactly:
  //   organic:  awayModeForPlatform && (defaultAiActive ?? true)
  // Two prior discrepancies fixed to make them truly identical:
  //   (1) this used awayModeInstagram HARDCODED — a Facebook ManyChat lead
  //       would have been gated on the Instagram away mode. Now per-platform.
  //   (2) organic defaults defaultAiActive to true when null; match that.
  const awayModeForPlatform =
    payload.platform === 'FACEBOOK'
      ? account.awayModeFacebook
      : account.awayModeInstagram;
  // 2026-09-08 generate-only shadow: same rule as the organic gate — AI on
  // for generation when Away Mode OR generate-only is on; auto-send is still
  // gated by shouldAutoSendReply so generate-only leads stay suggestions.
  const generateOnlyForPlatform =
    payload.platform === 'FACEBOOK'
      ? account.generateOnlyFacebook
      : account.generateOnlyInstagram;
  const newManyChatLeadAiActive =
    (awayModeForPlatform || generateOnlyForPlatform) &&
    (account.defaultAiActive ?? true);

  if (existingLead?.conversation) {
    const platformUserId =
      canSendViaInstagramApi || !existingLead.platformUserId
        ? contactUserId
        : existingLead.platformUserId;
    canSendViaInstagramApi = looksLikeInstagramRecipientId(
      platformUserId || '',
      payload.manyChatSubscriberId
    );
    const updated = await prisma.conversation.update({
      where: { id: existingLead.conversation.id },
      data: {
        source: 'MANYCHAT',
        leadSource: 'OUTBOUND',
        manyChatOpenerMessage: payload.openerMessage,
        manyChatTriggerType: payload.triggerType,
        manyChatCommentText: payload.commentText ?? null,
        manyChatNativeQuestion: payload.nativeQuestion ?? null,
        manyChatFiredAt: firedAt
      },
      select: { id: true, aiActive: true }
    });
    await prisma.lead.update({
      where: { id: existingLead.id },
      data: {
        handle,
        name: existingLead.name || leadName,
        platformUserId,
        triggerType: payload.triggerType === 'comment' ? 'COMMENT' : 'DM',
        triggerSource
      }
    });
    await ensureOpenerMessage(updated.id, payload.openerMessage, firedAt);
    leadResponseInserted = await ensureLeadResponseMessage(
      updated.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = updated.id;
    leadId = existingLead.id;
    aiActiveOnConversation = updated.aiActive;
  } else if (existingLead) {
    canSendViaInstagramApi = looksLikeInstagramRecipientId(
      existingLead.platformUserId || contactUserId,
      payload.manyChatSubscriberId
    );
    const personaId = await resolveActivePersonaIdForCreate(account.id);
    const conversation = await prisma.conversation.create({
      data: {
        leadId: existingLead.id,
        personaId,
        // POLICY (2026-05-21, Tega): a NEW ManyChat lead only gets AI turned
        // ON when the account's Instagram Away Mode is ON. Away Mode OFF →
        // aiActive=false, no exceptions (ManyChat handoffs must NOT auto-enable
        // AI regardless of Away Mode). autoSendOverride stays false; only the
        // operator's explicit per-conversation toggle turns AI on otherwise.
        aiActive: newManyChatLeadAiActive,
        autoSendOverride: false,
        unreadCount: 0,
        source: 'MANYCHAT',
        leadSource: 'OUTBOUND',
        manyChatOpenerMessage: payload.openerMessage,
        manyChatTriggerType: payload.triggerType,
        manyChatCommentText: payload.commentText ?? null,
        manyChatNativeQuestion: payload.nativeQuestion ?? null,
        manyChatFiredAt: firedAt
      },
      select: { id: true, aiActive: true }
    });
    await ensureOpenerMessage(conversation.id, payload.openerMessage, firedAt);
    leadResponseInserted = await ensureLeadResponseMessage(
      conversation.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = conversation.id;
    leadId = existingLead.id;
    aiActiveOnConversation = conversation.aiActive;
  } else {
    const newLeadPersonaId = await resolveActivePersonaIdForCreate(account.id);
    const lead = await prisma.lead.create({
      data: {
        accountId: account.id,
        name: leadName,
        handle,
        platform: payload.platform,
        platformUserId: contactUserId,
        triggerType: payload.triggerType === 'comment' ? 'COMMENT' : 'DM',
        triggerSource,
        stage: 'NEW_LEAD',
        conversation: {
          create: {
            personaId: newLeadPersonaId,
            // POLICY (2026-05-21, Tega): see sibling create at top of this
            // function. A new ManyChat lead gets AI ON only when Instagram
            // Away Mode is ON; otherwise aiActive=false (no exceptions).
            aiActive: newManyChatLeadAiActive,
            autoSendOverride: false,
            unreadCount: 0,
            source: 'MANYCHAT',
            leadSource: 'OUTBOUND',
            manyChatOpenerMessage: payload.openerMessage,
            manyChatTriggerType: payload.triggerType,
            manyChatCommentText: payload.commentText ?? null,
            manyChatNativeQuestion: payload.nativeQuestion ?? null,
            manyChatFiredAt: firedAt
          }
        }
      },
      include: {
        conversation: { select: { id: true, aiActive: true } }
      }
    });

    await ensureOpenerMessage(
      lead.conversation!.id,
      payload.openerMessage,
      firedAt
    );
    leadResponseInserted = await ensureLeadResponseMessage(
      lead.conversation!.id,
      payload.leadResponseText,
      firedAt
    );
    conversationId = lead.conversation!.id;
    leadId = lead.id;
    aiActiveOnConversation = lead.conversation!.aiActive;
  }

  // Resolve the IG numeric user ID via ManyChat REST. ManyChat's
  // `{{contact.id}}` returns the ManyChat-internal subscriber ID, not
  // the IG numeric ID Meta's Send API requires. The resolver upgrades
  // `Lead.platformUserId` so downstream send paths
  // (`hasUsablePlatformRecipient` in silent-stop-recovery, the
  // scheduleAIReply branch below, every future heartbeat tick) see a
  // usable recipient. Only re-flips canSendViaInstagramApi when the
  // upgrade actually produced a numeric ID.
  // IG-numeric-id resolution is Instagram-specific (it upgrades the ManyChat
  // subscriber id to the IG numeric id Meta's IG Send API needs). For a
  // FACEBOOK contact (2026-08-04, item 2b) the platformUserId is already the
  // page-scoped PSID the FB Send API uses — skip the IG resolver entirely and
  // mark it sendable, otherwise a valid FB recipient would be treated as
  // unsendable and the AI schedule below would never fire.
  if (payload.platform === 'FACEBOOK') {
    canSendViaInstagramApi = true;
  } else {
    const resolvedIgNumeric = await resolveAndUpgradeInstagramNumericId({
      accountId: account.id,
      leadId,
      existingPlatformUserId: payload.instagramUserId,
      incomingInstagramUserId: payload.instagramUserId,
      manyChatSubscriberId: payload.manyChatSubscriberId
    }).catch((err) => {
      console.warn(
        `[manychat-handoff] ig_id resolve failed for lead ${leadId} (non-fatal):`,
        err
      );
      return null;
    });
    if (
      resolvedIgNumeric &&
      looksLikeInstagramRecipientId(
        resolvedIgNumeric,
        payload.manyChatSubscriberId
      )
    ) {
      canSendViaInstagramApi = true;
    }
  }

  // Item 1 (Tega 2026-08-04): reset-then-FIRST-fire needed a manual nudge
  // while reset-then-second-fire proceeded on its own. Root cause is a
  // read-after-write ordering gap: `aiActiveOnConversation` is captured at
  // create time, and `canSendViaInstagramApi` can be flipped true only by the
  // IG-id resolution that runs AFTER the create. On the first fire the
  // conversation's AI-active state (freshly reset) and/or the upgraded
  // recipient id haven't been observed by the values below, so the schedule
  // gate fails and Convlo just sits until the lead types something (which
  // fires the normal webhook). On the second fire the prior fire already
  // upgraded the id, so it passes. Re-read the conversation's TRUE current
  // aiActive right before the gate so a fresh conversation isn't judged on a
  // stale snapshot — the resolution above already updated canSendViaInstagramApi.
  const freshAiActive = await prisma.conversation
    .findUnique({
      where: { id: conversationId },
      select: { aiActive: true }
    })
    .then((r) => r?.aiActive ?? aiActiveOnConversation)
    .catch(() => aiActiveOnConversation);
  aiActiveOnConversation = freshAiActive;

  // Schedule the AI reply when the lead actually engaged (button click
  // landed as a new LEAD message) and the conversation is AI-eligible.
  // Most flows should leave scheduleAi=false because ManyChat still has
  // downstream messages to send after the button click. Convlo will
  // pick up when the lead replies via the normal Instagram webhook.
  if (
    payload.scheduleAi === true &&
    leadResponseInserted &&
    aiActiveOnConversation &&
    canSendViaInstagramApi
  ) {
    try {
      const { scheduleAIReply } = await import('@/lib/webhook-processor');
      await scheduleAIReply(conversationId, account.id);
    } catch (err) {
      console.error(
        `[manychat-handoff] scheduleAIReply failed for conversation ${conversationId} (non-fatal):`,
        err
      );
    }
  } else if (
    payload.scheduleAi === true &&
    leadResponseInserted &&
    aiActiveOnConversation
  ) {
    console.warn(
      `[manychat-handoff] Skipping AI schedule for conversation ${conversationId}: ManyChat instagramUserId="${payload.instagramUserId}" is not a Meta recipient ID. AI will resume when an Instagram webhook upgrades the lead by handle.`
    );
    // IG parity day 2 (2026-09-11): surface the silent skip to the operator
    // once per lead per 24h instead of leaving the lead created-but-mute.
    const { notifyOnce } = await import('@/lib/platform-not-connected-alert');
    await notifyOnce({
      accountId: account.id,
      leadId,
      title: 'ManyChat lead cannot be messaged yet',
      body:
        `A ManyChat handoff created this lead but Instagram has not confirmed a sendable recipient id ` +
        `(ManyChat sent "${payload.instagramUserId ?? 'none'}"). The AI will resume as soon as the lead DMs ` +
        `through Instagram. If they never do, reply from the Instagram app.`
    });
  } else if (leadResponseInserted) {
    console.log(
      `[manychat-handoff] Recorded ManyChat engagement for conversation ${conversationId}; scheduleAi=false so Convlo will wait for the lead's next Instagram reply.`
    );
  }

  return {
    ok: true,
    duplicate: false,
    accountId: account.id,
    leadId,
    conversationId
  };
}

/**
 * Insert the ManyChat opener as a Message row so it appears in the
 * conversation thread (dashboard UI + AI prompt history).
 *
 * Uses sender=MANYCHAT so the dashboard renders it with the violet
 * "ManyChat · automation" treatment — operators can immediately tell
 * which messages came from the ManyChat sequence vs the AI Setter.
 * The voice-quality analyzer keys off training examples + persona
 * style profile, not raw message history, so including this static
 * templated opener does not pollute style inference.
 *
 * Idempotent: skips creation if any message with this exact content
 * already exists on the conversation, regardless of whether it was
 * previously stored as MANYCHAT (current) or AI (legacy, before the
 * MANYCHAT enum value existed). Without the legacy `AI` match here,
 * re-fires on already-handed-off conversations would double-store
 * the opener.
 */
async function ensureOpenerMessage(
  conversationId: string,
  content: string,
  timestamp: Date
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;
  const existing = await prisma.message.findFirst({
    where: {
      conversationId,
      sender: { in: ['MANYCHAT', 'AI'] },
      content: trimmed
    },
    select: { id: true }
  });
  if (existing) return;
  await prisma.message.create({
    data: {
      conversationId,
      sender: 'MANYCHAT',
      content: trimmed,
      systemPromptVersion: 'manychat-automation',
      msgSource: 'MANYCHAT_FLOW',
      timestamp
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: timestamp }
  });
}

/**
 * Insert the lead's button-click response (if any) as a LEAD-side
 * Message. Mirrors `ensureOpenerMessage` but on the inbound side: when
 * ManyChat fires a follow-up External Request after a button-click
 * step in the flow, the click label rides through as
 * `leadResponseText` and we land it as a Message so the AI sees
 * "lead engaged with X" on its next turn.
 *
 * Timestamp is bumped 1s past the opener's `firedAt` so the message
 * order in the thread reflects opener → click, not click → opener,
 * even when both External Requests fire within the same JSON payload
 * (rare but possible when the operator wires both events to a single
 * action node).
 *
 * Idempotent on (conversationId, sender=LEAD, content). Returns true when a
 * NEW message was inserted, false when nothing was inserted (no content, or
 * content already in the thread). Caller uses this to decide whether to
 * schedule an AI reply — content-dedup'd retries must NOT re-schedule.
 */
async function ensureLeadResponseMessage(
  conversationId: string,
  content: string | undefined,
  openerFiredAt: Date
): Promise<boolean> {
  const trimmed = content?.trim();
  if (!trimmed) return false;
  const existing = await prisma.message.findFirst({
    where: { conversationId, sender: 'LEAD', content: trimmed },
    select: { id: true }
  });
  if (existing) return false;
  const leadResponseTimestamp = new Date(openerFiredAt.getTime() + 1000);
  await prisma.message.create({
    data: {
      conversationId,
      sender: 'LEAD',
      content: trimmed,
      timestamp: leadResponseTimestamp
    }
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: leadResponseTimestamp,
      unreadCount: { increment: 1 }
    }
  });
  return true;
}
