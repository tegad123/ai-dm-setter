'use client';

import * as React from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  IconAlertTriangle,
  IconClock,
  IconAlertCircle,
  IconPhoneCall,
  IconCircleCheck,
  IconChevronRight,
  IconHeart,
  IconCash,
  IconChecklist
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// ActionRequired
// ---------------------------------------------------------------------------
// Sits at the top of the Dashboard Overview page. Polls
// /api/dashboard/actions every 30s and renders the operator's
// most-important pending tasks grouped by priority.
//
// Empty state ("All caught up 💪") is itself valuable — it gives the
// operator confidence nothing is slipping. Each action item is a
// clickable row that routes to the relevant conversation or filter.
// Auto-resolves: items disappear when the underlying condition changes
// (operator responds, AI re-enables, capital verified, etc.) — no
// manual dismiss needed.
// ---------------------------------------------------------------------------

interface UrgentDistress {
  type: 'distress';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  detectedAt: string | null;
}
interface UrgentStuck {
  type: 'stuck';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  lastLeadMessageAt: string;
  hoursWaiting: number;
}
interface UrgentDeliveryFailure {
  type: 'delivery_failure';
  count: number;
  conversationIds: string[];
  latestFailureAt: string | null;
}
type UrgentItem = UrgentDistress | UrgentStuck | UrgentDeliveryFailure;

interface AttentionPaused {
  type: 'ai_paused';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  pauseReason: string;
  pausedAt: string;
}
interface AttentionCapital {
  type: 'capital_verification';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  flaggedAt: string;
  aiActive: boolean;
}
interface AttentionUpcomingCall {
  type: 'upcoming_call';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  callAt: string;
  callTimezone: string | null;
}
interface AttentionUnreviewed {
  type: 'unreviewed';
  count: number;
}
type AttentionItem =
  | AttentionPaused
  | AttentionCapital
  | AttentionUpcomingCall
  | AttentionUnreviewed;

interface ActionsResponse {
  urgent: UrgentItem[];
  attention: AttentionItem[];
  info: unknown[];
  generatedAt: string;
}

const POLL_INTERVAL_MS = 30 * 1000;

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  const diffMs = now - t;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const min = Math.floor(abs / 60000);
  const hr = Math.floor(abs / (60 * 60 * 1000));
  const day = Math.floor(abs / (24 * 60 * 60 * 1000));
  const label =
    day >= 1
      ? `${day}d`
      : hr >= 1
        ? `${hr}h`
        : min >= 1
          ? `${min}m`
          : 'just now';
  if (label === 'just now') return label;
  return future ? `in ${label}` : `${label} ago`;
}

// Each row looks the same — a coloured priority dot, label, time
// context, chevron. Clickable wrapper navigates to `href`.
interface ActionRowProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
  primary: React.ReactNode;
  meta?: React.ReactNode;
}
function ActionRow({
  href,
  icon: Icon,
  iconClassName,
  primary,
  meta
}: ActionRowProps) {
  return (
    <Link
      href={href}
      className={cn(
        'group flex items-center gap-3 rounded-md px-3 py-2.5',
        'hover:bg-muted/50 transition-colors'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', iconClassName)} />
      <div className='min-w-0 flex-1 text-sm'>{primary}</div>
      {meta ? (
        <span className='text-muted-foreground text-xs whitespace-nowrap'>
          {meta}
        </span>
      ) : null}
      <IconChevronRight className='text-muted-foreground h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5' />
    </Link>
  );
}

interface SectionLabelProps {
  label: string;
  count: number;
}
function SectionLabel({ label, count }: SectionLabelProps) {
  return (
    <div className='text-muted-foreground px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wider uppercase'>
      {label} <span className='text-muted-foreground/60 ml-0.5'>({count})</span>
    </div>
  );
}

export function ActionRequired() {
  const [data, setData] = React.useState<ActionsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Tick to force re-render so relative timestamps stay fresh
  // between polls. 60s is fine — finer granularity isn't worth it.
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    let cancelled = false;
    const fetchActions = async () => {
      try {
        const res = await fetch('/api/dashboard/actions', {
          credentials: 'include'
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json: ActionsResponse = await res.json();
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchActions();
    const interval = setInterval(fetchActions, POLL_INTERVAL_MS);
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearInterval(tick);
    };
  }, []);

  const urgentCount = data?.urgent.length ?? 0;
  const attentionCount = data?.attention.length ?? 0;
  const totalCount = urgentCount + attentionCount;

  // Border accent — urgent first, then attention, else green.
  const borderClass = loading
    ? 'border-l-muted'
    : urgentCount > 0
      ? 'border-l-red-500'
      : attentionCount > 0
        ? 'border-l-amber-500'
        : 'border-l-emerald-500';

  return (
    <Card className={cn('border-l-4', borderClass)}>
      <CardHeader className='pb-2'>
        <CardTitle className='flex items-center gap-2 text-lg'>
          Action Required
          {loading ? (
            <Badge variant='outline' className='text-xs font-normal'>
              loading…
            </Badge>
          ) : totalCount > 0 ? (
            <Badge
              variant='outline'
              className={cn(
                'text-xs font-normal',
                urgentCount > 0
                  ? 'border-red-500/40 text-red-600 dark:text-red-400'
                  : 'border-amber-500/40 text-amber-600 dark:text-amber-400'
              )}
            >
              {totalCount}
            </Badge>
          ) : (
            <Badge
              variant='outline'
              className='border-emerald-500/40 text-xs font-normal text-emerald-600 dark:text-emerald-400'
            >
              ✓
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className='pt-0'>
        {error && !data ? (
          <div className='text-muted-foreground py-3 text-sm'>
            Couldn&apos;t load action items: {error}
          </div>
        ) : loading && !data ? (
          <div className='space-y-2 py-2'>
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className='bg-muted/40 h-9 w-full animate-pulse rounded-md'
              />
            ))}
          </div>
        ) : totalCount === 0 ? (
          <EmptyState />
        ) : (
          <div>
            {urgentCount > 0 && (
              <>
                <SectionLabel label='Urgent' count={urgentCount} />
                <div>{data!.urgent.map((item) => renderUrgent(item, now))}</div>
              </>
            )}
            {attentionCount > 0 && (
              <>
                <SectionLabel label='Needs Attention' count={attentionCount} />
                <div>
                  {data!.attention.map((item) => renderAttention(item, now))}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <div className='flex flex-col items-center gap-2 py-6 text-center'>
      <IconCircleCheck className='h-10 w-10 text-emerald-500' />
      <div className='text-sm font-medium'>All caught up 💪</div>
      <div className='text-muted-foreground text-xs'>
        No conversations need your attention right now. Your AI is handling
        everything.
      </div>
    </div>
  );
}

function renderUrgent(item: UrgentItem, now: number): React.ReactNode {
  switch (item.type) {
    case 'distress':
      return (
        <ActionRow
          key={`distress-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconHeart}
          iconClassName='text-red-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — distress signal detected, needs human response
              </span>
            </span>
          }
          meta={relativeTime(item.detectedAt, now)}
        />
      );
    case 'stuck':
      return (
        <ActionRow
          key={`stuck-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconAlertTriangle}
          iconClassName='text-red-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                waiting {item.hoursWaiting}h — AI may be stuck
              </span>
            </span>
          }
          meta={`${item.hoursWaiting}h ago`}
        />
      );
    case 'delivery_failure':
      return (
        <ActionRow
          key='delivery-failure'
          href='/dashboard/conversations'
          icon={IconAlertCircle}
          iconClassName='text-red-500'
          primary={
            <span>
              <span className='font-medium'>{item.count}</span>
              <span className='text-muted-foreground'>
                {' '}
                conversation{item.count === 1 ? '' : 's'} had failed message
                delivery in the last 24h
              </span>
            </span>
          }
          meta={relativeTime(item.latestFailureAt, now)}
        />
      );
  }
}

function renderAttention(item: AttentionItem, now: number): React.ReactNode {
  switch (item.type) {
    case 'ai_paused':
      return (
        <ActionRow
          key={`paused-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconAlertCircle}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — AI paused: {item.pauseReason}
              </span>
            </span>
          }
          meta={relativeTime(item.pausedAt, now)}
        />
      );
    case 'capital_verification':
      return (
        <ActionRow
          key={`capital-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconCash}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — needs capital verification before call
              </span>
            </span>
          }
          meta={relativeTime(item.flaggedAt, now)}
        />
      );
    case 'upcoming_call':
      return (
        <ActionRow
          key={`call-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconPhoneCall}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — call {relativeTime(item.callAt, now)}
                {item.callTimezone ? ` (${item.callTimezone})` : ''}
              </span>
            </span>
          }
          meta={new Date(item.callAt).toLocaleString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })}
        />
      );
    case 'unreviewed':
      return (
        <ActionRow
          key='unreviewed'
          href='/dashboard/conversations?priority=true'
          icon={IconChecklist}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.count}</span>
              <span className='text-muted-foreground'>
                {' '}
                conversation{item.count === 1 ? '' : 's'} ready for daily review
              </span>
            </span>
          }
        />
      );
  }
}

// Lightweight stub to render a placeholder when the polling happens
// but no data has been received yet — prevents layout shift.
ActionRequired.Skeleton = function ActionRequiredSkeleton() {
  return (
    <Card className='border-l-muted border-l-4'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-lg'>Action Required</CardTitle>
      </CardHeader>
      <CardContent className='pt-0'>
        <div className='space-y-2 py-2'>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className='bg-muted/40 h-9 w-full animate-pulse rounded-md'
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
};

// Also export a small hook the sidebar uses to show the action count
// badge. Reuses the same endpoint with its own polling so the badge
// stays current even when the user is off the dashboard page.
export function useActionRequiredCount() {
  const [count, setCount] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await fetch('/api/dashboard/actions', {
          credentials: 'include'
        });
        if (!res.ok) return;
        const json: ActionsResponse = await res.json();
        if (!cancelled) {
          setCount(json.urgent.length + json.attention.length);
        }
      } catch {
        // Silent — sidebar badge isn't worth surfacing errors for.
      }
    };
    fetchCount();
    const interval = setInterval(fetchCount, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return count;
}
