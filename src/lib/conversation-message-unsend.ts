import prisma from '@/lib/prisma';
import { requireAuth, AuthError, isPlatformOperator } from '@/lib/auth-guard';
import { unsendDM } from '@/lib/instagram';
import { broadcastMessageDeleted } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

// We do NOT enforce a UI-side window. Per spec: let Meta's API decide
// whether the unsend is possible. The actual error message bubbles
// back to the operator so they understand WHY the unsend failed
// (window expired, lead read it, transient outage, etc.).

interface UnsendErrorMapping {
  status: number;
  body: { error: string; retryable: boolean; metaCode?: number };
}

/** Map Meta DELETE failure into a UI-friendly response. */
function mapMetaUnsendError(
  status: number,
  rawBody: string
): UnsendErrorMapping {
  // Try to parse Meta's structured error envelope.
  let parsed:
    | { error?: { message?: string; code?: number; error_subcode?: number } }
    | undefined;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    /* not JSON */
  }
  const code = parsed?.error?.code;
  const subcode = parsed?.error?.error_subcode;
  const metaMessage = parsed?.error?.message;

  // Transient: 500-class OR Meta-flagged is_transient + code 2.
  if (status >= 500 || code === 2) {
    return {
      status: 503,
      body: {
        error: 'Meta servers temporarily unavailable. Try again in a moment.',
        retryable: true,
        metaCode: code
      }
    };
  }

  // 400 + code 100 + sub 33 → "object does not exist". Meta uses this
  // for messages that have aged out of the unsend window OR were
  // already read by the lead.
  if (code === 100) {
    return {
      status: 410,
      body: {
        error:
          'Message can no longer be unsent — lead has already read it or the window has passed.',
        retryable: false,
        metaCode: 100
      }
    };
  }

  // Permission/scope errors — operator's account isn't authorised
  // to delete this specific message.
  if (code === 200 || code === 10 || code === 3) {
    return {
      status: 403,
      body: {
        error:
          metaMessage ||
          'Account does not have permission to unsend this message.',
        retryable: false,
        metaCode: code
      }
    };
  }

  return {
    status: 502,
    body: {
      error: metaMessage || 'Meta refused the unsend',
      retryable: false,
      metaCode: code,
      ...(subcode ? { metaSubcode: subcode } : {})
    } as UnsendErrorMapping['body']
  };
}

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

  if (message.sender === 'LEAD') {
    return NextResponse.json(
      { error: 'Cannot unsend lead messages', retryable: false },
      { status: 400 }
    );
  }
  if (
    message.sender !== 'AI' &&
    message.sender !== 'HUMAN' &&
    message.sender !== 'MANYCHAT'
  ) {
    return NextResponse.json(
      {
        error: 'Only outbound (AI / HUMAN / MANYCHAT) messages can be unsent',
        retryable: false
      },
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

  if (!message.platformMessageId) {
    return NextResponse.json(
      {
        error: 'Message has no platformMessageId; cannot unsend on Meta side',
        retryable: false
      },
      { status: 400 }
    );
  }

  const accountId = message.conversation.lead.accountId;
  if (message.conversation.lead.platform !== 'INSTAGRAM') {
    return NextResponse.json(
      {
        error: `Unsend not yet supported for platform=${message.conversation.lead.platform}`,
        retryable: false
      },
      { status: 400 }
    );
  }

  const result = await unsendDM(accountId, message.platformMessageId);
  if (!result.ok) {
    const mapped = mapMetaUnsendError(result.status, result.error || '');
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  const deletedAt = new Date();
  await prisma.message.update({
    where: { id: message.id },
    data: {
      deletedAt,
      deletedBy: auth.userId,
      deletedSource: 'DASHBOARD',
      deletedReason: 'OPERATOR_UNSEND'
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
