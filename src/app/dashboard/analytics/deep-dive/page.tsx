'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { IconLoader2 } from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SegmentValue {
  value: string;
  totalLeads: number;
  bookingRate: number;
  showRate: number;
  closeRate: number;
  avgRevenue: number;
}

interface SegmentAnalysis {
  title: string;
  key: string;
  values: SegmentValue[];
}

interface SegmentsResponse {
  segments: SegmentAnalysis[];
  coldStart: {
    hasEnoughData: boolean;
    currentSample: number;
    requiredSample: number;
  };
}

interface VelocityStage {
  stage: string;
  avgTimeBooked: number; // seconds
  avgTimeGhosted: number; // seconds
  velocityRatio: number;
  samples: number;
}

interface VelocityResponse {
  stages: VelocityStage[];
  coldStart: {
    hasEnoughData: boolean;
    currentSample: number;
    requiredSample: number;
  };
}

interface EffectivenessStage {
  stage: string;
  effectivenessScore: number;
  responseRate: number;
  continuedRate: number;
  stageAdvancement: number;
  bookingRate: number;
  sampleSize: number;
}

interface EffectivenessResponse {
  stages: EffectivenessStage[];
  coldStart: {
    hasEnoughData: boolean;
    currentSample: number;
    requiredSample: number;
  };
}

interface SequenceStep {
  stage: string;
}

interface ConversationSequence {
  steps: SequenceStep[];
  outcome: string;
  count: number;
  bookingRate: number;
}

interface SequencesResponse {
  sequences: ConversationSequence[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)}min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}hrs`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function currency(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function velocityColor(ratio: number): string {
  if (ratio < 0.8) return 'text-green-600 dark:text-green-400';
  if (ratio <= 1.2) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function velocityIcon(ratio: number): string {
  return ratio < 0.8 ? '\u26A1' : '\uD83D\uDC22';
}

function scoreColor(score: number): string {
  if (score > 0.6) return 'text-green-600 dark:text-green-400';
  if (score >= 0.4) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function scoreBadgeVariant(
  score: number
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (score > 0.6) return 'default';
  if (score >= 0.4) return 'secondary';
  return 'destructive';
}

// ---------------------------------------------------------------------------
// Cold-start warning
// ---------------------------------------------------------------------------

function ColdStartBanner({
  current,
  required
}: {
  current: number;
  required: number;
}) {
  return (
    <div className='mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-800 dark:bg-yellow-950/30'>
      <p className='text-sm font-medium text-yellow-800 dark:text-yellow-300'>
        Insufficient data for reliable analysis
      </p>
      <p className='text-muted-foreground mt-1 text-xs'>
        {current} / {required} samples collected. Results will become more
        accurate as more conversations are processed.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading spinner
// ---------------------------------------------------------------------------

function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className='flex flex-col items-center justify-center py-16'>
      <IconLoader2 className='text-muted-foreground h-8 w-8 animate-spin' />
      <p className='text-muted-foreground mt-3 text-sm'>{label}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segments Tab
// ---------------------------------------------------------------------------

function SegmentsTab() {
  const [data, setData] = useState<SegmentsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const res = await apiFetch<SegmentsResponse>('/analytics/segments');
      setData(res);
    } catch {
      toast.error('Failed to load segment analysis');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  if (loading) return <LoadingSpinner label='Loading segment analysis...' />;
  if (!data) return null;

  if (!data.coldStart.hasEnoughData) {
    return (
      <ColdStartBanner
        current={data.coldStart.currentSample}
        required={data.coldStart.requiredSample}
      />
    );
  }

  return (
    <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
      {data.segments.map((segment) => {
        const bestIdx = segment.values.reduce(
          (best, v, i, arr) =>
            v.bookingRate > (arr[best]?.bookingRate ?? 0) ? i : best,
          0
        );

        return (
          <Card key={segment.key}>
            <CardHeader className='pb-3'>
              <CardTitle className='text-base'>{segment.title}</CardTitle>
              <CardDescription>
                {segment.values.length} segment
                {segment.values.length !== 1 ? 's' : ''} analysed
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead>
                    <tr className='text-muted-foreground border-b text-left text-xs'>
                      <th className='pr-3 pb-2 font-medium'>Segment</th>
                      <th className='pr-3 pb-2 text-right font-medium'>
                        Leads
                      </th>
                      <th className='pr-3 pb-2 text-right font-medium'>
                        Book %
                      </th>
                      <th className='pr-3 pb-2 text-right font-medium'>
                        Show %
                      </th>
                      <th className='pr-3 pb-2 text-right font-medium'>
                        Close %
                      </th>
                      <th className='pb-2 text-right font-medium'>Avg Rev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {segment.values.map((v, i) => {
                      const isBest = i === bestIdx;
                      const rowClass = isBest
                        ? 'text-green-700 dark:text-green-400 font-medium'
                        : '';
                      return (
                        <tr key={v.value} className='border-b last:border-0'>
                          <td className={`py-2 pr-3 ${rowClass}`}>
                            {v.value}
                            {isBest && (
                              <Badge
                                variant='outline'
                                className='ml-2 border-green-300 text-[10px] text-green-700 dark:border-green-700 dark:text-green-400'
                              >
                                Best
                              </Badge>
                            )}
                          </td>
                          <td className={`py-2 pr-3 text-right ${rowClass}`}>
                            {v.totalLeads}
                          </td>
                          <td className={`py-2 pr-3 text-right ${rowClass}`}>
                            {pct(v.bookingRate)}
                          </td>
                          <td className={`py-2 pr-3 text-right ${rowClass}`}>
                            {pct(v.showRate)}
                          </td>
                          <td className={`py-2 pr-3 text-right ${rowClass}`}>
                            {pct(v.closeRate)}
                          </td>
                          <td className={`py-2 text-right ${rowClass}`}>
                            {currency(v.avgRevenue)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Velocity Tab
// ---------------------------------------------------------------------------

function VelocityTab() {
  const [data, setData] = useState<VelocityResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const res = await apiFetch<VelocityResponse>('/analytics/velocity');
      setData(res);
    } catch {
      toast.error('Failed to load velocity analysis');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  if (loading) return <LoadingSpinner label='Loading velocity analysis...' />;
  if (!data) return null;

  if (!data.coldStart.hasEnoughData) {
    return (
      <ColdStartBanner
        current={data.coldStart.currentSample}
        required={data.coldStart.requiredSample}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Stage Velocity Analysis</CardTitle>
        <CardDescription>
          Compare how quickly leads progress through each stage for booked vs
          ghosted outcomes
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-muted-foreground border-b text-left text-xs'>
                <th className='pr-4 pb-2 font-medium'>Stage</th>
                <th className='pr-4 pb-2 text-right font-medium'>
                  Avg Time (Booked)
                </th>
                <th className='pr-4 pb-2 text-right font-medium'>
                  Avg Time (Ghosted)
                </th>
                <th className='pr-4 pb-2 text-right font-medium'>
                  Velocity Ratio
                </th>
                <th className='pb-2 text-right font-medium'>Samples</th>
              </tr>
            </thead>
            <tbody>
              {data.stages.map((s) => (
                <tr key={s.stage} className='border-b last:border-0'>
                  <td className='py-2.5 pr-4 font-medium'>{s.stage}</td>
                  <td className='py-2.5 pr-4 text-right'>
                    {formatDuration(s.avgTimeBooked)}
                  </td>
                  <td className='py-2.5 pr-4 text-right'>
                    {formatDuration(s.avgTimeGhosted)}
                  </td>
                  <td
                    className={`py-2.5 pr-4 text-right font-semibold ${velocityColor(s.velocityRatio)}`}
                  >
                    <span className='mr-1'>
                      {velocityIcon(s.velocityRatio)}
                    </span>
                    {s.velocityRatio.toFixed(2)}
                  </td>
                  <td className='text-muted-foreground py-2.5 text-right'>
                    {s.samples}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Separator className='my-4' />

        <div className='text-muted-foreground flex flex-wrap gap-6 text-xs'>
          <span>
            <span className='mr-1 inline-block h-2 w-2 rounded-full bg-green-500' />
            {'< 0.8 — Faster leads book'}
          </span>
          <span>
            <span className='mr-1 inline-block h-2 w-2 rounded-full bg-yellow-500' />
            {'0.8–1.2 — Similar pace'}
          </span>
          <span>
            <span className='mr-1 inline-block h-2 w-2 rounded-full bg-red-500' />
            {'> 1.2 — Slower leads book'}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Effectiveness Tab
// ---------------------------------------------------------------------------

const INTENT_TAGS = [
  { value: 'ALL', label: 'All Intents' },
  { value: 'HIGH_INTENT', label: 'High Intent' },
  { value: 'RESISTANT', label: 'Resistant' },
  { value: 'NEUTRAL', label: 'Neutral' },
  { value: 'UNQUALIFIED', label: 'Unqualified' }
] as const;

function EffectivenessTab() {
  const [data, setData] = useState<EffectivenessResponse | null>(null);
  const [sequences, setSequences] = useState<SequencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [seqLoading, setSeqLoading] = useState(true);
  const [intentFilter, setIntentFilter] = useState<string>('ALL');

  const fetchEffectiveness = useCallback(async () => {
    try {
      const query = intentFilter !== 'ALL' ? `?intent=${intentFilter}` : '';
      const res = await apiFetch<EffectivenessResponse>(
        `/analytics/effectiveness${query}`
      );
      setData(res);
    } catch {
      toast.error('Failed to load effectiveness data');
    } finally {
      setLoading(false);
    }
  }, [intentFilter]);

  const fetchSequences = useCallback(async () => {
    try {
      const res = await apiFetch<SequencesResponse>('/analytics/sequences');
      setSequences(res);
    } catch {
      toast.error('Failed to load conversation sequences');
    } finally {
      setSeqLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchEffectiveness();
  }, [fetchEffectiveness]);

  useEffect(() => {
    fetchSequences();
  }, [fetchSequences]);

  const sortedStages = data
    ? [...data.stages].sort(
        (a, b) => b.effectivenessScore - a.effectivenessScore
      )
    : [];

  return (
    <div className='space-y-6'>
      {/* Filter */}
      <div className='flex items-center gap-3'>
        <span className='text-sm font-medium'>Intent Filter:</span>
        <Select value={intentFilter} onValueChange={setIntentFilter}>
          <SelectTrigger className='w-[200px]'>
            <SelectValue placeholder='Select intent' />
          </SelectTrigger>
          <SelectContent>
            {INTENT_TAGS.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Effectiveness table */}
      {loading ? (
        <LoadingSpinner label='Loading effectiveness data...' />
      ) : !data ? null : (
        <>
          {!data.coldStart.hasEnoughData && (
            <ColdStartBanner
              current={data.coldStart.currentSample}
              required={data.coldStart.requiredSample}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle>Stage Effectiveness Scores</CardTitle>
              <CardDescription>
                How well each conversation stage converts leads, sorted by
                overall effectiveness
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead>
                    <tr className='text-muted-foreground border-b text-left text-xs'>
                      <th className='pr-4 pb-2 font-medium'>Stage</th>
                      <th className='pr-4 pb-2 text-right font-medium'>
                        Score
                      </th>
                      <th className='pr-4 pb-2 text-right font-medium'>
                        Response %
                      </th>
                      <th className='pr-4 pb-2 text-right font-medium'>
                        Continued %
                      </th>
                      <th className='pr-4 pb-2 text-right font-medium'>
                        Advancement %
                      </th>
                      <th className='pr-4 pb-2 text-right font-medium'>
                        Booking %
                      </th>
                      <th className='pb-2 text-right font-medium'>Samples</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStages.map((s) => (
                      <tr key={s.stage} className='border-b last:border-0'>
                        <td className='py-2.5 pr-4 font-medium'>{s.stage}</td>
                        <td className='py-2.5 pr-4 text-right'>
                          <Badge
                            variant={scoreBadgeVariant(s.effectivenessScore)}
                          >
                            <span className={scoreColor(s.effectivenessScore)}>
                              {s.effectivenessScore.toFixed(2)}
                            </span>
                          </Badge>
                        </td>
                        <td className='py-2.5 pr-4 text-right'>
                          {pct(s.responseRate)}
                        </td>
                        <td className='py-2.5 pr-4 text-right'>
                          {pct(s.continuedRate)}
                        </td>
                        <td className='py-2.5 pr-4 text-right'>
                          {pct(s.stageAdvancement)}
                        </td>
                        <td className='py-2.5 pr-4 text-right'>
                          {pct(s.bookingRate)}
                        </td>
                        <td className='text-muted-foreground py-2.5 text-right'>
                          {s.sampleSize}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Top Conversation Sequences */}
      <Separator />

      {seqLoading ? (
        <LoadingSpinner label='Loading conversation sequences...' />
      ) : sequences && sequences.sequences.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Top Conversation Sequences</CardTitle>
            <CardDescription>
              Most common paths leads take through conversation stages
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className='space-y-4'>
              {sequences.sequences.map((seq, idx) => (
                <div key={idx} className='rounded-lg border p-4'>
                  {/* Horizontal flow */}
                  <div className='mb-3 flex flex-wrap items-center gap-1'>
                    {seq.steps.map((step, stepIdx) => (
                      <div key={stepIdx} className='flex items-center gap-1'>
                        <Badge variant='outline' className='text-xs'>
                          {step.stage}
                        </Badge>
                        {stepIdx < seq.steps.length - 1 && (
                          <span className='text-muted-foreground text-xs'>
                            {'\u2192'}
                          </span>
                        )}
                      </div>
                    ))}
                    <span className='text-muted-foreground text-xs'>
                      {'\u2192'}
                    </span>
                    <Badge
                      variant={
                        seq.outcome === 'booked' ? 'default' : 'secondary'
                      }
                      className={
                        seq.outcome === 'booked'
                          ? 'border-green-300 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : ''
                      }
                    >
                      {seq.outcome}
                    </Badge>
                  </div>

                  {/* Stats */}
                  <div className='text-muted-foreground flex gap-6 text-xs'>
                    <span>
                      Count:{' '}
                      <span className='text-foreground font-medium'>
                        {seq.count}
                      </span>
                    </span>
                    <span>
                      Booking Rate:{' '}
                      <span className='text-foreground font-medium'>
                        {pct(seq.bookingRate)}
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AnalyticsDeepDivePage() {
  const [activeTab, setActiveTab] = useState<string>('segments');

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:px-6'>
      {/* Header */}
      <div>
        <h1 className='text-2xl font-bold tracking-tight'>
          Analytics Deep Dive
        </h1>
        <p className='text-muted-foreground text-sm'>
          Segment analysis, conversation velocity, and stage effectiveness
          metrics
        </p>
      </div>

      <Separator />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className='w-full'>
        <TabsList>
          <TabsTrigger value='segments'>Segments</TabsTrigger>
          <TabsTrigger value='velocity'>Velocity</TabsTrigger>
          <TabsTrigger value='effectiveness'>Effectiveness</TabsTrigger>
        </TabsList>

        <TabsContent value='segments' className='mt-6'>
          <SegmentsTab />
        </TabsContent>

        <TabsContent value='velocity' className='mt-6'>
          <VelocityTab />
        </TabsContent>

        <TabsContent value='effectiveness' className='mt-6'>
          <EffectivenessTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
