import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { detectMetadataLeak } from '@/lib/voice-quality-gate';
import { NextRequest, NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// GET /api/dashboard/actions
// ---------------------------------------------------------------------------
// Returns all "needs operator attention" items grouped by priority. Powers
// the Action Required section at the top of the Dashboard Overview page.
// All queries are accountId-scoped via requireAuth.
//
// Phase A coverage:
//   urgent:    distress, stuck conversations, delivery failures
//   attention: AI paused (system), capital-verification needed,
//              upcoming calls (next 48h), unreviewed count
//
// Phase B (later): awaiting-response info, training progress, snooze
// state, SSE push instead of polling.
//
// Performance: account with 500+ conversations should respond in <500ms.
// All queries below either use existing indexes or rely on the
// `Conversation.distressDetected`, `Conversation.scheduledCallAt`,
// `Conversation.aiActive`, and `BookingRoutingAudit.routingAllowed`
// columns — see migration notes in schema.prisma if any new index is
// required.
// ---------------------------------------------------------------------------

const STUCK_HOURS = 4;
const STUCK_MS = STUCK_HOURS * 60 * 60 * 1000;
const UPCOMING_CALL_WINDOW_MS = 48 * 60 * 60 * 1000;
const RECENT_ACTIVITY_DAYS = 7;
const RECENT_ACTIVITY_MS = RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
const DELIVERY_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_METADATA_LEAK_DAYS = 60;
const HISTORICAL_METADATA_LEAK_MS =
  HISTORICAL_METADATA_LEAK_DAYS * 24 * 60 * 60 * 1000;
const R34_COUNTER_WINDOW_MS = 24 * 60 * 60 * 1000;
const R34_ALERT_WINDOW_MS = 60 * 60 * 1000;

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const accountId = auth.accountId;
    const now = new Date();

    // ── Helper: shared accountId-scoped lead filter ──────────────────
    // Conversation doesn't carry accountId directly — must filter via
    // lead. Reused across most queries below.
    //
    // Cold-pitch / SPAM exclusion: Action Required is the operator's
    // attention queue, not the spam bucket. Filter out leads tagged
    // 'cold-pitch' so an Omar-style agency pitch doesn't surface as
    // a "stuck conversation" 24h later just because no human replied.
    const accountConvFilter = {
      lead: {
        is: {
          accountId,
          tags: { none: { tag: { name: 'cold-pitch' } } }
        }
      }
    } as const;

    // ── Run all queries in parallel ──────────────────────────────────
    // Each query is independent. Promise.all lets the endpoint stay
    // <500ms on accounts with 500+ conversations. Each `Promise<T>`
    // here is also wrapped to swallow individual failures so a single
    // broken query never NUKES the whole endpoint — we'd rather show
    // a partial Action Required section than a blank dashboard.
    const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (err) {
        console.error('[dashboard/actions] sub-query failed:', err);
        return fallback;
      }
    };

    const [
      distressRows,
      stuckCandidates,
      deliveryFailureRows,
      pausedSystemRows,
      capitalRoutingRows,
      upcomingCallRows,
      unreviewedCount,
      keepaliveRows,
      callUnconfirmedRows,
      callOutcomeNeededRows,
      pendingRecoveryRows,
      recoveryStatusRows,
      r34FailureRows,
      silentStopRows,
      silentStopStatusRows,
      recentSilentStopRows,
      metadataLeakCandidateMessages
    ] = await Promise.all([
      // ── PRIORITY 1.A: Distress signals ────────────────────────────
      // Conversations flagged distressDetected=true within the last
      // 7 days where no HUMAN message has been sent since detection.
      // (If an operator already responded after distress detection,
      // it's effectively handled — don't re-surface.)
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            distressDetected: true,
            distressDetectedAt: {
              gte: new Date(now.getTime() - RECENT_ACTIVITY_MS)
            }
          },
          select: {
            id: true,
            distressDetectedAt: true,
            distressMessageId: true,
            lead: { select: { id: true, name: true, handle: true } },
            messages: {
              where: { sender: 'HUMAN' },
              orderBy: { timestamp: 'desc' },
              take: 1,
              select: { timestamp: true }
            }
          },
          orderBy: { distressDetectedAt: 'desc' }
        }),
        []
      ),

      // ── PRIORITY 1.B: Stuck conversations ────────────────────────
      // aiActive=true AND latest message is from LEAD AND that
      // message is >STUCK_HOURS old AND no PENDING ScheduledReply.
      // Database can't easily express "latest message is from LEAD"
      // in one query — fetch a candidate set (recently active convos
      // with aiActive=true) and filter in JS. ScheduledReply doesn't
      // have a back-relation on Conversation in the Prisma schema,
      // so its filtering is done via a follow-up query below.
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            aiActive: true,
            // Last activity in the stuck window — earlier than this
            // means the lead has gone silent vs being stuck. Cap at
            // 7 days so leads who messaged a week ago don't pollute
            // the stuck list.
            lastMessageAt: {
              gte: new Date(now.getTime() - RECENT_ACTIVITY_MS),
              lte: new Date(now.getTime() - STUCK_MS)
            },
            distressDetected: false
          },
          select: {
            id: true,
            lastMessageAt: true,
            lead: { select: { id: true, name: true, handle: true } },
            messages: {
              orderBy: { timestamp: 'desc' },
              take: 1,
              select: { sender: true, timestamp: true }
            }
          },
          take: 50
        }),
        []
      ),

      // ── PRIORITY 1.C: Delivery failures (last 24h) ───────────────
      // MessageGroup with failedAt set in the last day. MessageGroup
      // has no `conversation` Prisma relation (only conversationId),
      // so we filter by failedAt only and join to Conversation→Lead
      // via a separate query below to apply the account scope.
      safe(
        prisma.messageGroup.findMany({
          where: {
            failedAt: {
              gte: new Date(now.getTime() - DELIVERY_FAILURE_WINDOW_MS)
            }
          },
          select: {
            conversationId: true,
            failedAt: true
          },
          orderBy: { failedAt: 'desc' }
        }),
        []
      ),

      // ── PRIORITY 2.A: AI paused by system ────────────────────────
      // aiActive=false AND a recent Notification with type=SYSTEM
      // (the system-pause path always creates one — distress, R24
      // exhaustion, escalation, empty-message guard). Active in the
      // last 7 days so we don't surface ancient pauses. Excludes
      // distress (those go in PRIORITY 1.A above).
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            aiActive: false,
            distressDetected: false,
            lastMessageAt: {
              gte: new Date(now.getTime() - RECENT_ACTIVITY_MS)
            },
            // Has at least one SYSTEM notification on the lead.
            // The `lead.notifications` relation lets us filter at the
            // DB level; we further check the notification was created
            // recently so a stale R24 pause from a month ago doesn't
            // resurface every dashboard load.
            lead: {
              is: {
                accountId,
                notifications: {
                  some: {
                    type: 'SYSTEM',
                    createdAt: {
                      gte: new Date(now.getTime() - RECENT_ACTIVITY_MS)
                    }
                  }
                }
              }
            }
          },
          select: {
            id: true,
            lastMessageAt: true,
            lead: { select: { id: true, name: true, handle: true } }
            // Latest SYSTEM notification gives us the pause reason
            // (title is "URGENT — distress..." / "AI escalated..." /
            // "AI produced empty response..." etc.).
            // Pull via lead.notifications since Notification doesn't
            // belong to Conversation directly.
          },
          orderBy: { lastMessageAt: 'desc' },
          take: 30
        }),
        []
      ),

      // ── PRIORITY 2.B: Capital verification needed ────────────────
      // BookingRoutingAudit rows where R24/Fix B blocked routing
      // (routingAllowed=false), conversation still active in last
      // 7 days, and verification hasn't subsequently passed.
      safe(
        prisma.bookingRoutingAudit.findMany({
          where: {
            accountId,
            routingAllowed: false,
            createdAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) }
          },
          select: {
            conversationId: true,
            createdAt: true,
            blockReason: true
          },
          orderBy: { createdAt: 'desc' },
          take: 50
        }),
        []
      ),

      // ── PRIORITY 2.C: Upcoming calls (next 48h) ──────────────────
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            lead: {
              is: {
                accountId,
                stage: { in: ['QUALIFIED', 'CALL_PROPOSED', 'BOOKED'] },
                tags: { none: { tag: { name: 'cold-pitch' } } }
              }
            },
            scheduledCallAt: {
              gte: now,
              lte: new Date(now.getTime() + UPCOMING_CALL_WINDOW_MS)
            }
          },
          select: {
            id: true,
            scheduledCallAt: true,
            scheduledCallTimezone: true,
            callConfirmed: true,
            lead: { select: { id: true, name: true, handle: true } }
          },
          orderBy: { scheduledCallAt: 'asc' }
        }),
        []
      ),

      // ── PRIORITY 2.D: Unreviewed count (Phase A interim) ─────────
      // No ConversationReviewStatus model exists yet — until End-of-
      // Day Review ships, surface "conversations with AI activity in
      // last 24h" as the unreviewed proxy. UI link goes to the
      // priority-sorted conversation list.
      safe(
        prisma.conversation.count({
          where: {
            ...accountConvFilter,
            messages: {
              some: {
                sender: 'AI',
                timestamp: {
                  gte: new Date(now.getTime() - 24 * 60 * 60 * 1000)
                }
              }
            }
          }
        }),
        0
      ),
      // ── PRIORITY 2.E: Window-keepalive status ─────────────────────
      // All WINDOW_KEEPALIVE scheduled messages fired in the last 7
      // days. We post-process to split into two action categories:
      //   - keepalive_no_response: most-recent keepalive was 6h+ ago
      //     and the lead hasn't responded yet — window may close.
      //   - keepalive_exhausted: 3+ consecutive FIRED keepalives since
      //     the last LEAD message — the conversation is dead, the
      //     cron already stopped firing, operator needs to decide.
      safe(
        prisma.scheduledMessage.findMany({
          where: {
            accountId,
            messageType: 'WINDOW_KEEPALIVE',
            status: 'FIRED',
            firedAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) }
          },
          select: {
            id: true,
            conversationId: true,
            firedAt: true,
            relatedCallAt: true
          },
          orderBy: { firedAt: 'desc' }
        }),
        []
      ),

      // ── PRIORITY 2.F: Call confirmation gaps ─────────────────────
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            scheduledCallAt: {
              gte: new Date(now.getTime() - RECENT_ACTIVITY_MS),
              lte: new Date(now.getTime() - 30 * 60 * 1000)
            },
            callConfirmed: false,
            callOutcome: null
          },
          select: {
            id: true,
            scheduledCallAt: true,
            scheduledCallTimezone: true,
            lead: { select: { id: true, name: true, handle: true } }
          },
          orderBy: { scheduledCallAt: 'desc' },
          take: 50
        }),
        []
      ),
      safe(
        prisma.conversation.findMany({
          where: {
            ...accountConvFilter,
            scheduledCallAt: {
              gte: new Date(now.getTime() - RECENT_ACTIVITY_MS),
              lte: new Date(now.getTime() - 2 * 60 * 60 * 1000)
            },
            callConfirmed: true,
            callOutcome: null
          },
          select: {
            id: true,
            scheduledCallAt: true,
            scheduledCallTimezone: true,
            lead: { select: { id: true, name: true, handle: true } }
          },
          orderBy: { scheduledCallAt: 'desc' },
          take: 50
        }),
        []
      ),
      // ── PRIORITY 2.G: Pending self-recovery approvals ────────────
      safe(
        prisma.selfRecoveryEvent.findMany({
          where: {
            accountId,
            status: 'PENDING_APPROVAL',
            createdAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) }
          },
          select: {
            id: true,
            conversationId: true,
            leadId: true,
            triggerReason: true,
            recoveryAction: true,
            priority: true,
            generatedMessages: true,
            createdAt: true,
            lead: { select: { id: true, name: true, handle: true } }
          },
          orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
          take: 30
        }),
        []
      ),
      safe(
        prisma.selfRecoveryEvent.groupBy({
          by: ['status', 'triggerReason'],
          where: {
            accountId,
            createdAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) }
          },
          _count: true
        }),
        []
      ),
      // ── INFO: R34 metadata leak catches (last 24h) ──────────────
      safe(
        prisma.voiceQualityFailure.findMany({
          where: {
            accountId,
            createdAt: { gte: new Date(now.getTime() - R34_COUNTER_WINDOW_MS) }
          },
          select: { hardFails: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 500
        }),
        []
      ),
      // ── INFO: silent-stop heartbeat events ──────────────────────
      safe(
        prisma.silentStopEvent.findMany({
          where: {
            detectedAt: {
              gte: new Date(now.getTime() - R34_COUNTER_WINDOW_MS)
            },
            conversation: { lead: { accountId } }
          },
          select: {
            recoveryStatus: true,
            detectedAt: true
          },
          orderBy: { detectedAt: 'desc' },
          take: 500
        }),
        []
      ),
      safe(
        prisma.silentStopEvent.groupBy({
          by: ['recoveryStatus', 'detectedReason'],
          where: {
            detectedAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) },
            conversation: { lead: { accountId } }
          },
          _count: true
        }),
        []
      ),
      safe(
        prisma.silentStopEvent.findMany({
          where: {
            detectedAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) },
            conversation: { lead: { accountId } }
          },
          select: {
            id: true,
            detectedAt: true,
            detectedReason: true,
            recoveryAction: true,
            recoveryStatus: true,
            conversation: {
              select: {
                id: true,
                lead: { select: { id: true, name: true, handle: true } }
              }
            }
          },
          orderBy: { detectedAt: 'desc' },
          take: 10
        }),
        []
      ),
      // ── PRIORITY 2.H: historical metadata leak sweep ────────────
      // Coarse DB filter + precise detector in JS. Report-only; no
      // historical message mutation here.
      safe(
        prisma.message.findMany({
          where: {
            sender: 'AI',
            timestamp: {
              gte: new Date(now.getTime() - HISTORICAL_METADATA_LEAK_MS)
            },
            conversation: {
              lead: {
                accountId,
                tags: { none: { tag: { name: 'cold-pitch' } } }
              }
            },
            OR: [
              {
                content: { contains: 'stage_confidence', mode: 'insensitive' }
              },
              { content: { contains: 'quality_score', mode: 'insensitive' } },
              { content: { contains: 'priority_score', mode: 'insensitive' } },
              { content: { contains: 'current_stage', mode: 'insensitive' } },
              { content: { contains: 'script_step', mode: 'insensitive' } },
              { content: { contains: 'next_action', mode: 'insensitive' } },
              { content: { contains: 'stage:', mode: 'insensitive' } },
              { content: { contains: 'intent:', mode: 'insensitive' } },
              { content: { contains: 'sentiment:', mode: 'insensitive' } },
              { content: { contains: '{{', mode: 'insensitive' } },
              { content: { contains: '[BOOKING', mode: 'insensitive' } },
              { content: { contains: '[URL', mode: 'insensitive' } },
              { content: { contains: '[LINK', mode: 'insensitive' } },
              { content: { contains: '(debug:', mode: 'insensitive' } },
              { content: { contains: '(system:', mode: 'insensitive' } },
              { content: { contains: '(internal:', mode: 'insensitive' } }
            ]
          },
          select: {
            id: true,
            conversationId: true,
            content: true,
            timestamp: true,
            conversation: {
              select: {
                lead: { select: { id: true, name: true, handle: true } }
              }
            }
          },
          orderBy: { timestamp: 'desc' },
          take: 1000
        }),
        []
      )
    ]);

    const historicalMetadataLeakMatches = metadataLeakCandidateMessages
      .map((message) => {
        const leak = detectMetadataLeak(message.content);
        if (!leak.leak) return null;
        return {
          message,
          leak
        };
      })
      .filter(
        (
          item
        ): item is {
          message: (typeof metadataLeakCandidateMessages)[number];
          leak: ReturnType<typeof detectMetadataLeak>;
        } => item !== null
      )
      .slice(0, 50);

    const r34CatchCount24h = r34FailureRows.filter((row) =>
      JSON.stringify(row.hardFails).includes('r34_metadata_leak')
    ).length;
    const r34CatchCountLastHour = r34FailureRows.filter(
      (row) =>
        row.createdAt.getTime() >= now.getTime() - R34_ALERT_WINDOW_MS &&
        JSON.stringify(row.hardFails).includes('r34_metadata_leak')
    ).length;
    const silentStopCount24h = silentStopRows.length;
    const silentStopAutoRecovered24h = silentStopRows.filter(
      (row) => row.recoveryStatus === 'AUTO_TRIGGERED'
    ).length;
    const silentStopOperatorReview24h = silentStopRows.filter(
      (row) => row.recoveryStatus === 'OPERATOR_REVIEW'
    ).length;
    const silentStopFailed24h = silentStopRows.filter(
      (row) => row.recoveryStatus === 'FAILED'
    ).length;
    const silentStopLastHourCount = silentStopRows.filter(
      (row) => row.detectedAt.getTime() >= now.getTime() - R34_ALERT_WINDOW_MS
    ).length;

    // ── Dismissal state ──────────────────────────────────────────────
    // Collect all conversationIds referenced by action items so we can
    // (a) fetch any DismissedActionItem rows for them and (b) look up
    // the latest LEAD message per conversation (needed for the
    // "resurface when lead messages after dismissal" rule).
    const referencedConvIds = new Set<string>();
    distressRows.forEach((c) => referencedConvIds.add(c.id));
    stuckCandidates.forEach((c) => referencedConvIds.add(c.id));
    pausedSystemRows.forEach((c) => referencedConvIds.add(c.id));
    capitalRoutingRows.forEach((r) => referencedConvIds.add(r.conversationId));
    upcomingCallRows.forEach((c) => referencedConvIds.add(c.id));
    callUnconfirmedRows.forEach((c) => referencedConvIds.add(c.id));
    callOutcomeNeededRows.forEach((c) => referencedConvIds.add(c.id));
    pendingRecoveryRows.forEach((r) => referencedConvIds.add(r.conversationId));
    historicalMetadataLeakMatches.forEach((r) =>
      referencedConvIds.add(r.message.conversationId)
    );
    const referencedConvIdList = Array.from(referencedConvIds);
    const [dismissedRows, latestLeadMsgs] = await Promise.all([
      referencedConvIdList.length > 0
        ? safe(
            prisma.dismissedActionItem.findMany({
              where: {
                accountId,
                conversationId: { in: referencedConvIdList }
              },
              select: {
                conversationId: true,
                actionType: true,
                dismissedAt: true
              }
            }),
            []
          )
        : Promise.resolve(
            [] as Array<{
              conversationId: string;
              actionType: string;
              dismissedAt: Date;
            }>
          ),
      referencedConvIdList.length > 0
        ? safe(
            prisma.message.findMany({
              where: {
                conversationId: { in: referencedConvIdList },
                sender: 'LEAD'
              },
              orderBy: { timestamp: 'desc' },
              distinct: ['conversationId'],
              select: { conversationId: true, timestamp: true }
            }),
            []
          )
        : Promise.resolve(
            [] as Array<{ conversationId: string; timestamp: Date }>
          )
    ]);
    // Map: convId → latest LEAD message timestamp (or 0 when none).
    const latestLeadByConv = new Map<string, number>();
    for (const m of latestLeadMsgs) {
      latestLeadByConv.set(m.conversationId, m.timestamp.getTime());
    }
    // Map: `${convId}:${actionType}` → effective dismissedAt ms. Only
    // populated when the dismissal is still valid (latest LEAD msg <=
    // dismissedAt). If a LEAD message arrived after dismissedAt, we
    // drop the entry — the item resurfaces.
    const effectiveDismissals = new Map<string, number>();
    for (const d of dismissedRows) {
      const latestLead = latestLeadByConv.get(d.conversationId) ?? 0;
      if (latestLead > d.dismissedAt.getTime()) continue;
      effectiveDismissals.set(
        `${d.conversationId}:${d.actionType}`,
        d.dismissedAt.getTime()
      );
    }
    const isDismissed = (convId: string, actionType: string) =>
      effectiveDismissals.has(`${convId}:${actionType}`);

    // ── Build response payload ──────────────────────────────────────

    // PRIORITY 1.A — distress
    const urgentDistress = distressRows
      .filter((c) => {
        // Drop if a HUMAN message exists AFTER distress detection.
        if (!c.distressDetectedAt) return true;
        const lastHuman = c.messages[0]?.timestamp;
        return !lastHuman || lastHuman < c.distressDetectedAt;
      })
      .filter((c) => !isDismissed(c.id, 'distress'))
      .map((c) => ({
        type: 'distress' as const,
        conversationId: c.id,
        leadId: c.lead.id,
        leadName: c.lead.name,
        leadHandle: c.lead.handle,
        detectedAt: c.distressDetectedAt?.toISOString() ?? null
      }));

    // PRIORITY 1.B — stuck
    // First filter by "latest message is from LEAD". Then look up
    // PENDING ScheduledReply for the surviving conversations and
    // exclude any that have one queued (those aren't stuck — a reply
    // is en route).
    const stuckByLastLead = stuckCandidates.filter((c) => {
      const last = c.messages[0];
      return !!last && last.sender === 'LEAD';
    });
    const stuckCandidateIds = stuckByLastLead.map((c) => c.id);
    const pendingReplies =
      stuckCandidateIds.length > 0
        ? await safe(
            prisma.scheduledReply.findMany({
              where: {
                conversationId: { in: stuckCandidateIds },
                status: 'PENDING'
              },
              select: { conversationId: true }
            }),
            []
          )
        : [];
    const pendingByConv = new Set(pendingReplies.map((p) => p.conversationId));
    const urgentStuck = stuckByLastLead
      .filter((c) => !pendingByConv.has(c.id))
      .filter((c) => !isDismissed(c.id, 'stuck'))
      .map((c) => {
        const lastTs = c.messages[0].timestamp;
        const hoursWaiting = Math.floor(
          (now.getTime() - lastTs.getTime()) / (60 * 60 * 1000)
        );
        return {
          type: 'stuck' as const,
          conversationId: c.id,
          leadId: c.lead.id,
          leadName: c.lead.name,
          leadHandle: c.lead.handle,
          lastLeadMessageAt: lastTs.toISOString(),
          hoursWaiting
        };
      });

    // PRIORITY 1.C — delivery failures (collapsed to single item)
    // MessageGroup has no account scope, so restrict the unique conv
    // IDs to those owned by this account before reporting a count.
    const allFailureConvIds = Array.from(
      new Set(deliveryFailureRows.map((r) => r.conversationId))
    );
    const accountScopedFailureConvs =
      allFailureConvIds.length > 0
        ? await safe(
            prisma.conversation.findMany({
              where: { id: { in: allFailureConvIds }, ...accountConvFilter },
              select: { id: true }
            }),
            []
          )
        : [];
    const uniqueFailureConvIds = accountScopedFailureConvs.map((c) => c.id);
    const urgentDeliveryFailures =
      uniqueFailureConvIds.length > 0
        ? [
            {
              type: 'delivery_failure' as const,
              count: uniqueFailureConvIds.length,
              conversationIds: uniqueFailureConvIds,
              latestFailureAt:
                deliveryFailureRows[0]?.failedAt?.toISOString() ?? null
            }
          ]
        : [];

    // PRIORITY 2.A — AI paused by system
    // Resolve the most-recent SYSTEM notification per lead to pull
    // the human-readable pause reason (the notification title).
    let attentionPaused: Array<{
      type: 'ai_paused';
      conversationId: string;
      leadId: string;
      leadName: string;
      leadHandle: string;
      pauseReason: string;
      pausedAt: string;
    }> = [];
    if (pausedSystemRows.length > 0) {
      const leadIds = pausedSystemRows.map((c) => c.lead.id);
      const recentNotifs = await safe(
        prisma.notification.findMany({
          where: {
            accountId,
            type: 'SYSTEM',
            leadId: { in: leadIds },
            createdAt: { gte: new Date(now.getTime() - RECENT_ACTIVITY_MS) }
          },
          orderBy: { createdAt: 'desc' },
          select: { leadId: true, title: true, createdAt: true }
        }),
        []
      );
      const latestByLead = new Map<
        string,
        { title: string; createdAt: Date }
      >();
      for (const n of recentNotifs) {
        if (!n.leadId) continue;
        if (!latestByLead.has(n.leadId)) {
          latestByLead.set(n.leadId, {
            title: n.title,
            createdAt: n.createdAt
          });
        }
      }
      attentionPaused = pausedSystemRows
        .filter((c) => !isDismissed(c.id, 'ai_paused'))
        .map((c) => {
          const notif = latestByLead.get(c.lead.id);
          if (!notif) return null;
          // Strip the "URGENT — " / "AI " prefixes for compactness.
          const reason = notif.title
            .replace(/^URGENT — /i, '')
            .replace(/^AI /, '')
            .trim();
          return {
            type: 'ai_paused' as const,
            conversationId: c.id,
            leadId: c.lead.id,
            leadName: c.lead.name,
            leadHandle: c.lead.handle,
            pauseReason: reason,
            pausedAt: notif.createdAt.toISOString()
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
    }

    // PRIORITY 2.B — capital verification (unique by conversation)
    // Split by blockReason: rows with reason='gate_exhausted_sent_
    // best_effort' are a DIFFERENT action type (the AI actually sent
    // the response, now needs review) vs the pre-send block rows
    // which are "verify before call". Both come from the same
    // bookingRoutingAudit table, so we partition in JS.
    const seenCapital = new Set<string>();
    const seenUnverifiedSent = new Set<string>();
    const capitalNeedsResolution: typeof capitalRoutingRows = [];
    const unverifiedSentRows: typeof capitalRoutingRows = [];
    for (const r of capitalRoutingRows) {
      if (r.blockReason === 'gate_exhausted_sent_best_effort') {
        if (seenUnverifiedSent.has(r.conversationId)) continue;
        seenUnverifiedSent.add(r.conversationId);
        unverifiedSentRows.push(r);
      } else {
        if (seenCapital.has(r.conversationId)) continue;
        seenCapital.add(r.conversationId);
        capitalNeedsResolution.push(r);
      }
    }
    // Pull the lead names for BOTH sets in one query + check if a
    // more recent passing audit row exists (= verified, drop).
    const allAuditConvIds = [
      ...capitalNeedsResolution.map((r) => r.conversationId),
      ...unverifiedSentRows.map((r) => r.conversationId)
    ];
    const capitalConvIds = Array.from(new Set(allAuditConvIds));
    const passingAudits =
      capitalConvIds.length > 0
        ? await safe(
            prisma.bookingRoutingAudit.findMany({
              where: {
                conversationId: { in: capitalConvIds },
                routingAllowed: true
              },
              select: { conversationId: true, createdAt: true }
            }),
            []
          )
        : [];
    const passingByConv = new Map<string, Date>();
    for (const a of passingAudits) {
      const existing = passingByConv.get(a.conversationId);
      if (!existing || a.createdAt > existing) {
        passingByConv.set(a.conversationId, a.createdAt);
      }
    }
    const capitalConvs =
      capitalConvIds.length > 0
        ? await safe(
            prisma.conversation.findMany({
              where: { id: { in: capitalConvIds } },
              select: {
                id: true,
                aiActive: true,
                lead: { select: { id: true, name: true, handle: true } }
              }
            }),
            []
          )
        : [];
    const convById = new Map(capitalConvs.map((c) => [c.id, c]));
    const attentionCapital = capitalNeedsResolution
      .filter((r) => {
        const passingAt = passingByConv.get(r.conversationId);
        // If a passing audit exists AFTER this block, the lead
        // already verified — drop.
        if (passingAt && passingAt > r.createdAt) return false;
        return true;
      })
      .filter((r) => !isDismissed(r.conversationId, 'capital_verification'))
      .map((r) => {
        const conv = convById.get(r.conversationId);
        if (!conv) return null;
        return {
          type: 'capital_verification' as const,
          conversationId: r.conversationId,
          leadId: conv.lead.id,
          leadName: conv.lead.name,
          leadHandle: conv.lead.handle,
          flaggedAt: r.createdAt.toISOString(),
          aiActive: conv.aiActive
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // PRIORITY 2.B2 — unverified AI response sent (best-effort exhaust)
    // Fix B / booking-fabrication gate exhausted its retries and shipped
    // the last response as-is rather than escalating. Operator reviews
    // during daily check; no hard pause. Same dismiss semantics as
    // other items — resurface if a new LEAD message arrives after
    // dismissal.
    const attentionUnverifiedSent = unverifiedSentRows
      .filter((r) => {
        const passingAt = passingByConv.get(r.conversationId);
        // If a passing audit exists AFTER the gate exhaustion, the
        // lead effectively verified after the fact — drop.
        if (passingAt && passingAt > r.createdAt) return false;
        return true;
      })
      .filter((r) => !isDismissed(r.conversationId, 'unverified_sent'))
      .map((r) => {
        const conv = convById.get(r.conversationId);
        if (!conv) return null;
        return {
          type: 'unverified_sent' as const,
          conversationId: r.conversationId,
          leadId: conv.lead.id,
          leadName: conv.lead.name,
          leadHandle: conv.lead.handle,
          flaggedAt: r.createdAt.toISOString()
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const attentionHistoricalMetadataLeaks = historicalMetadataLeakMatches
      .filter(
        (r) =>
          !isDismissed(r.message.conversationId, 'historical_metadata_leak')
      )
      .map((r) => ({
        type: 'historical_metadata_leak' as const,
        conversationId: r.message.conversationId,
        leadId: r.message.conversation.lead.id,
        leadName: r.message.conversation.lead.name,
        leadHandle: r.message.conversation.lead.handle,
        messageId: r.message.id,
        matchedText: r.leak.matchedText,
        matchedPattern: r.leak.matchedPattern,
        detectedAt: r.message.timestamp.toISOString()
      }));

    // PRIORITY 2.C — upcoming calls
    const attentionUpcomingCalls = upcomingCallRows
      .filter((c) => !isDismissed(c.id, 'upcoming_call'))
      .map((c) => ({
        type: 'upcoming_call' as const,
        conversationId: c.id,
        leadId: c.lead.id,
        leadName: c.lead.name,
        leadHandle: c.lead.handle,
        callAt: c.scheduledCallAt!.toISOString(),
        callTimezone: c.scheduledCallTimezone ?? null,
        callConfirmed: c.callConfirmed
      }));

    const attentionCallUnconfirmed = callUnconfirmedRows
      .filter((c) => !isDismissed(c.id, 'call_unconfirmed_past_due'))
      .map((c) => ({
        type: 'call_unconfirmed_past_due' as const,
        conversationId: c.id,
        leadId: c.lead.id,
        leadName: c.lead.name,
        leadHandle: c.lead.handle,
        callAt: c.scheduledCallAt!.toISOString(),
        callTimezone: c.scheduledCallTimezone ?? null
      }));

    const attentionCallOutcomeNeeded = callOutcomeNeededRows
      .filter((c) => !isDismissed(c.id, 'call_outcome_needed'))
      .map((c) => ({
        type: 'call_outcome_needed' as const,
        conversationId: c.id,
        leadId: c.lead.id,
        leadName: c.lead.name,
        leadHandle: c.lead.handle,
        callAt: c.scheduledCallAt!.toISOString(),
        callTimezone: c.scheduledCallTimezone ?? null
      }));

    const recoveryPriorityRank: Record<string, number> = {
      HOT: 0,
      MEDIUM: 1,
      LOW: 2
    };
    const attentionPendingRecovery = pendingRecoveryRows
      .filter((r) => !isDismissed(r.conversationId, 'pending_auto_recovery'))
      .sort(
        (a, b) =>
          (recoveryPriorityRank[a.priority] ?? 3) -
            (recoveryPriorityRank[b.priority] ?? 3) ||
          b.createdAt.getTime() - a.createdAt.getTime()
      )
      .map((r) => ({
        type: 'pending_auto_recovery' as const,
        eventId: r.id,
        conversationId: r.conversationId,
        leadId: r.leadId,
        leadName: r.lead.name,
        leadHandle: r.lead.handle,
        triggerReason: r.triggerReason,
        recoveryAction: r.recoveryAction,
        priority: r.priority,
        generatedMessages: r.generatedMessages,
        createdAt: r.createdAt.toISOString()
      }));

    // PRIORITY 2.D — unreviewed count
    const attentionUnreviewed =
      unreviewedCount > 0
        ? [{ type: 'unreviewed' as const, count: unreviewedCount }]
        : [];

    // ── PRIORITY 2.E: Window-keepalive items ─────────────────────
    // Group fired keepalives by conversation, count how many fired
    // since the most-recent LEAD message. 3+ → exhausted.
    // Most-recent ≥ 6h ago and no LEAD since → no_response.
    const keepaliveConvIds = Array.from(
      new Set(keepaliveRows.map((r) => r.conversationId))
    );
    const keepaliveConvs =
      keepaliveConvIds.length > 0
        ? await safe(
            prisma.conversation.findMany({
              where: { id: { in: keepaliveConvIds }, ...accountConvFilter },
              select: {
                id: true,
                scheduledCallAt: true,
                lead: { select: { id: true, name: true, handle: true } }
              }
            }),
            []
          )
        : [];
    const keepaliveConvById = new Map(keepaliveConvs.map((c) => [c.id, c]));
    const latestLeadForKeepalive =
      keepaliveConvIds.length > 0
        ? await safe(
            prisma.message.findMany({
              where: {
                conversationId: { in: keepaliveConvIds },
                sender: 'LEAD'
              },
              orderBy: { timestamp: 'desc' },
              distinct: ['conversationId'],
              select: { conversationId: true, timestamp: true }
            }),
            []
          )
        : [];
    const latestLeadByKeepaliveConv = new Map<string, Date>();
    for (const m of latestLeadForKeepalive) {
      latestLeadByKeepaliveConv.set(m.conversationId, m.timestamp);
    }
    // Partition rows per conversation, ordered newest-first
    const rowsByConv = new Map<string, typeof keepaliveRows>();
    for (const r of keepaliveRows) {
      const arr = rowsByConv.get(r.conversationId) ?? [];
      arr.push(r);
      rowsByConv.set(r.conversationId, arr);
    }
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const KEEPALIVE_EXHAUSTION = 3;
    const attentionKeepaliveNoResponse: Array<{
      type: 'keepalive_no_response';
      conversationId: string;
      leadId: string;
      leadName: string;
      leadHandle: string;
      firedAt: string;
      callAt: string | null;
    }> = [];
    const attentionKeepaliveExhausted: Array<{
      type: 'keepalive_exhausted';
      conversationId: string;
      leadId: string;
      leadName: string;
      leadHandle: string;
      callAt: string | null;
    }> = [];
    for (const [convId, rows] of Array.from(rowsByConv.entries())) {
      const conv = keepaliveConvById.get(convId);
      if (!conv) continue;
      const latestLead = latestLeadByKeepaliveConv.get(convId) ?? new Date(0);
      const keepalivesSinceLead = rows.filter(
        (r) => r.firedAt && r.firedAt.getTime() > latestLead.getTime()
      );
      const mostRecent = rows[0]; // rows are ordered firedAt desc
      if (!mostRecent.firedAt) continue;
      if (keepalivesSinceLead.length >= KEEPALIVE_EXHAUSTION) {
        if (!isDismissed(convId, 'keepalive_exhausted')) {
          attentionKeepaliveExhausted.push({
            type: 'keepalive_exhausted',
            conversationId: convId,
            leadId: conv.lead.id,
            leadName: conv.lead.name,
            leadHandle: conv.lead.handle,
            callAt: conv.scheduledCallAt?.toISOString() ?? null
          });
        }
      } else if (
        keepalivesSinceLead.length >= 1 &&
        now.getTime() - mostRecent.firedAt.getTime() >= SIX_HOURS_MS
      ) {
        if (!isDismissed(convId, 'keepalive_no_response')) {
          attentionKeepaliveNoResponse.push({
            type: 'keepalive_no_response',
            conversationId: convId,
            leadId: conv.lead.id,
            leadName: conv.lead.name,
            leadHandle: conv.lead.handle,
            firedAt: mostRecent.firedAt.toISOString(),
            callAt: conv.scheduledCallAt?.toISOString() ?? null
          });
        }
      }
    }

    // ── INFO: auto-send readiness ─────────────────────────────────
    // Per platform where awayMode is currently OFF, count
    // TrainingEvents over the last 7 days. If approval_rate is ≥85%
    // across ≥20 events, surface a "ready for auto-send" info item
    // with an Enable CTA. Gives operators a data-driven signal for
    // when to exit test mode instead of guessing.
    const readinessWindow = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const account = await prisma.account.findUnique({
      where: { id: auth.accountId },
      select: { awayModeInstagram: true, awayModeFacebook: true }
    });
    const infoReadiness: Array<{
      type: 'autosend_ready';
      platform: 'INSTAGRAM' | 'FACEBOOK';
      approvalRate: number;
      totalEvents: number;
      approved: number;
      edited: number;
      rejected: number;
    }> = [];
    const platformsToCheck: Array<'INSTAGRAM' | 'FACEBOOK'> = [];
    if (account && !account.awayModeInstagram)
      platformsToCheck.push('INSTAGRAM');
    if (account && !account.awayModeFacebook) platformsToCheck.push('FACEBOOK');

    for (const platform of platformsToCheck) {
      const grouped = await prisma.trainingEvent.groupBy({
        by: ['type'],
        where: {
          accountId: auth.accountId,
          platform,
          createdAt: { gte: readinessWindow }
        },
        _count: true
      });
      const approved = grouped.find((g) => g.type === 'APPROVED')?._count ?? 0;
      const edited = grouped.find((g) => g.type === 'EDITED')?._count ?? 0;
      const rejected = grouped.find((g) => g.type === 'REJECTED')?._count ?? 0;
      const totalEvents = approved + edited + rejected;
      if (totalEvents < 20) continue;
      // Approval rate: APPROVED / total. Edited counts as "the AI got
      // it close but not perfect" — excluded from the numerator so
      // accounts only promote when the verbatim-approval rate is
      // strong. This matches the spec's "approval_rate = approved /
      // (approved + edited + rejected)" formula.
      const approvalRate = approved / totalEvents;
      if (approvalRate >= 0.85) {
        infoReadiness.push({
          type: 'autosend_ready',
          platform,
          approvalRate: Number(approvalRate.toFixed(3)),
          totalEvents,
          approved,
          edited,
          rejected
        });
      }
    }

    // PRIORITY 1.D — scheduling conflicts (lead filled Typeform, can't
    // make available times). CRITICAL — operator needs to manually
    // confirm an alternate slot. Shown above stuck-conversation items
    // in the urgent bucket.
    const schedulingConflictRows = await safe(
      prisma.conversation.findMany({
        where: {
          ...accountConvFilter,
          schedulingConflict: true,
          scheduledCallAt: null,
          schedulingConflictAt: {
            gte: new Date(now.getTime() - RECENT_ACTIVITY_MS)
          }
        },
        select: {
          id: true,
          schedulingConflictAt: true,
          schedulingConflictPreference: true,
          lead: { select: { id: true, name: true, handle: true } }
        },
        orderBy: { schedulingConflictAt: 'desc' }
      }),
      [] as Array<{
        id: string;
        schedulingConflictAt: Date | null;
        schedulingConflictPreference: string | null;
        lead: { id: string; name: string; handle: string };
      }>
    );
    const urgentSchedulingConflicts = schedulingConflictRows
      .filter((c) => !isDismissed(c.id, 'scheduling_conflict'))
      .map((c) => ({
        type: 'scheduling_conflict' as const,
        conversationId: c.id,
        leadId: c.lead.id,
        leadName: c.lead.name,
        leadHandle: c.lead.handle,
        preference: c.schedulingConflictPreference,
        detectedAt: c.schedulingConflictAt?.toISOString() ?? null
      }));

    return NextResponse.json({
      urgent: [
        ...urgentDistress,
        ...urgentSchedulingConflicts,
        ...urgentStuck,
        ...urgentDeliveryFailures
      ],
      attention: [
        ...attentionPendingRecovery,
        ...attentionPaused,
        ...attentionCapital,
        ...attentionHistoricalMetadataLeaks,
        ...attentionUnverifiedSent,
        ...attentionKeepaliveExhausted,
        ...attentionKeepaliveNoResponse,
        ...attentionCallUnconfirmed,
        ...attentionCallOutcomeNeeded,
        ...attentionUpcomingCalls,
        ...attentionUnreviewed
      ],
      info: [
        {
          type: 'r34_catch_counter' as const,
          windowHours: 24,
          count: r34CatchCount24h,
          alertThresholdExceeded: r34CatchCountLastHour > 5,
          lastHourCount: r34CatchCountLastHour
        },
        ...infoReadiness,
        {
          type: 'self_recovery_summary' as const,
          windowDays: RECENT_ACTIVITY_DAYS,
          counts: recoveryStatusRows.map((row) => ({
            status: row.status,
            triggerReason: row.triggerReason,
            count: row._count
          }))
        },
        {
          type: 'silent_stop_summary' as const,
          windowHours: 24,
          detected: silentStopCount24h,
          autoRecovered: silentStopAutoRecovered24h,
          operatorReview: silentStopOperatorReview24h,
          failed: silentStopFailed24h,
          alertThresholdExceeded: silentStopLastHourCount > 5,
          lastHourCount: silentStopLastHourCount,
          counts: silentStopStatusRows.map((row) => ({
            recoveryStatus: row.recoveryStatus,
            detectedReason: row.detectedReason,
            count: row._count
          })),
          recent: recentSilentStopRows.map((row) => ({
            eventId: row.id,
            conversationId: row.conversation.id,
            leadId: row.conversation.lead.id,
            leadName: row.conversation.lead.name,
            leadHandle: row.conversation.lead.handle,
            detectedAt: row.detectedAt.toISOString(),
            detectedReason: row.detectedReason,
            recoveryAction: row.recoveryAction,
            recoveryStatus: row.recoveryStatus
          }))
        }
      ],
      generatedAt: now.toISOString()
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error('[dashboard/actions] error:', err);
    return NextResponse.json(
      { error: 'Failed to load dashboard actions' },
      { status: 500 }
    );
  }
}
