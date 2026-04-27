// ---------------------------------------------------------------------------
// GET /api/cron/recover-stale-bubbles
// ---------------------------------------------------------------------------
// Brian Dycey 2026-04-27 incident recovery.
//
// `deliverBubbleGroup` ships multi-bubble replies inline: bubble 0 → save,
// ship, sleep 8-25s, bubble 1 → save, ship, sleep, … When the underlying
// Vercel function context dies between bubble N and bubble N+1 (cold-start
// eviction, max-duration cutoff, deployment-mid-flight), the loop never
// resumes. Bubble N landed; bubbles N+1..M didn't. The MessageGroup row
// has `completedAt = null` and `failedAt = null` — the abandoned state.
//
// This cron sweeps for those abandoned groups and recovers the missing
// bubbles by shipping them via the platform helper. Source of truth for
// what was supposed to ship is the linked AISuggestion's `messageBubbles`
// JSON. After recovery (or persistent failure), MessageGroup.completedAt
// or MessageGroup.failedAt is set so the row never re-enters the sweep.
//
// Runs every minute (vercel.json). Idempotent: a group already at
// completed or failed terminal state is skipped.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { sendDM as sendInstagramDM } from '@/lib/instagram';
import { sendMessage as sendFacebookMessage } from '@/lib/facebook';
import { broadcastNewMessage, broadcastNotification } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;

// How long after generation we consider the group "abandoned". Must be
// > the longest plausible inline-sleep so we don't false-recover a group
// that's just slow. calculateBubbleDelay caps at 25s; 90s is comfortable.
const ABANDONED_GROUP_AGE_MS = 90 * 1000;

// Don't try to recover groups older than this — at some point the lead
// has likely moved on and the AI's planned bubble is stale. 1 hour cap
// matches the sweeper window.
const MAX_RECOVERY_AGE_MS = 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (!token || token !== process.env.CRON_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();
    const youngestEligible = new Date(now.getTime() - ABANDONED_GROUP_AGE_MS);
    const oldestEligible = new Date(now.getTime() - MAX_RECOVERY_AGE_MS);

    // Pull abandoned groups: completedAt + failedAt both null, and
    // generatedAt within the recovery window.
    const candidates = await prisma.messageGroup.findMany({
      where: {
        completedAt: null,
        failedAt: null,
        generatedAt: { lte: youngestEligible, gte: oldestEligible },
        bubbleCount: { gt: 1 }
      },
      include: {
        messages: {
          orderBy: { bubbleIndex: 'asc' },
          select: { bubbleIndex: true, content: true, platformMessageId: true }
        },
        aiSuggestion: { select: { messageBubbles: true } }
      },
      take: 50,
      orderBy: { generatedAt: 'asc' }
    });

    let recovered = 0;
    let abandonedNoSource = 0;
    let shipFailed = 0;

    for (const group of candidates) {
      // Find expected bubbles. Source-of-truth is AISuggestion.messageBubbles
      // (the array the gate approved). If the suggestion is missing or
      // the array isn't present, we can't recover — mark failed and
      // alert.
      const bubbles = (group.aiSuggestion?.messageBubbles ?? null) as
        | string[]
        | null;
      if (!Array.isArray(bubbles) || bubbles.length === 0) {
        abandonedNoSource++;
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            failedAt: now,
            deliveryNotes: { reason: 'no_source_bubbles_found' }
          }
        });
        continue;
      }

      const shipped = group.messages.length;
      if (shipped >= bubbles.length || shipped >= group.bubbleCount) {
        // Loop completed silently — likely the post-loop update failed.
        // Just close out the group cleanly.
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: { completedAt: now }
        });
        continue;
      }

      // Look up conversation + lead so we can ship via the right
      // platform helper. The convo could have flipped aiActive=false
      // between abandonment and recovery; bail if so.
      const conv = await prisma.conversation.findUnique({
        where: { id: group.conversationId },
        select: {
          aiActive: true,
          lead: {
            select: {
              id: true,
              accountId: true,
              platform: true,
              platformUserId: true
            }
          }
        }
      });
      if (!conv?.lead.platformUserId) {
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            failedAt: now,
            deliveryNotes: { reason: 'lead_missing_platform_user_id' }
          }
        });
        continue;
      }
      if (!conv.aiActive) {
        // Operator paused mid-recovery. Don't ship; mark failed + alert.
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            failedAt: now,
            deliveryNotes: { reason: 'ai_paused_during_recovery' }
          }
        });
        continue;
      }

      // Also check for a HUMAN message that landed after group start —
      // if the operator already manually replied, recovery would
      // duplicate / step on their message.
      const humanInterrupt = await prisma.message.findFirst({
        where: {
          conversationId: group.conversationId,
          sender: 'HUMAN',
          timestamp: { gt: group.generatedAt }
        },
        select: { id: true }
      });
      if (humanInterrupt) {
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            failedAt: now,
            deliveryNotes: { reason: 'human_replied_during_abandon' }
          }
        });
        continue;
      }

      // Ship the missing bubbles in order.
      let groupFailed = false;
      let lastShippedAt = now;
      for (let i = shipped; i < bubbles.length; i++) {
        const bubble = bubbles[i];
        try {
          let messageId: string | null = null;
          if (conv.lead.platform === 'INSTAGRAM') {
            const r = await sendInstagramDM(
              conv.lead.accountId,
              conv.lead.platformUserId,
              bubble
            );
            messageId = r?.messageId ?? null;
          } else if (conv.lead.platform === 'FACEBOOK') {
            const r = await sendFacebookMessage(
              conv.lead.accountId,
              conv.lead.platformUserId,
              bubble
            );
            messageId =
              typeof r === 'string' ? r : ((r as any)?.messageId ?? null);
          }
          // Save the Message row WITH the pmid since we know it now.
          // bubble 0 already exists; we're only writing rows for
          // indices that the original loop never reached.
          const newMsg = await prisma.message.create({
            data: {
              conversationId: group.conversationId,
              sender: 'AI',
              content: bubble,
              timestamp: new Date(),
              messageGroupId: group.id,
              bubbleIndex: i,
              bubbleTotalCount: group.bubbleCount,
              platformMessageId: messageId
            }
          });
          broadcastNewMessage({
            id: newMsg.id,
            conversationId: group.conversationId,
            sender: 'AI',
            content: bubble,
            timestamp: newMsg.timestamp.toISOString(),
            messageGroupId: group.id,
            bubbleIndex: i,
            bubbleTotalCount: group.bubbleCount
          });
          lastShippedAt = new Date();
          recovered++;
        } catch (shipErr) {
          console.error(
            `[recover-stale-bubbles] Ship failed for group ${group.id} bubble ${i}:`,
            shipErr
          );
          groupFailed = true;
          shipFailed++;
          break;
        }
      }

      if (groupFailed) {
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            failedAt: now,
            deliveryNotes: {
              reason: 'recovery_ship_failed',
              recoveredFromGroup: group.id
            }
          }
        });
        // Operator alert — recovery exhausted.
        try {
          await prisma.notification.create({
            data: {
              accountId: conv.lead.accountId,
              type: 'SYSTEM',
              title: 'Multi-bubble recovery failed',
              body: `Group ${group.id} on conversation ${group.conversationId}: original delivery aborted mid-group, recovery sweeper also failed to ship the remaining bubble(s). Lead may have received a stalled / single-bubble reply. Review and follow up manually.`,
              leadId: conv.lead.id
            }
          });
          broadcastNotification({
            accountId: conv.lead.accountId,
            type: 'SYSTEM',
            title: 'Multi-bubble recovery failed'
          });
        } catch (notifErr) {
          console.error(
            '[recover-stale-bubbles] Notification create failed:',
            notifErr
          );
        }
      } else {
        await prisma.messageGroup.update({
          where: { id: group.id },
          data: {
            completedAt: lastShippedAt,
            deliveryNotes: { recovered: true, recoveredAt: now.toISOString() }
          }
        });
        console.log(
          `[recover-stale-bubbles] Recovered group ${group.id} on convo ${group.conversationId} — shipped ${bubbles.length - shipped} missing bubble(s)`
        );
      }
    }

    return NextResponse.json({
      ok: true,
      examined: candidates.length,
      recovered,
      shipFailed,
      abandonedNoSource
    });
  } catch (err) {
    console.error('[recover-stale-bubbles] fatal:', err);
    return NextResponse.json(
      { error: 'recover-stale-bubbles cron failed' },
      { status: 500 }
    );
  }
}
