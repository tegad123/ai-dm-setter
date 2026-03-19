'use client';

import { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';
import { apiFetch } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DataQuality {
  totalConversations: number;
  messagesWithStageData: number;
  messagesWithSentiment: number;
  coveragePercent: number;
  coldStartThresholds: {
    minConversations: { required: number; actual: number; met: boolean };
    minMessages: { required: number; actual: number; met: boolean };
    minStageTransitions: { required: number; actual: number; met: boolean };
  };
}

interface FunnelStage {
  stage: string;
  count: number;
  dropOffPercent: number;
}

interface ConversationFunnel {
  stages: FunnelStage[];
  outcomes: {
    label: string;
    count: number;
    color: string;
  }[];
}

interface StageEffectiveness {
  stage: string;
  sent: number;
  responseRate: number;
  avgResponseTime: string;
  continuedRate: number;
  avgSentiment: number;
}

interface MessageEffectiveness {
  stages: StageEffectiveness[];
  coldStart: {
    hasEnoughData: boolean;
    message: string;
  };
}

interface DropOffStage {
  stage: string;
  dropOffPercent: number;
  count: number;
}

interface DropOffMessage {
  preview: string;
  stage: string;
  count: number;
}

interface DropOffHotspots {
  byStage: DropOffStage[];
  topMessages: DropOffMessage[];
}

// ---------------------------------------------------------------------------
// Data-fetching hooks
// ---------------------------------------------------------------------------

function useDataQuality() {
  const [data, setData] = useState<DataQuality | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<any>('/analytics/data-quality')
      .then((res) => {
        if (!cancelled) {
          const mq = res.messageQuality || {};
          const total = mq.total || 1;
          const withStage = mq.withStage || 0;
          const withSentiment = mq.withSentiment || 0;
          const coveragePercent = (withStage / total) * 100;
          const cs = res.coldStartStatus || {};
          setData({
            totalConversations: res.totalConversations || 0,
            messagesWithStageData: withStage,
            messagesWithSentiment: withSentiment,
            coveragePercent,
            coldStartThresholds: {
              minConversations: {
                required: cs.FUNNEL_ANALYSIS?.minimumRequired || 50,
                actual: cs.FUNNEL_ANALYSIS?.totalResolved || 0,
                met: cs.FUNNEL_ANALYSIS?.hasEnoughData || false
              },
              minMessages: {
                required: cs.MESSAGE_EFFECTIVENESS?.minimumRequired || 30,
                actual: cs.MESSAGE_EFFECTIVENESS?.totalResolved || 0,
                met: cs.MESSAGE_EFFECTIVENESS?.hasEnoughData || false
              },
              minStageTransitions: {
                required: cs.SEGMENT_ANALYSIS?.minimumRequired || 20,
                actual: cs.SEGMENT_ANALYSIS?.totalResolved || 0,
                met: cs.SEGMENT_ANALYSIS?.hasEnoughData || false
              }
            }
          });
        }
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(`Data quality fetch failed: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

function useConversationFunnel() {
  const [data, setData] = useState<ConversationFunnel | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<any>('/analytics/conversation-funnel')
      .then((res) => {
        if (!cancelled) {
          const total = res.total || 1;
          const stages = (res.stages || []).map((s: any) => ({
            stage: s.stage,
            count: s.reached || 0,
            dropOffPercent: total > 0 ? ((s.dropOff || 0) / total) * 100 : 0
          }));
          const outcomeColors: Record<string, string> = {
            ONGOING: '#3b82f6',
            BOOKED: '#22c55e',
            LEFT_ON_READ: '#ef4444',
            UNQUALIFIED_REDIRECT: '#f97316',
            RESISTANT_EXIT: '#dc2626',
            SOFT_OBJECTION: '#eab308',
            PRICE_QUESTION_DEFLECTED: '#a855f7'
          };
          const outcomes = Object.entries(res.outcomes || {}).map(
            ([label, count]) => ({
              label,
              count: count as number,
              color: outcomeColors[label] || '#6b7280'
            })
          );
          setData({ stages, outcomes });
        }
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(`Conversation funnel fetch failed: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

function useMessageEffectiveness() {
  const [data, setData] = useState<MessageEffectiveness | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<any>('/analytics/message-effectiveness')
      .then((res) => {
        if (!cancelled) {
          const stages = (res.stages || []).map((s: any) => ({
            stage: s.stage || 'unknown',
            sent: s.totalSent || 0,
            responseRate: s.responseRate || 0,
            avgResponseTime: s.avgResponseTime
              ? `${Math.round(s.avgResponseTime)}s`
              : 'N/A',
            continuedRate: s.continuedRate || 0,
            avgSentiment: s.avgSentiment || 0
          }));
          setData({
            stages,
            coldStart: {
              hasEnoughData: res.coldStart?.hasEnoughData || false,
              message: res.coldStart?.hasEnoughData
                ? ''
                : `Need ${res.coldStart?.minimumRequired || 30} resolved conversations (have ${(res.coldStart?.liveCount || 0) + (res.coldStart?.seedCount || 0)})`
            }
          });
        }
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(`Message effectiveness fetch failed: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

function useDropOffHotspots() {
  const [data, setData] = useState<DropOffHotspots | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch<any>('/analytics/drop-off-hotspots')
      .then((res) => {
        if (!cancelled) {
          setData({
            byStage: (res.byStage || []).map((s: any) => ({
              stage: s.stage || 'unknown',
              dropOffPercent: s.percentage || 0,
              count: s.count || 0
            })),
            topMessages: (res.topDropOffMessages || []).map((m: any) => ({
              preview: m.preview || '',
              stage: m.stage || 'unknown',
              count: m.count || 0
            }))
          });
        }
      })
      .catch((err) => {
        if (!cancelled)
          toast.error(`Drop-off hotspots fetch failed: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coverageColor(pct: number): string {
  if (pct > 80) return 'bg-green-500';
  if (pct >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}

function coverageTextColor(pct: number): string {
  if (pct > 80) return 'text-green-600';
  if (pct >= 50) return 'text-yellow-600';
  return 'text-red-600';
}

function responseRateColor(rate: number): string {
  if (rate > 60) return 'text-green-600';
  if (rate >= 40) return 'text-yellow-600';
  return 'text-red-600';
}

/** Green at top of funnel fading to red at bottom */
function funnelBarColor(index: number, total: number): string {
  if (total <= 1) return '#22c55e';
  const ratio = index / (total - 1);
  const hue = Math.round(120 * (1 - ratio));
  return `hsl(${hue}, 72%, 50%)`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamPerformanceView() {
  const { data: quality, loading: qualityLoading } = useDataQuality();
  const { data: funnel, loading: funnelLoading } = useConversationFunnel();
  const { data: effectiveness, loading: effectivenessLoading } =
    useMessageEffectiveness();
  const { data: hotspots, loading: hotspotsLoading } = useDropOffHotspots();

  return (
    <div className='space-y-6'>
      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Data Quality Monitor */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader className='pb-3'>
          <CardTitle className='text-base'>Data Quality Monitor</CardTitle>
          <CardDescription>
            Coverage of stage and sentiment data across conversations
          </CardDescription>
        </CardHeader>
        <CardContent>
          {qualityLoading ? (
            <Skeleton className='h-24 w-full' />
          ) : quality ? (
            <div className='space-y-4'>
              {/* Coverage bar */}
              <div className='space-y-1'>
                <div className='flex items-center justify-between text-sm'>
                  <span className='font-medium'>Data Coverage</span>
                  <span
                    className={`font-semibold ${coverageTextColor(quality.coveragePercent)}`}
                  >
                    {quality.coveragePercent.toFixed(1)}%
                  </span>
                </div>
                <div className='bg-muted h-3 overflow-hidden rounded-full'>
                  <div
                    className={`h-full rounded-full transition-all ${coverageColor(quality.coveragePercent)}`}
                    style={{
                      width: `${Math.min(quality.coveragePercent, 100)}%`
                    }}
                  />
                </div>
              </div>

              {/* Counts */}
              <div className='grid grid-cols-3 gap-4 text-center text-sm'>
                <div>
                  <p className='text-muted-foreground'>Total Conversations</p>
                  <p className='text-lg font-semibold'>
                    {quality.totalConversations}
                  </p>
                </div>
                <div>
                  <p className='text-muted-foreground'>With Stage Data</p>
                  <p className='text-lg font-semibold'>
                    {quality.messagesWithStageData}
                  </p>
                </div>
                <div>
                  <p className='text-muted-foreground'>With Sentiment</p>
                  <p className='text-lg font-semibold'>
                    {quality.messagesWithSentiment}
                  </p>
                </div>
              </div>

              <Separator />

              {/* Cold start thresholds */}
              <div className='space-y-2'>
                <p className='text-muted-foreground text-sm font-medium'>
                  Cold Start Thresholds
                </p>
                <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                  {Object.entries(quality.coldStartThresholds).map(
                    ([key, threshold]) => (
                      <div
                        key={key}
                        className='flex items-center gap-2 text-sm'
                      >
                        <span
                          className={
                            threshold.met ? 'text-green-600' : 'text-red-500'
                          }
                        >
                          {threshold.met ? '\u2713' : '\u2717'}
                        </span>
                        <span className='capitalize'>
                          {key.replace(/([A-Z])/g, ' $1').trim()}
                        </span>
                        <span className='text-muted-foreground'>
                          ({threshold.actual}/{threshold.required})
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className='text-muted-foreground text-sm'>
              No data quality information available.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Sections 2 & 3: Funnel + Effectiveness side by side */}
      {/* ------------------------------------------------------------------ */}
      <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
        {/* Section 2: Conversation Funnel */}
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Conversation Funnel</CardTitle>
            <CardDescription>
              Stage progression with drop-off rates
            </CardDescription>
          </CardHeader>
          <CardContent>
            {funnelLoading ? (
              <Skeleton className='h-[320px] w-full' />
            ) : funnel && funnel.stages.length > 0 ? (
              <div className='space-y-4'>
                <ResponsiveContainer width='100%' height={280}>
                  <BarChart
                    data={funnel.stages}
                    layout='vertical'
                    margin={{ left: 10, right: 40 }}
                  >
                    <CartesianGrid horizontal={false} strokeDasharray='3 3' />
                    <XAxis type='number' fontSize={12} />
                    <YAxis
                      dataKey='stage'
                      type='category'
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      width={100}
                    />
                    <Tooltip
                      formatter={(value: number, _name: string, props: any) => [
                        `${value} (${props.payload.dropOffPercent.toFixed(1)}% drop-off)`,
                        'Count'
                      ]}
                    />
                    <Bar dataKey='count' radius={[0, 4, 4, 0]}>
                      {funnel.stages.map((_, idx) => (
                        <Cell
                          key={idx}
                          fill={funnelBarColor(idx, funnel.stages.length)}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>

                {/* Outcome badges */}
                {funnel.outcomes && funnel.outcomes.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <p className='text-muted-foreground mb-2 text-sm font-medium'>
                        Outcome Breakdown
                      </p>
                      <div className='flex flex-wrap gap-2'>
                        {funnel.outcomes.map((o) => (
                          <Badge
                            key={o.label}
                            variant='outline'
                            style={{
                              borderColor: o.color,
                              color: o.color
                            }}
                          >
                            {o.label}: {o.count}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className='text-muted-foreground text-sm'>
                No funnel data available yet.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Section 3: Message Effectiveness */}
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Message Effectiveness</CardTitle>
            <CardDescription>
              Per-stage response and continuation metrics
            </CardDescription>
          </CardHeader>
          <CardContent>
            {effectivenessLoading ? (
              <Skeleton className='h-[320px] w-full' />
            ) : effectiveness ? (
              <div className='space-y-4'>
                {/* Cold start warning */}
                {!effectiveness.coldStart.hasEnoughData && (
                  <div className='rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-200'>
                    {effectiveness.coldStart.message ||
                      'Not enough data for reliable metrics. Results may be inaccurate.'}
                  </div>
                )}

                <div className='overflow-x-auto'>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Stage</TableHead>
                        <TableHead className='text-right'>Sent</TableHead>
                        <TableHead className='text-right'>
                          Response Rate
                        </TableHead>
                        <TableHead className='text-right'>
                          Avg Response
                        </TableHead>
                        <TableHead className='text-right'>Continued</TableHead>
                        <TableHead className='text-right'>Sentiment</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {effectiveness.stages.map((s) => (
                        <TableRow key={s.stage}>
                          <TableCell className='font-medium'>
                            {s.stage}
                          </TableCell>
                          <TableCell className='text-right'>{s.sent}</TableCell>
                          <TableCell
                            className={`text-right font-medium ${responseRateColor(s.responseRate)}`}
                          >
                            {s.responseRate.toFixed(1)}%
                          </TableCell>
                          <TableCell className='text-muted-foreground text-right'>
                            {s.avgResponseTime}
                          </TableCell>
                          <TableCell className='text-right'>
                            {s.continuedRate.toFixed(1)}%
                          </TableCell>
                          <TableCell className='text-right'>
                            {s.avgSentiment.toFixed(2)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : (
              <p className='text-muted-foreground text-sm'>
                No effectiveness data available yet.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Section 4: Drop-off Hotspots */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Drop-off Hotspots</CardTitle>
          <CardDescription>
            Where conversations stall or end prematurely
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hotspotsLoading ? (
            <Skeleton className='h-48 w-full' />
          ) : hotspots ? (
            <div className='grid grid-cols-1 gap-6 lg:grid-cols-2'>
              {/* Drop-offs by Stage */}
              <div className='space-y-3'>
                <p className='text-sm font-semibold'>Drop-offs by Stage</p>
                {hotspots.byStage.length > 0 ? (
                  hotspots.byStage.map((s) => (
                    <div key={s.stage} className='space-y-1'>
                      <div className='flex items-center justify-between text-sm'>
                        <span>{s.stage}</span>
                        <span className='text-muted-foreground'>
                          {s.dropOffPercent.toFixed(1)}% ({s.count})
                        </span>
                      </div>
                      <Progress
                        value={Math.min(s.dropOffPercent, 100)}
                        className='h-2'
                      />
                    </div>
                  ))
                ) : (
                  <p className='text-muted-foreground text-sm'>
                    No drop-off data available.
                  </p>
                )}
              </div>

              {/* Top Drop-off Messages */}
              <div className='space-y-3'>
                <p className='text-sm font-semibold'>Top Drop-off Messages</p>
                {hotspots.topMessages.length > 0 ? (
                  <div className='space-y-2'>
                    {hotspots.topMessages.map((m, idx) => (
                      <div key={idx} className='rounded-md border p-3 text-sm'>
                        <div className='mb-1 flex items-center gap-2'>
                          <Badge variant='secondary'>{m.stage}</Badge>
                          <span className='text-muted-foreground'>
                            {m.count} drop-offs
                          </span>
                        </div>
                        <p className='text-muted-foreground line-clamp-2'>
                          {m.preview}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className='text-muted-foreground text-sm'>
                    No drop-off message data available.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className='text-muted-foreground text-sm'>
              No hotspot data available yet.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
