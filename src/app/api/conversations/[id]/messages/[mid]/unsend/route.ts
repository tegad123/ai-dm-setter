import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { unsendDM } from '@/lib/instagram';
import { broadcastMessageDeleted } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

// Outbound unsend — operator clicks the unsend button in the
// conversation thread on a recent AI/HUMAN message. We:
//   1. Auth-gate (requireAuth + tenant scope).
//   2. Validate the message is unsendable (own-side, has a
//      platformMessageId, within the 10-min UI window, not already
//      deleted).
//   3. Call Meta's DELETE — only mark the local row deleted on
//      success so that if Meta refuses, the lead still sees the
//      message and we don't lie about its state.
//   4. Broadcast `message:deleted` to all open dashboard tabs.

const UNSEND_WINDOW_MS = 10 * 60 * 1000; // 10 min

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> }
) {
  let auth;
  try {
    auth = await requireAuth(request);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: conversationId, mid: messageId } = await params;

  // Tenant-scoped lookup. `mid` here is OUR Message.id (cuid), not
  // Meta's mid — clearer for the dashboard UI. Meta's mid lives on
  // platformMessageId and is what we send to the DELETE endpoint.
  const message = await prisma.message.findFirst({
    where: {
      id: messageId,
      conversationId,
      conversation: isPlatformOperator(auth.role)
        ? undefined
        : { lead: { accountId: auth.accountId } }
    },
    select: {
      id: true,
      conversationId: true,
      sender: true,
      timestamp: true,
      platformMessageId: true,
      deletedAt: true,
      conversation: {
        select: {
          id: true,
          lead: { select: { accountId: true, platform: true } }
        }
      }
    }
  });
  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  // Lead messages can't be unsent by us — Meta's API doesn't permit
  // deleting another user's messages. SYSTEM messages are internal
  // notes only; nothing to unsend there. Only AI / HUMAN / MANYCHAT
  // are own-side outbound and eligible.
  if (
    message.sender !== 'AI' &&
    message.sender !== 'HUMAN' &&
    message.sender !== 'MANYCHAT'
  ) {
    return NextResponse.json(
      { error: 'Only outbound (AI / HUMAN / MANYCHAT) messages can be unsent' },
      { status: 400 }
    );
  }

  if (message.deletedAt) {
    // Idempotent — already deleted is fine.
    return NextResponse.json({
      ok: true,
      alreadyDeleted: true,
      deletedAt: message.deletedAt.toISOString()
    });
  }

  const ageMs = Date.now() - message.timestamp.getTime();
  if (ageMs > UNSEND_WINDOW_MS) {
    return NextResponse.json(
      {
        error: `Unsend window expired (message is ${Math.round(ageMs / 60000)} min old; limit is 10 min)`
      },
      { status: 400 }
    );
  }

  if (!message.platformMessageId) {
    // Without a Meta mid we can't ask Meta to delete it — the row
    // exists but the platform never acknowledged the send (or the mid
    // wasn't captured). Refuse rather than lie about deleting from
    // the lead's inbox.
    return NextResponse.json(
      {
        error: 'Message has no platformMessageId; cannot unsend on Meta side'
      },
      { status: 400 }
    );
  }

  const accountId = message.conversation.lead.accountId;

  // Only IG is supported right now. Facebook can be added later by
  // calling sendFacebookMessage's sibling delete; the table currently
  // has only IG-source messages with mids that Meta will accept.
  if (message.conversation.lead.platform !== 'INSTAGRAM') {
    return NextResponse.json(
      {
        error: `Unsend not yet supported for platform=${message.conversation.lead.platform}`
      },
      { status: 400 }
    );
  }

  const result = await unsendDM(accountId, message.platformMessageId);
  if (!result.ok) {
    // Don't mark our row deleted if Meta refused — the lead still
    // sees the message, the dashboard should match.
    return NextResponse.json(
      {
        error: 'Meta refused the unsend',
        status: result.status,
        details: result.error?.slice(0, 500)
      },
      { status: 502 }
    );
  }

  const deletedAt = new Date();
  await prisma.message.update({
    where: { id: message.id },
    data: {
      deletedAt,
      deletedBy: auth.userId,
      deletedSource: 'DASHBOARD'
    }
  });

  broadcastMessageDeleted(accountId, {
    id: message.id,
    conversationId: message.conversationId,
    deletedAt: deletedAt.toISOString(),
    deletedBy: auth.userId,
    deletedSource: 'DASHBOARD'
  });

  return NextResponse.json({
    ok: true,
    deletedAt: deletedAt.toISOString()
  });
}
