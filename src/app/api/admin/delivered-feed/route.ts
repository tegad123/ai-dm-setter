// GET /api/admin/delivered-feed?accountId=&platform=INSTAGRAM&sinceMinutes=1440&limit=200
//
// Platform-operator live feed: every AI message DELIVERED to a lead
// (platformMessageId set, i.e. Meta accepted it) on one account + platform,
// newest first, each with the egress gate verdict written for that bubble,
// plus the gate HOLDs in the same window (drafts that did not go out and why).

import prisma from '@/lib/prisma';
import { requirePlatformAdmin, AuthError } from '@/lib/auth-guard';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const norm = (t: string | null | undefined) =>
  (t ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin(request);
    const sp = request.nextUrl.searchParams;
    const accountId = sp.get('accountId');
    const platform = (sp.get('platform') ?? 'INSTAGRAM') as
      | 'INSTAGRAM'
      | 'FACEBOOK';
    const sinceMinutes = Math.min(
      Number(sp.get('sinceMinutes') ?? 1440),
      60 * 24 * 14
    );
    const limit = Math.min(Number(sp.get('limit') ?? 200), 500);
    if (!accountId)
      return NextResponse.json(
        { error: 'accountId required' },
        { status: 400 }
      );
    const since = new Date(Date.now() - sinceMinutes * 60e3);

    const [account, delivered, shadow] = await Promise.all([
      prisma.account.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          name: true,
          generateOnlyInstagram: true,
          generateOnlyFacebook: true
        }
      }),
      prisma.message.findMany({
        where: {
          sender: 'AI',
          platformMessageId: { not: null },
          timestamp: { gte: since },
          conversation: { lead: { accountId, platform } }
        },
        orderBy: { timestamp: 'desc' },
        take: limit,
        select: {
          id: true,
          conversationId: true,
          content: true,
          timestamp: true,
          platformMessageId: true,
          conversation: {
            select: {
              currentScriptStep: true,
              lead: { select: { name: true } }
            }
          }
        }
      }),
      prisma.egressShadowLog.findMany({
        where: { accountId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 2000,
        select: {
          conversationId: true,
          createdAt: true,
          machineAllow: true,
          machineReason: true,
          sendPath: true,
          draftPreview: true
        }
      })
    ]);
    if (!account)
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    // Platform of each shadow row comes from its conversation.
    const convIds = Array.from(
      new Set(
        shadow.map((s) => s.conversationId).filter((x): x is string => !!x)
      )
    );
    const convs = await prisma.conversation.findMany({
      where: { id: { in: convIds } },
      select: { id: true, lead: { select: { platform: true, name: true } } }
    });
    const convInfo = new Map(convs.map((c) => [c.id, c.lead]));

    const feed = delivered.map((m) => {
      const cands = shadow.filter(
        (s) =>
          s.conversationId === m.conversationId &&
          Math.abs(s.createdAt.getTime() - m.timestamp.getTime()) < 10 * 60e3
      );
      const match =
        cands.find((s) => norm(s.draftPreview) === norm(m.content)) ?? null;
      return {
        id: m.id,
        conversationId: m.conversationId,
        leadName: m.conversation.lead.name,
        step: m.conversation.currentScriptStep,
        content: m.content,
        deliveredAt: m.timestamp.toISOString(),
        platformMessageId: m.platformMessageId,
        gate: match
          ? {
              allow: match.machineAllow,
              reason: match.machineReason,
              sendPath: match.sendPath
            }
          : null
      };
    });

    const holds = shadow
      .filter(
        (s) =>
          !s.machineAllow &&
          s.conversationId &&
          convInfo.get(s.conversationId)?.platform === platform
      )
      .slice(0, limit)
      .map((s) => ({
        conversationId: s.conversationId,
        leadName: convInfo.get(s.conversationId!)?.name ?? null,
        at: s.createdAt.toISOString(),
        reason: s.machineReason,
        sendPath: s.sendPath,
        draft: s.draftPreview
      }));

    return NextResponse.json({
      account: {
        id: account.id,
        name: account.name,
        generateOnly:
          platform === 'INSTAGRAM'
            ? account.generateOnlyInstagram
            : account.generateOnlyFacebook
      },
      platform,
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      deliveredCount: feed.length,
      holdCount: holds.length,
      delivered: feed,
      holds
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    console.error('GET /api/admin/delivered-feed error:', error);
    return NextResponse.json(
      { error: 'Failed to load delivered feed' },
      { status: 500 }
    );
  }
}
