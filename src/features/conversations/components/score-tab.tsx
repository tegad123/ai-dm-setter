'use client';

import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import {
  IconFlame,
  IconTrendingUp,
  IconMessageCircle,
  IconMoodSmile,
  IconTarget,
  IconAlertTriangle,
  IconShieldCheck,
  IconClockHour4,
  IconArrowUpRight,
  IconArrowDownRight,
  IconMinus
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';

interface MessageData {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  stage?: string | null;
  sentimentScore?: number | null;
  objectionType?: string | null;
  stallType?: string | null;
  gotResponse?: boolean | null;
  responseTimeSeconds?: number | null;
}

interface ConversationDetail {
  outcome?: string;
  leadIntentTag?: string;
  priorityScore?: number;
  stageOpeningAt?: string | null;
  stageSituationDiscoveryAt?: string | null;
  stageGoalEmotionalWhyAt?: string | null;
  stageUrgencyAt?: string | null;
  stageSoftPitchCommitmentAt?: string | null;
  stageFinancialScreeningAt?: string | null;
  stageBookingAt?: string | null;
}

interface ScoreTabProps {
  qualityScore: number;
  priorityScore: number;
  status: string;
  messages: MessageData[];
  detail?: ConversationDetail | null;
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'text-red-500';
  if (score >= 60) return 'text-orange-500';
  if (score >= 40) return 'text-amber-500';
  if (score >= 20) return 'text-blue-400';
  return 'text-slate-400';
}

function getScoreRingColor(score: number): string {
  if (score >= 80) return 'stroke-red-500';
  if (score >= 60) return 'stroke-orange-500';
  if (score >= 40) return 'stroke-amber-500';
  if (score >= 20) return 'stroke-blue-400';
  return 'stroke-slate-300';
}

function getScoreLabel(score: number): string {
  if (score >= 80) return 'On Fire';
  if (score >= 60) return 'Hot';
  if (score >= 40) return 'Warm';
  if (score >= 20) return 'Cool';
  return 'Cold';
}

function getScoreBg(score: number): string {
  if (score >= 80)
    return 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800';
  if (score >= 60)
    return 'bg-orange-50 dark:bg-orange-950/30 border-orange-200 dark:border-orange-800';
  if (score >= 40)
    return 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800';
  if (score >= 20)
    return 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800';
  return 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-800';
}

function ScoreRing({ score, size = 120 }: { score: number; size?: number }) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;

  return (
    <div className='relative' style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className='-rotate-90'
        viewBox={`0 0 ${size} ${size}`}
      >
        {/* Background ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill='none'
          strokeWidth={strokeWidth}
          className='stroke-muted'
        />
        {/* Progress ring */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill='none'
          strokeWidth={strokeWidth}
          strokeLinecap='round'
          className={cn(
            'transition-all duration-700',
            getScoreRingColor(score)
          )}
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
        />
      </svg>
      <div className='absolute inset-0 flex flex-col items-center justify-center'>
        <span className={cn('text-2xl font-bold', getScoreColor(score))}>
          {score}
        </span>
        <span className='text-muted-foreground text-[10px]'>/ 100</span>
      </div>
    </div>
  );
}

function FactorBar({
  label,
  value,
  maxValue = 100,
  icon: Icon,
  color = 'bg-primary'
}: {
  label: string;
  value: number;
  maxValue?: number;
  icon: typeof IconFlame;
  color?: string;
}) {
  const pct = Math.min(100, (value / maxValue) * 100);
  return (
    <div className='space-y-1'>
      <div className='flex items-center justify-between'>
        <span className='text-muted-foreground flex items-center gap-1.5 text-xs'>
          <Icon className='h-3 w-3' />
          {label}
        </span>
        <span className='text-xs font-semibold'>{Math.round(pct)}%</span>
      </div>
      <div className='bg-muted h-1.5 w-full overflow-hidden rounded-full'>
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            color
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ScoreTab({
  qualityScore,
  priorityScore,
  status,
  messages,
  detail
}: ScoreTabProps) {
  const conversationMessages = messages.filter(
    (m) => m.sender.toLowerCase() !== 'system'
  );
  // Compute engagement metrics
  const totalMessages = conversationMessages.length;
  const leadMessages = conversationMessages.filter(
    (m) => m.sender.toLowerCase() === 'lead'
  );
  const aiMessages = conversationMessages.filter(
    (m) => m.sender.toLowerCase() === 'ai'
  );

  // Response rate: how often lead responds to AI messages
  const aiMsgsWithResponse = aiMessages.filter((m) => m.gotResponse != null);
  const responseRate =
    aiMsgsWithResponse.length > 0
      ? (aiMsgsWithResponse.filter((m) => m.gotResponse).length /
          aiMsgsWithResponse.length) *
        100
      : leadMessages.length > 0 && aiMessages.length > 0
        ? Math.min(
            100,
            (leadMessages.length / Math.max(1, aiMessages.length)) * 100
          )
        : 0;

  // Average response time
  const responseTimes = conversationMessages
    .filter((m) => m.responseTimeSeconds != null && m.responseTimeSeconds > 0)
    .map((m) => m.responseTimeSeconds!);
  const avgResponseTime =
    responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : null;

  // Average sentiment
  const sentimentMsgs = conversationMessages.filter(
    (m) => m.sentimentScore != null
  );
  const avgSentiment =
    sentimentMsgs.length > 0
      ? sentimentMsgs.reduce((sum, m) => sum + (m.sentimentScore ?? 0), 0) /
        sentimentMsgs.length
      : 0;
  // Normalize to 0-100 (from -1 to 1)
  const sentimentPct = ((avgSentiment + 1) / 2) * 100;

  // Stage progress (how far through the 7 stages)
  const stageKeys = [
    'stageOpeningAt',
    'stageSituationDiscoveryAt',
    'stageGoalEmotionalWhyAt',
    'stageUrgencyAt',
    'stageSoftPitchCommitmentAt',
    'stageFinancialScreeningAt',
    'stageBookingAt'
  ] as const;
  const stagesReached = detail
    ? stageKeys.filter((k) => detail[k as keyof ConversationDetail] != null)
        .length
    : 0;
  const stageProgress = (stagesReached / 7) * 100;

  // Objection count (risk factor)
  const objectionCount = conversationMessages.filter(
    (m) => m.objectionType
  ).length;
  const stallCount = conversationMessages.filter((m) => m.stallType).length;

  // Risk level
  const riskFactors: string[] = [];
  if (objectionCount >= 3) riskFactors.push('Multiple objections');
  if (stallCount >= 2) riskFactors.push('Stalling behavior');
  if (responseRate < 30 && totalMessages > 3)
    riskFactors.push('Low engagement');
  if (avgSentiment < -0.3) riskFactors.push('Negative sentiment');
  if (
    detail?.outcome === 'LEFT_ON_READ' ||
    detail?.outcome === 'RESISTANT_EXIT'
  )
    riskFactors.push('Conversation ended');

  // Positive signals
  const positiveSignals: string[] = [];
  if (responseRate >= 70) positiveSignals.push('High engagement');
  if (avgSentiment > 0.3) positiveSignals.push('Positive sentiment');
  if (stagesReached >= 5) positiveSignals.push('Deep in funnel');
  if (detail?.outcome === 'BOOKED') positiveSignals.push('Call booked');
  if (detail?.leadIntentTag === 'HIGH_INTENT')
    positiveSignals.push('High intent');

  // Overall temperature uses qualityScore, fallback to computed
  const temperature = qualityScore || priorityScore || 0;

  return (
    <ScrollArea className='min-h-0 flex-1 overflow-hidden'>
      <div className='space-y-4 p-4'>
        {/* Main Score Gauge */}
        <div
          className={cn(
            'flex flex-col items-center rounded-lg border p-4',
            getScoreBg(temperature)
          )}
        >
          <div className='mb-1 flex items-center gap-1.5'>
            <IconFlame className={cn('h-4 w-4', getScoreColor(temperature))} />
            <h5 className='text-xs font-semibold tracking-wider uppercase'>
              Lead Temperature
            </h5>
          </div>
          <ScoreRing score={temperature} />
          <Badge
            variant='outline'
            className={cn('mt-2 text-xs font-bold', getScoreColor(temperature))}
          >
            {getScoreLabel(temperature)}
          </Badge>
        </div>

        {/* Score Breakdown */}
        <div className='rounded-lg border p-3'>
          <h5 className='text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase'>
            Score Breakdown
          </h5>
          <div className='space-y-3'>
            <FactorBar
              label='Engagement'
              value={responseRate}
              icon={IconMessageCircle}
              color={
                responseRate >= 60
                  ? 'bg-green-500'
                  : responseRate >= 30
                    ? 'bg-amber-500'
                    : 'bg-red-400'
              }
            />
            <FactorBar
              label='Sentiment'
              value={sentimentPct}
              icon={IconMoodSmile}
              color={
                sentimentPct >= 65
                  ? 'bg-green-500'
                  : sentimentPct >= 40
                    ? 'bg-amber-500'
                    : 'bg-red-400'
              }
            />
            <FactorBar
              label='Funnel Progress'
              value={stageProgress}
              icon={IconTarget}
              color={
                stageProgress >= 60
                  ? 'bg-green-500'
                  : stageProgress >= 30
                    ? 'bg-amber-500'
                    : 'bg-blue-400'
              }
            />
            <FactorBar
              label='Priority'
              value={priorityScore}
              icon={IconTrendingUp}
              color={
                priorityScore >= 60
                  ? 'bg-green-500'
                  : priorityScore >= 30
                    ? 'bg-amber-500'
                    : 'bg-blue-400'
              }
            />
          </div>
        </div>

        {/* Response Time */}
        {avgResponseTime !== null && (
          <div className='rounded-lg border p-3'>
            <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
              Responsiveness
            </h5>
            <div className='flex items-center gap-2'>
              <IconClockHour4 className='text-muted-foreground h-4 w-4' />
              <div>
                <p className='text-sm font-semibold'>
                  {avgResponseTime < 60
                    ? `${Math.round(avgResponseTime)}s`
                    : avgResponseTime < 3600
                      ? `${Math.round(avgResponseTime / 60)}m`
                      : `${Math.round(avgResponseTime / 3600)}h`}
                </p>
                <p className='text-muted-foreground text-[10px]'>
                  Avg. lead response time
                </p>
              </div>
              {avgResponseTime < 300 ? (
                <IconArrowUpRight className='ml-auto h-4 w-4 text-green-500' />
              ) : avgResponseTime < 3600 ? (
                <IconMinus className='ml-auto h-4 w-4 text-amber-500' />
              ) : (
                <IconArrowDownRight className='ml-auto h-4 w-4 text-red-400' />
              )}
            </div>
          </div>
        )}

        {/* Positive Signals */}
        {positiveSignals.length > 0 && (
          <div className='rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/20'>
            <h5 className='mb-1.5 flex items-center gap-1 text-xs font-semibold text-green-700 dark:text-green-400'>
              <IconShieldCheck className='h-3.5 w-3.5' />
              Positive Signals
            </h5>
            <div className='flex flex-wrap gap-1'>
              {positiveSignals.map((signal) => (
                <Badge
                  key={signal}
                  variant='outline'
                  className='border-green-300 text-[10px] text-green-700 dark:border-green-700 dark:text-green-400'
                >
                  {signal}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Risk Factors */}
        {riskFactors.length > 0 && (
          <div className='rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/20'>
            <h5 className='mb-1.5 flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-400'>
              <IconAlertTriangle className='h-3.5 w-3.5' />
              Risk Factors
            </h5>
            <div className='flex flex-wrap gap-1'>
              {riskFactors.map((risk) => (
                <Badge
                  key={risk}
                  variant='outline'
                  className='border-red-300 text-[10px] text-red-700 dark:border-red-700 dark:text-red-400'
                >
                  {risk}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Quick Stats */}
        <div className='rounded-lg border p-3'>
          <h5 className='text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase'>
            Quick Stats
          </h5>
          <div className='space-y-1.5 text-xs'>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>Total Messages</span>
              <span className='font-medium'>{totalMessages}</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>Lead Messages</span>
              <span className='font-medium'>{leadMessages.length}</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>Response Rate</span>
              <span className='font-medium'>{Math.round(responseRate)}%</span>
            </div>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>Stages Reached</span>
              <span className='font-medium'>{stagesReached} / 7</span>
            </div>
            {objectionCount > 0 && (
              <div className='flex justify-between'>
                <span className='text-muted-foreground'>Objections</span>
                <span className='font-medium text-amber-500'>
                  {objectionCount}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
