import prisma from '@/lib/prisma';
import { requireAuth, AuthError } from '@/lib/auth-guard';
import { broadcastNotification } from '@/lib/realtime';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const unreadOnly = searchParams.get('unreadOnly') === 'true';

    const where: Record<string, unknown> = { accountId: auth.accountId };
    if (userId) where.userId = userId;
    if (unreadOnly) where.isRead = false;

    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        include: {
          lead: {
            select: { id: true, name: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      }),
      prisma.notification.count({
        where: {
          accountId: auth.accountId,
          ...(userId ? { userId } : {}),
          isRead: false
        }
      })
    ]);

    return NextResponse.json({ notifications, unreadCount });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to fetch notifications:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);

    const body = await request.json();
    const { userId, type, title, body: notifBody, leadId } = body;

    if (!type || !title || !notifBody) {
      return NextResponse.json(
        { error: 'type, title, and body are required' },
        { status: 400 }
      );
    }

    const notification = await prisma.notification.create({
      data: {
        accountId: auth.accountId,
        userId: userId || null,
        type,
        title,
        body: notifBody,
        leadId: leadId || null
      }
    });

    // Broadcast real-time notification (scoped to the auth's tenant).
    broadcastNotification(auth.accountId, {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      leadId: notification.leadId ?? undefined
    });

    return NextResponse.json(notification, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('Failed to create notification:', error);
    return NextResponse.json(
      { error: 'Failed to create notification' },
      { status: 500 }
    );
  }
}
