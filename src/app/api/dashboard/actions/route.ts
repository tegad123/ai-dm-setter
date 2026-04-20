import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
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

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    const accountId = auth.accountId;
    const now = new Date();

    // ── Helper: shared accountId-scoped lead filter ──────────────────
    // Conversation doesn't carry accountId directly — must filter via
    // lead. Reused across most queries below.
    const accountConvFilter = { lead: { is: { accountId } } } as const;

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
      unreviewedCount
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
            scheduledCallAt: {
              gte: now,
              lte: new Date(now.getTime() + UPCOMING_CALL_WINDOW_MS)
            }
          },
          select: {
            id: true,
            scheduledCallAt: true,
            scheduledCallTimezone: true,
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
      )
    ]);

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
    const seenCapital = new Set<string>();
    const capitalNeedsResolution: typeof capitalRoutingRows = [];
    for (const r of capitalRoutingRows) {
      if (seenCapital.has(r.conversationId)) continue;
      seenCapital.add(r.conversationId);
      capitalNeedsResolution.push(r);
    }
    // Pull the lead names for these conversations + check if a more
    // recent passing audit row exists (= verified, drop).
    const capitalConvIds = capitalNeedsResolution.map((r) => r.conversationId);
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
        callTimezone: c.scheduledCallTimezone ?? null
      }));

    // PRIORITY 2.D — unreviewed count
    const attentionUnreviewed =
      unreviewedCount > 0
        ? [{ type: 'unreviewed' as const, count: unreviewedCount }]
        : [];

    return NextResponse.json({
      urgent: [...urgentDistress, ...urgentStuck, ...urgentDeliveryFailures],
      attention: [
        ...attentionPaused,
        ...attentionCapital,
        ...attentionUpcomingCalls,
        ...attentionUnreviewed
      ],
      info: [],
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
