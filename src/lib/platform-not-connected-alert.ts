// ---------------------------------------------------------------------------
// platform-not-connected-alert.ts
// ---------------------------------------------------------------------------
// Operator-visible signal for a class of drop that used to be invisible:
// Meta delivered a DM for a workspace we could resolve (a credential matched
// the webhook's entry id) but the workspace has no active credential for
// THAT platform, so the message was skipped. Until 2026-09-08 this was a
// console.log and a `continue` — an Instagram-first client whose Instagram
// was never connected (or got disconnected) simply saw an empty inbox
// (MULTI_TENANT_LEAK_AUDIT 2026-07-28 item #148).
//
// One in-app notification per account per platform per 24h; the webhook
// keeps logging at error level on every occurrence. Never throws — a failed
// alert must not change webhook behaviour.
// ---------------------------------------------------------------------------

import prisma from '@/lib/prisma';
import { broadcastNotification } from '@/lib/realtime';

const REMIND_MS = 24 * 60 * 60 * 1000;

const LABEL: Record<'INSTAGRAM' | 'FACEBOOK', string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook'
};

/**
 * Generic deduped operator notification: one SYSTEM row per account+title per
 * `dedupeMs` (default 24h). Never throws. Used for the silent-drop classes
 * that had no operator signal (IG parity day 2).
 */
export async function notifyOnce(params: {
  accountId: string;
  title: string;
  body: string;
  leadId?: string | null;
  dedupeMs?: number;
}): Promise<void> {
  try {
    const since = new Date(Date.now() - (params.dedupeMs ?? REMIND_MS));
    const recent = await prisma.notification.findFirst({
      where: {
        accountId: params.accountId,
        type: 'SYSTEM',
        title: params.title,
        ...(params.leadId ? { leadId: params.leadId } : {}),
        createdAt: { gte: since }
      },
      select: { id: true }
    });
    if (recent) return;
    await prisma.notification.create({
      data: {
        accountId: params.accountId,
        type: 'SYSTEM',
        title: params.title,
        body: params.body,
        leadId: params.leadId ?? undefined
      }
    });
    broadcastNotification(params.accountId, {
      type: 'SYSTEM',
      title: params.title
    });
  } catch (err) {
    console.error(
      '[notify-once] notification failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}

export async function notifyPlatformNotConnected(
  accountId: string,
  platform: 'INSTAGRAM' | 'FACEBOOK'
): Promise<void> {
  const name = LABEL[platform];
  const title = `${name} DMs are arriving but ${name} is not connected`;
  try {
    const recent = await prisma.notification.findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title,
        createdAt: { gte: new Date(Date.now() - REMIND_MS) }
      },
      select: { id: true }
    });
    if (recent) return;
    await prisma.notification.create({
      data: {
        accountId,
        type: 'SYSTEM',
        title,
        body:
          `Meta is delivering ${name} messages for this workspace, but there is no active ${name} ` +
          `connection, so they are being dropped and leads are not being created. ` +
          `Connect ${name} in Settings → Integrations to start receiving them.`
      }
    });
    broadcastNotification(accountId, { type: 'SYSTEM', title });
  } catch (err) {
    console.error(
      '[platform-not-connected-alert] notification failed (non-fatal):',
      err instanceof Error ? err.message : err
    );
  }
}
