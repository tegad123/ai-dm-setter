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
  IconChecklist,
  IconX
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
interface UrgentSchedulingConflict {
  type: 'scheduling_conflict';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  preference: string | null;
  detectedAt: string | null;
}
type UrgentItem =
  | UrgentDistress
  | UrgentStuck
  | UrgentDeliveryFailure
  | UrgentSchedulingConflict;

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
  callConfirmed: boolean;
}
interface AttentionCallUnconfirmed {
  type: 'call_unconfirmed_past_due';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  callAt: string;
  callTimezone: string | null;
}
interface AttentionCallOutcomeNeeded {
  type: 'call_outcome_needed';
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
// Fix B / booking-fabrication gate exhausted retries and shipped the
// last response as-is. AI stayed active, lead got a reply. Operator
// reviews during their daily check to confirm the response was
// reasonable.
interface AttentionUnverifiedSent {
  type: 'unverified_sent';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  flaggedAt: string;
}
// 24h window keepalive fired 6+ hours ago without a lead response.
// Operator may want to manually reach out before the window closes.
interface AttentionKeepaliveNoResponse {
  type: 'keepalive_no_response';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  firedAt: string;
  callAt: string | null;
}
// Three consecutive keepalives fired with no lead response. The
// conversation is effectively dead — the cron stopped firing and
// needs operator decision.
interface AttentionKeepaliveExhausted {
  type: 'keepalive_exhausted';
  conversationId: string;
  leadId: string;
  leadName: string;
  leadHandle: string;
  callAt: string | null;
}
type AttentionItem =
  | AttentionPaused
  | AttentionCapital
  | AttentionUnverifiedSent
  | AttentionKeepaliveNoResponse
  | AttentionKeepaliveExhausted
  | AttentionCallUnconfirmed
  | AttentionCallOutcomeNeeded
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
// context, optional dismiss X, chevron. Clickable wrapper navigates to
// `href`. The dismiss X is a nested button — we stopPropagation +
// preventDefault on its click so the Link navigation doesn't fire.
interface ActionRowProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName: string;
  primary: React.ReactNode;
  meta?: React.ReactNode;
  onDismiss?: () => void;
}
function ActionRow({
  href,
  icon: Icon,
  iconClassName,
  primary,
  meta,
  onDismiss
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
      {onDismiss ? (
        <button
          type='button'
          aria-label='Dismiss'
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }}
          className={cn(
            'text-muted-foreground/60 hover:text-foreground',
            'hover:bg-muted flex h-6 w-6 shrink-0 items-center justify-center rounded',
            'opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100'
          )}
        >
          <IconX className='h-3.5 w-3.5' />
        </button>
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

type DismissibleActionType =
  | 'distress'
  | 'stuck'
  | 'scheduling_conflict'
  | 'ai_paused'
  | 'capital_verification'
  | 'upcoming_call'
  | 'unverified_sent'
  | 'keepalive_no_response'
  | 'keepalive_exhausted'
  | 'call_unconfirmed_past_due'
  | 'call_outcome_needed';

export function ActionRequired() {
  const [data, setData] = React.useState<ActionsResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Tick to force re-render so relative timestamps stay fresh
  // between polls. 60s is fine — finer granularity isn't worth it.
  const [now, setNow] = React.useState(() => Date.now());

  // Optimistic dismiss: remove the item from local state immediately,
  // then POST to the dismiss endpoint. On network error we log but
  // leave the UI optimistic — the next 30s poll will re-fetch. If the
  // server really didn't persist the dismissal, the item resurfaces
  // on that poll. Net effect: dismiss feels instant, and the rare
  // failure degrades gracefully.
  const dismissItem = React.useCallback(
    (conversationId: string, actionType: DismissibleActionType) => {
      setData((prev) => {
        if (!prev) return prev;
        const filterPred = (item: { type: string; conversationId?: string }) =>
          !(item.type === actionType && item.conversationId === conversationId);
        return {
          ...prev,
          urgent: prev.urgent.filter(filterPred) as typeof prev.urgent,
          attention: prev.attention.filter(filterPred) as typeof prev.attention
        };
      });
      void fetch('/api/dashboard/actions/dismiss', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, actionType })
      }).catch((err) => {
        // Non-fatal — next poll will reconcile server state.
        console.error('[action-required] dismiss POST failed:', err);
      });
    },
    []
  );

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
    <Card className={cn('glass glass-sm border-l-4 py-4', borderClass)}>
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
                <div>
                  {data!.urgent.map((item) =>
                    renderUrgent(item, now, dismissItem)
                  )}
                </div>
              </>
            )}
            {attentionCount > 0 && (
              <>
                <SectionLabel label='Needs Attention' count={attentionCount} />
                <div>
                  {data!.attention.map((item) =>
                    renderAttention(item, now, dismissItem)
                  )}
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

function renderUrgent(
  item: UrgentItem,
  now: number,
  onDismiss: (convId: string, type: DismissibleActionType) => void
): React.ReactNode {
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
          onDismiss={() => onDismiss(item.conversationId, 'distress')}
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
          onDismiss={() => onDismiss(item.conversationId, 'stuck')}
        />
      );
    case 'delivery_failure':
      // Aggregate row — not dismissible at the account level.
      // Operators resolve by fixing the underlying delivery issue.
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
    case 'scheduling_conflict':
      return (
        <ActionRow
          key={`sched-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconPhoneCall}
          iconClassName='text-red-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — needs manual scheduling
                {item.preference ? `. Available: ${item.preference}` : ''}
              </span>
            </span>
          }
          meta={relativeTime(item.detectedAt, now)}
          onDismiss={() =>
            onDismiss(item.conversationId, 'scheduling_conflict')
          }
        />
      );
  }
}

function renderAttention(
  item: AttentionItem,
  now: number,
  onDismiss: (convId: string, type: DismissibleActionType) => void
): React.ReactNode {
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
          onDismiss={() => onDismiss(item.conversationId, 'ai_paused')}
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
          onDismiss={() =>
            onDismiss(item.conversationId, 'capital_verification')
          }
        />
      );
    case 'unverified_sent':
      // Fix B / booking-fabrication exhausted retries, shipped best
      // effort. Copy tells the operator to review the reply content,
      // not to jump into the conversation.
      return (
        <ActionRow
          key={`unverified-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconAlertCircle}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — AI sent unverified response, review recommended
              </span>
            </span>
          }
          meta={relativeTime(item.flaggedAt, now)}
          onDismiss={() => onDismiss(item.conversationId, 'unverified_sent')}
        />
      );
    case 'keepalive_no_response':
      // Keepalive fired 6+ hours ago, no lead response yet. Window
      // may close before the call. Operator can manually reach out.
      return (
        <ActionRow
          key={`keepalive-no-response-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconClock}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — keepalive sent, no response yet
                {item.callAt ? `, call ${relativeTime(item.callAt, now)}` : ''}
              </span>
            </span>
          }
          meta={relativeTime(item.firedAt, now)}
          onDismiss={() =>
            onDismiss(item.conversationId, 'keepalive_no_response')
          }
        />
      );
    case 'keepalive_exhausted':
      // 3 consecutive keepalives fired with no lead response. The
      // cron has stopped trying. Operator needs to decide whether
      // to reach out manually or let it go.
      return (
        <ActionRow
          key={`keepalive-exhausted-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconAlertCircle}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — lead unresponsive, 24h window may close before call
                {item.callAt
                  ? ` on ${new Date(item.callAt).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`
                  : ''}
              </span>
            </span>
          }
          onDismiss={() =>
            onDismiss(item.conversationId, 'keepalive_exhausted')
          }
        />
      );
    case 'call_unconfirmed_past_due':
      return (
        <ActionRow
          key={`call-unconfirmed-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconAlertTriangle}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — call time passed, no confirmation received
              </span>
            </span>
          }
          meta={relativeTime(item.callAt, now)}
          onDismiss={() =>
            onDismiss(item.conversationId, 'call_unconfirmed_past_due')
          }
        />
      );
    case 'call_outcome_needed':
      return (
        <ActionRow
          key={`call-outcome-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconChecklist}
          iconClassName='text-amber-500'
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — call was today, update outcome
              </span>
            </span>
          }
          meta={relativeTime(item.callAt, now)}
          onDismiss={() =>
            onDismiss(item.conversationId, 'call_outcome_needed')
          }
        />
      );
    case 'upcoming_call':
      return (
        <ActionRow
          key={`call-${item.conversationId}`}
          href={`/dashboard/conversations?conversationId=${item.conversationId}`}
          icon={IconPhoneCall}
          iconClassName={
            item.callConfirmed ? 'text-emerald-600' : 'text-amber-500'
          }
          primary={
            <span>
              <span className='font-medium'>{item.leadName}</span>
              <span className='text-muted-foreground'>
                {' '}
                — call {relativeTime(item.callAt, now)}
                {item.callTimezone ? ` (${item.callTimezone})` : ''}
                {item.callConfirmed ? ' confirmed' : ' unconfirmed'}
              </span>
            </span>
          }
          meta={new Date(item.callAt).toLocaleString(undefined, {
            weekday: 'short',
            hour: 'numeric',
            minute: '2-digit'
          })}
          onDismiss={() => onDismiss(item.conversationId, 'upcoming_call')}
        />
      );
    case 'unreviewed':
      // Aggregate row — operators resolve by completing reviews, not
      // by dismissing.
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
