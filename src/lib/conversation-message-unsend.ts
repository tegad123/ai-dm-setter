import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { unsendDM } from '@/lib/instagram';
import { broadcastMessageDeleted } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

const UNSEND_WINDOW_MS = 10 * 60 * 1000; // 10 min

/**
 * Outbound unsend — operator clicks the unsend button in the
 * conversation thread on a recent AI/HUMAN/MANYCHAT message. We:
 * 1. Auth-gate and tenant-scope the message lookup.
 * 2. Validate the message is own-side, recent, platform-backed, and live.
 * 3. Call Meta's DELETE through unsendDM.
 * 4. Soft-delete locally and broadcast message:deleted for dashboards.
 */
export async function unsendConversationMessage(
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

  // `mid` is our Message.id (cuid), not Meta's mid. Meta's id lives
  // on platformMessageId and is what unsendDM sends to Graph.
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
    return NextResponse.json(
      {
        error: 'Message has no platformMessageId; cannot unsend on Meta side'
      },
      { status: 400 }
    );
  }

  const accountId = message.conversation.lead.accountId;
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
