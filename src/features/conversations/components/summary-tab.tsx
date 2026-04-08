'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { LeadStatusBadge } from '@/features/shared/lead-status-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { selectDisplayTags } from '@/features/conversations/lib/select-display-tags';
import {
  IconMessages,
  IconRobot,
  IconUser,
  IconUserCheck,
  IconClock,
  IconCalendar,
  IconTarget,
  IconArrowRight,
  IconCheck
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import type { LeadStatus } from '@/features/shared/lead-status-badge';

interface ConversationDetail {
  outcome?: string;
  leadIntentTag?: string;
  leadSource?: string;
  createdAt?: string;
  lastMessageAt?: string | null;
  stageOpeningAt?: string | null;
  stageSituationDiscoveryAt?: string | null;
  stageGoalEmotionalWhyAt?: string | null;
  stageUrgencyAt?: string | null;
  stageSoftPitchCommitmentAt?: string | null;
  stageFinancialScreeningAt?: string | null;
  stageBookingAt?: string | null;
  lead?: {
    experience?: string | null;
    incomeLevel?: string | null;
    geography?: string | null;
    bookedAt?: string | null;
    showedUp?: boolean;
  };
}

interface MessageData {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  stage?: string | null;
  sentimentScore?: number | null;
  objectionType?: string | null;
  stallType?: string | null;
}

interface SummaryTabProps {
  leadName: string;
  leadHandle: string;
  platform: string;
  status: string;
  aiActive: boolean;
  tags?: Array<{ id: string; name: string; color: string }>;
  messages: MessageData[];
  detail?: ConversationDetail | null;
  createdAt?: string;
}

const STAGES = [
  { key: 'stageOpeningAt', label: 'Opening' },
  { key: 'stageSituationDiscoveryAt', label: 'Discovery' },
  { key: 'stageGoalEmotionalWhyAt', label: 'Goal/Why' },
  { key: 'stageUrgencyAt', label: 'Urgency' },
  { key: 'stageSoftPitchCommitmentAt', label: 'Soft Pitch' },
  { key: 'stageFinancialScreeningAt', label: 'Financial' },
  { key: 'stageBookingAt', label: 'Booking' }
] as const;

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(ms / 60000);
  return `${minutes}m`;
}

function formatOutcome(outcome: string): string {
  return outcome
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function SummaryTab({
  leadName,
  leadHandle,
  platform,
  status,
  aiActive,
  tags,
  messages,
  detail,
  createdAt
}: SummaryTabProps) {
  // Message stats
  const totalMessages = messages.length;
  const leadMessages = messages.filter(
    (m) => m.sender.toLowerCase() === 'lead'
  ).length;
  const aiMessages = messages.filter(
    (m) => m.sender.toLowerCase() === 'ai'
  ).length;
  const humanMessages = messages.filter(
    (m) => m.sender.toLowerCase() === 'human'
  ).length;

  // Duration
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  const duration =
    firstMsg && lastMsg
      ? new Date(lastMsg.timestamp).getTime() -
        new Date(firstMsg.timestamp).getTime()
      : 0;

  // Average sentiment
  const sentimentMessages = messages.filter((m) => m.sentimentScore != null);
  const avgSentiment =
    sentimentMessages.length > 0
      ? sentimentMessages.reduce((sum, m) => sum + (m.sentimentScore ?? 0), 0) /
        sentimentMessages.length
      : null;

  // Objections detected
  const objections = messages
    .filter((m) => m.objectionType)
    .map((m) => m.objectionType!);
  const uniqueObjections = Array.from(new Set(objections));

  // Stalls detected
  const stalls = messages.filter((m) => m.stallType).map((m) => m.stallType!);
  const uniqueStalls = Array.from(new Set(stalls));

  // Stage progression
  const reachedStages = detail
    ? STAGES.filter((s) => detail[s.key as keyof ConversationDetail] != null)
    : [];

  // Current stage from latest message
  const latestStageMsg = [...messages].reverse().find((m) => m.stage);

  return (
    <ScrollArea className='min-h-0 flex-1 overflow-hidden'>
      <div className='space-y-4 p-4'>
        {/* Lead Info Card */}
        <div className='rounded-lg border p-3'>
          <div className='flex items-center gap-2'>
            <div className='bg-primary/10 flex h-9 w-9 items-center justify-center rounded-full'>
              <span className='text-primary text-sm font-bold'>
                {leadName
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .substring(0, 2)}
              </span>
            </div>
            <div className='flex-1'>
              <p className='text-sm font-semibold'>{leadName}</p>
              <div className='flex items-center gap-1'>
                <PlatformIcon
                  platform={platform as 'instagram' | 'facebook'}
                  className='h-3 w-3'
                />
                <span className='text-muted-foreground text-xs'>
                  @{leadHandle}
                </span>
              </div>
            </div>
          </div>
          <div className='mt-2 flex flex-wrap gap-1.5'>
            <LeadStatusBadge status={status as LeadStatus} />
            {detail?.leadSource && (
              <Badge variant='outline' className='text-[10px]'>
                {detail.leadSource === 'INBOUND' ? 'Inbound' : 'Outbound'}
              </Badge>
            )}
            {detail?.leadIntentTag && detail.leadIntentTag !== 'NEUTRAL' && (
              <Badge
                variant='outline'
                className={cn(
                  'text-[10px]',
                  detail.leadIntentTag === 'HIGH_INTENT' &&
                    'border-green-300 text-green-600',
                  detail.leadIntentTag === 'RESISTANT' &&
                    'border-amber-300 text-amber-600',
                  detail.leadIntentTag === 'UNQUALIFIED' &&
                    'border-red-300 text-red-600'
                )}
              >
                {formatOutcome(detail.leadIntentTag)}
              </Badge>
            )}
          </div>
          {/* Deduped + capped — collapses HIGH_INTENT/high_intent variants
              and prefers the colored (signal) version over gray (noise). */}
          {(() => {
            const summaryTags = selectDisplayTags(tags, 8);
            const hidden = (tags?.length ?? 0) - summaryTags.length;
            if (summaryTags.length === 0) return null;
            return (
              <div className='mt-2 flex flex-wrap gap-1'>
                {summaryTags.map((tag) => (
                  <TagBadge key={tag.id} name={tag.name} color={tag.color} />
                ))}
                {hidden > 0 && (
                  <span className='text-muted-foreground self-center text-[10px]'>
                    +{hidden} more
                  </span>
                )}
              </div>
            );
          })()}
        </div>

        {/* Message Stats */}
        <div className='rounded-lg border p-3'>
          <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
            Conversation Stats
          </h5>
          <div className='grid grid-cols-2 gap-2'>
            <div className='bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-2'>
              <IconMessages className='text-muted-foreground h-3.5 w-3.5' />
              <div>
                <p className='text-sm font-semibold'>{totalMessages}</p>
                <p className='text-muted-foreground text-[10px]'>Messages</p>
              </div>
            </div>
            <div className='bg-muted/50 flex items-center gap-2 rounded-md px-2.5 py-2'>
              <IconClock className='text-muted-foreground h-3.5 w-3.5' />
              <div>
                <p className='text-sm font-semibold'>
                  {duration > 0 ? formatDuration(duration) : '--'}
                </p>
                <p className='text-muted-foreground text-[10px]'>Duration</p>
              </div>
            </div>
          </div>

          {/* Sender breakdown */}
          <div className='mt-2 space-y-1.5'>
            <div className='flex items-center justify-between text-xs'>
              <span className='text-muted-foreground flex items-center gap-1'>
                <IconUser className='h-3 w-3' /> Lead
              </span>
              <span className='font-medium'>{leadMessages}</span>
            </div>
            <div className='flex items-center justify-between text-xs'>
              <span className='flex items-center gap-1 text-blue-500'>
                <IconRobot className='h-3 w-3' /> AI Setter
              </span>
              <span className='font-medium'>{aiMessages}</span>
            </div>
            {humanMessages > 0 && (
              <div className='flex items-center justify-between text-xs'>
                <span className='flex items-center gap-1 text-emerald-500'>
                  <IconUserCheck className='h-3 w-3' /> Human
                </span>
                <span className='font-medium'>{humanMessages}</span>
              </div>
            )}
          </div>

          {/* Sentiment */}
          {avgSentiment !== null && (
            <div className='mt-2 flex items-center justify-between border-t pt-2 text-xs'>
              <span className='text-muted-foreground'>Avg. Sentiment</span>
              <span
                className={cn(
                  'font-semibold',
                  avgSentiment > 0.3
                    ? 'text-green-600'
                    : avgSentiment < -0.3
                      ? 'text-red-500'
                      : 'text-amber-500'
                )}
              >
                {avgSentiment > 0.3
                  ? 'Positive'
                  : avgSentiment < -0.3
                    ? 'Negative'
                    : 'Neutral'}{' '}
                ({(avgSentiment * 100).toFixed(0)}%)
              </span>
            </div>
          )}
        </div>

        {/* Stage Progression */}
        <div className='rounded-lg border p-3'>
          <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
            Stage Progression
          </h5>
          {latestStageMsg?.stage && (
            <div className='mb-2 flex items-center gap-1.5'>
              <IconTarget className='text-primary h-3.5 w-3.5' />
              <span className='text-xs font-medium'>
                Current: {formatOutcome(latestStageMsg.stage)}
              </span>
            </div>
          )}
          <div className='space-y-1'>
            {STAGES.map((stage, i) => {
              const reached = detail
                ? detail[stage.key as keyof ConversationDetail] != null
                : false;
              return (
                <div key={stage.key} className='flex items-center gap-2'>
                  <div
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold',
                      reached
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {reached ? <IconCheck className='h-3 w-3' /> : i + 1}
                  </div>
                  <span
                    className={cn(
                      'text-xs',
                      reached ? 'font-medium' : 'text-muted-foreground'
                    )}
                  >
                    {stage.label}
                  </span>
                  {i < STAGES.length - 1 && (
                    <IconArrowRight className='text-muted-foreground/40 ml-auto h-3 w-3' />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Outcome */}
        {detail?.outcome && detail.outcome !== 'ONGOING' && (
          <div className='rounded-lg border p-3'>
            <h5 className='text-muted-foreground mb-1 text-xs font-semibold tracking-wider uppercase'>
              Outcome
            </h5>
            <Badge
              variant='outline'
              className={cn(
                'text-xs',
                detail.outcome === 'BOOKED' &&
                  'border-green-300 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
                detail.outcome === 'LEFT_ON_READ' &&
                  'border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
                (detail.outcome === 'RESISTANT_EXIT' ||
                  detail.outcome === 'SOFT_EXIT' ||
                  detail.outcome === 'UNQUALIFIED_REDIRECT') &&
                  'border-red-300 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
              )}
            >
              {formatOutcome(detail.outcome)}
            </Badge>
          </div>
        )}

        {/* Objections & Stalls */}
        {(uniqueObjections.length > 0 || uniqueStalls.length > 0) && (
          <div className='rounded-lg border p-3'>
            <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
              Detected Events
            </h5>
            {uniqueObjections.length > 0 && (
              <div className='mb-1.5'>
                <span className='text-muted-foreground text-[10px]'>
                  Objections:
                </span>
                <div className='mt-0.5 flex flex-wrap gap-1'>
                  {uniqueObjections.map((obj) => (
                    <Badge
                      key={obj}
                      variant='outline'
                      className='border-amber-300 text-[10px] text-amber-600'
                    >
                      {formatOutcome(obj)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {uniqueStalls.length > 0 && (
              <div>
                <span className='text-muted-foreground text-[10px]'>
                  Stalls:
                </span>
                <div className='mt-0.5 flex flex-wrap gap-1'>
                  {uniqueStalls.map((stall) => (
                    <Badge
                      key={stall}
                      variant='outline'
                      className='border-orange-300 text-[10px] text-orange-600'
                    >
                      {formatOutcome(stall)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Lead Profile */}
        {detail?.lead &&
          (detail.lead.experience ||
            detail.lead.incomeLevel ||
            detail.lead.geography) && (
            <div className='rounded-lg border p-3'>
              <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
                Lead Profile
              </h5>
              <div className='space-y-1 text-xs'>
                {detail.lead.experience && (
                  <div className='flex justify-between'>
                    <span className='text-muted-foreground'>Experience</span>
                    <span className='font-medium capitalize'>
                      {detail.lead.experience}
                    </span>
                  </div>
                )}
                {detail.lead.incomeLevel && (
                  <div className='flex justify-between'>
                    <span className='text-muted-foreground'>Income Level</span>
                    <span className='font-medium capitalize'>
                      {detail.lead.incomeLevel}
                    </span>
                  </div>
                )}
                {detail.lead.geography && (
                  <div className='flex justify-between'>
                    <span className='text-muted-foreground'>Geography</span>
                    <span className='font-medium'>{detail.lead.geography}</span>
                  </div>
                )}
              </div>
            </div>
          )}

        {/* Timeline */}
        <div className='rounded-lg border p-3'>
          <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
            Timeline
          </h5>
          <div className='space-y-1 text-xs'>
            {createdAt && (
              <div className='flex justify-between'>
                <span className='text-muted-foreground flex items-center gap-1'>
                  <IconCalendar className='h-3 w-3' /> Started
                </span>
                <span className='font-medium'>
                  {new Date(createdAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            )}
            {lastMsg && (
              <div className='flex justify-between'>
                <span className='text-muted-foreground flex items-center gap-1'>
                  <IconClock className='h-3 w-3' /> Last Activity
                </span>
                <span className='font-medium'>
                  {new Date(lastMsg.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            )}
            {detail?.lead?.bookedAt && (
              <div className='flex justify-between'>
                <span className='flex items-center gap-1 text-green-600'>
                  <IconCheck className='h-3 w-3' /> Booked
                </span>
                <span className='font-medium text-green-600'>
                  {new Date(detail.lead.bookedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
