/**
 * Notification Service — Central notification creation and delivery.
 * Handles instant notifications for key events and scheduled summary reports.
 */

import prisma from '@/lib/prisma';
import type { Notification, NotificationType } from '@prisma/client';

// ─── Types ──────────────────────────────────────────────

interface CreateNotificationParams {
  accountId: string;
  type: NotificationType;
  title: string;
  body: string;
  userId?: string | null;
  leadId?: string | null;
}

// ─── Core ───────────────────────────────────────────────

/**
 * Create a notification record in the database.
 */
export async function createNotification(
  params: CreateNotificationParams
): Promise<Notification> {
  const notification = await prisma.notification.create({
    data: {
      accountId: params.accountId,
      type: params.type,
      title: params.title,
      body: params.body,
      userId: params.userId ?? null,
      leadId: params.leadId ?? null
    }
  });

  console.log(
    `[Notifications] Created: "${params.title}" (type=${params.type}, user=${params.userId ?? 'team-wide'})`
  );

  return notification;
}

// ─── Helper: notify specific roles ─────────────────────

/**
 * Create a notification for every user matching the given roles.
 */
async function notifyByRoles(
  accountId: string,
  roles: Array<'ADMIN' | 'CLOSER' | 'SETTER' | 'READ_ONLY'>,
  params: Omit<CreateNotificationParams, 'userId' | 'accountId'>
): Promise<void> {
  const users = await prisma.user.findMany({
    where: { accountId, role: { in: roles }, isActive: true },
    select: { id: true }
  });

  await Promise.all(
    users.map((user) =>
      createNotification({ ...params, accountId, userId: user.id })
    )
  );
}

// ─── Event Notifications ────────────────────────────────

/**
 * Instant notification when a call is booked.
 * Sent to all admins and closers.
 */
export async function notifyCallBooked(
  accountId: string,
  leadId: string,
  leadName: string,
  bookedAt: string
): Promise<void> {
  const formattedDate = new Date(bookedAt).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });

  await notifyByRoles(accountId, ['ADMIN', 'CLOSER'], {
    type: 'CALL_BOOKED',
    title: 'New Call Booked',
    body: `${leadName} booked a call for ${formattedDate}.`,
    leadId
  });
}

/**
 * Notification when a lead becomes hot.
 */
export async function notifyHotLead(
  accountId: string,
  leadId: string,
  leadName: string
): Promise<void> {
  await notifyByRoles(accountId, ['ADMIN', 'CLOSER', 'SETTER'], {
    type: 'HOT_LEAD',
    title: 'Hot Lead Detected',
    body: `${leadName} has been flagged as a hot lead. Prioritize follow-up.`,
    leadId
  });
}

/**
 * Notification when AI needs human intervention.
 */
export async function notifyHumanOverride(
  accountId: string,
  conversationId: string,
  leadName: string
): Promise<void> {
  // Find the lead via the conversation
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { leadId: true }
  });

  await notifyByRoles(accountId, ['ADMIN', 'SETTER'], {
    type: 'HUMAN_OVERRIDE_NEEDED',
    title: 'Human Override Needed',
    body: `AI requires human help with ${leadName}. Please take over the conversation.`,
    leadId: conversation?.leadId ?? null
  });
}

/**
 * Notification when a lead no-shows.
 */
export async function notifyNoShow(
  accountId: string,
  leadId: string,
  leadName: string
): Promise<void> {
  await notifyByRoles(accountId, ['ADMIN', 'CLOSER'], {
    type: 'NO_SHOW',
    title: 'No Show',
    body: `${leadName} did not show up to their scheduled call.`,
    leadId
  });
}

/**
 * Notification when a deal is closed.
 */
export async function notifyClosedDeal(
  accountId: string,
  leadId: string,
  leadName: string,
  revenue: number
): Promise<void> {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(revenue);

  await notifyByRoles(accountId, ['ADMIN', 'CLOSER'], {
    type: 'CLOSED_DEAL',
    title: 'Deal Closed!',
    body: `${leadName} closed for ${formatted}. Great work!`,
    leadId
  });
}

/**
 * Notification when a new lead enters the system.
 */
export async function notifyNewLead(
  accountId: string,
  leadId: string,
  leadName: string,
  platform: string
): Promise<void> {
  await notifyByRoles(accountId, ['ADMIN', 'SETTER'], {
    type: 'NEW_LEAD',
    title: 'New Lead',
    body: `${leadName} just entered via ${platform}. AI conversation started.`,
    leadId
  });
}

// ─── Scheduled Reports ──────────────────────────────────

/**
 * Generate a daily summary notification for all users.
 * Covers: leads created today, calls booked today, show rate this week, revenue this week.
 */
export async function generateDailySummary(): Promise<void> {
  // Generate daily summaries for ALL active accounts
  const accounts = await prisma.account.findMany({ select: { id: true } });

  for (let i = 0; i < accounts.length; i++) {
    await generateDailySummaryForAccount(accounts[i].id);
  }

  console.log(
    `[Notifications] Daily summaries generated for ${accounts.length} accounts`
  );
}

async function generateDailySummaryForAccount(
  accountId: string
): Promise<void> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  const leadsToday = await prisma.lead.count({
    where: { accountId, createdAt: { gte: startOfDay } }
  });

  const callsBookedToday = await prisma.lead.count({
    where: { accountId, bookedAt: { gte: startOfDay } }
  });

  const bookedThisWeek = await prisma.lead.count({
    where: { accountId, bookedAt: { gte: startOfWeek } }
  });
  const showedThisWeek = await prisma.lead.count({
    where: { accountId, bookedAt: { gte: startOfWeek }, showedUp: true }
  });
  const showRate =
    bookedThisWeek > 0
      ? Math.round((showedThisWeek / bookedThisWeek) * 100)
      : 0;

  const revenueResult = await prisma.lead.aggregate({
    where: {
      accountId,
      closedAt: { gte: startOfWeek },
      revenue: { not: null }
    },
    _sum: { revenue: true }
  });
  const weeklyRevenue = revenueResult._sum.revenue ?? 0;
  const formattedRevenue = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(weeklyRevenue);

  const pipelineCounts = await prisma.lead.groupBy({
    by: ['status'],
    where: { accountId, createdAt: { gte: startOfWeek } },
    _count: true
  });
  const pipelineLines = pipelineCounts
    .map((p) => `  ${p.status.replace(/_/g, ' ')}: ${p._count}`)
    .join('\n');

  const body = [
    `Daily Summary for ${now.toLocaleDateString('en-US', { dateStyle: 'full' })}`,
    '',
    `New Leads Today: ${leadsToday}`,
    `Calls Booked Today: ${callsBookedToday}`,
    `Show Rate (This Week): ${showRate}%`,
    `Revenue (This Week): ${formattedRevenue}`,
    '',
    'Pipeline Snapshot:',
    pipelineLines || '  No leads this week'
  ].join('\n');

  await createNotification({
    accountId,
    type: 'SYSTEM',
    title: 'Daily Summary',
    body
  });
}

/**
 * Generate a weekly report notification.
 * Covers: total leads, conversion funnel, revenue, top triggers.
 */
export async function generateWeeklyReport(): Promise<void> {
  const accounts = await prisma.account.findMany({ select: { id: true } });

  for (let i = 0; i < accounts.length; i++) {
    await generateWeeklyReportForAccount(accounts[i].id);
  }

  console.log(
    `[Notifications] Weekly reports generated for ${accounts.length} accounts`
  );
}

async function generateWeeklyReportForAccount(
  accountId: string
): Promise<void> {
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);

  const totalLeads = await prisma.lead.count({
    where: { accountId, createdAt: { gte: startOfWeek } }
  });

  const qualified = await prisma.lead.count({
    where: { accountId, createdAt: { gte: startOfWeek }, status: 'QUALIFIED' }
  });
  const booked = await prisma.lead.count({
    where: { accountId, bookedAt: { gte: startOfWeek } }
  });
  const showed = await prisma.lead.count({
    where: { accountId, bookedAt: { gte: startOfWeek }, showedUp: true }
  });
  const closed = await prisma.lead.count({
    where: { accountId, closedAt: { gte: startOfWeek } }
  });

  const revenueResult = await prisma.lead.aggregate({
    where: {
      accountId,
      closedAt: { gte: startOfWeek },
      revenue: { not: null }
    },
    _sum: { revenue: true }
  });
  const totalRevenue = revenueResult._sum.revenue ?? 0;
  const formattedRevenue = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(totalRevenue);

  const triggerStats = await prisma.lead.groupBy({
    by: ['triggerSource'],
    where: {
      accountId,
      createdAt: { gte: startOfWeek },
      triggerSource: { not: null }
    },
    _count: true,
    orderBy: { _count: { triggerSource: 'desc' } },
    take: 5
  });
  const triggerLines = triggerStats
    .map(
      (t, i) =>
        `  ${i + 1}. ${t.triggerSource ?? 'Unknown'} (${t._count} leads)`
    )
    .join('\n');

  const qualifyRate =
    totalLeads > 0 ? Math.round((qualified / totalLeads) * 100) : 0;
  const bookRate = totalLeads > 0 ? Math.round((booked / totalLeads) * 100) : 0;
  const showRate = booked > 0 ? Math.round((showed / booked) * 100) : 0;
  const closeRate = showed > 0 ? Math.round((closed / showed) * 100) : 0;

  const body = [
    `Weekly Report: ${startOfWeek.toLocaleDateString('en-US', { dateStyle: 'medium' })} - ${now.toLocaleDateString('en-US', { dateStyle: 'medium' })}`,
    '',
    `Total New Leads: ${totalLeads}`,
    '',
    'Conversion Funnel:',
    `  Qualified: ${qualified} (${qualifyRate}% of leads)`,
    `  Booked: ${booked} (${bookRate}% of leads)`,
    `  Showed: ${showed} (${showRate}% of booked)`,
    `  Closed: ${closed} (${closeRate}% of showed)`,
    '',
    `Total Revenue: ${formattedRevenue}`,
    '',
    'Top Performing Triggers:',
    triggerLines || '  No trigger data this week'
  ].join('\n');

  await createNotification({
    accountId,
    type: 'SYSTEM',
    title: 'Weekly Report',
    body
  });
}
