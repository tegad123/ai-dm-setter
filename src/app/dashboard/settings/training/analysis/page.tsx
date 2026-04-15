'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  BarChart3,
  Hash,
  Mic2,
  Users,
  GitBranch,
  Target,
  ShieldAlert,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ArrowLeft,
  RefreshCw
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import {
  getTrainingAnalysis,
  runTrainingAnalysis as runAnalysisApi
} from '@/lib/api';
import type { TrainingAnalysisResult, CostEstimate } from '@/lib/api';
import AnalysisCostDialog from '@/components/training/analysis-cost-dialog';
import { toast } from 'sonner';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<
  string,
  { label: string; icon: React.ElementType; description: string }
> = {
  quantity: {
    label: 'Quantity',
    icon: Hash,
    description:
      'Total conversation and message volume — enough data for the AI to learn patterns.'
  },
  voice_style: {
    label: 'Voice & Style',
    icon: Mic2,
    description:
      'Vocabulary diversity and tonal consistency across your closer messages.'
  },
  lead_type_coverage: {
    label: 'Lead Type Coverage',
    icon: Users,
    description:
      'Distribution across 11 lead types — ensures the AI can handle different prospect profiles.'
  },
  stage_coverage: {
    label: 'Stage Coverage',
    icon: GitBranch,
    description:
      'Coverage across the 10-stage sales pipeline — the AI needs examples at every step.'
  },
  outcome_coverage: {
    label: 'Outcome Coverage',
    icon: Target,
    description:
      'Outcome variety across 8 types — prevents survivorship bias from win-only datasets.'
  },
  objection_coverage: {
    label: 'Objection Coverage',
    icon: ShieldAlert,
    description:
      'Coverage across 11 objection types — the AI needs to know how you handle pushback.'
  }
};

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function scoreBgColor(score: number): string {
  if (score >= 80) return 'bg-green-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreBadge(score: number) {
  if (score >= 80)
    return (
      <Badge className='border-green-300 bg-green-100 text-green-800'>
        <CheckCircle2 className='mr-1 h-3 w-3' />
        Good
      </Badge>
    );
  if (score >= 50)
    return (
      <Badge className='border-amber-300 bg-amber-100 text-amber-800'>
        <AlertTriangle className='mr-1 h-3 w-3' />
        Needs Work
      </Badge>
    );
  return (
    <Badge className='border-red-300 bg-red-100 text-red-800'>
      <AlertCircle className='mr-1 h-3 w-3' />
      Insufficient
    </Badge>
  );
}

function severityIcon(severity: string) {
  switch (severity) {
    case 'high':
      return <AlertCircle className='mt-0.5 h-4 w-4 shrink-0 text-red-500' />;
    case 'medium':
      return (
        <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-amber-500' />
      );
    default:
      return <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-gray-400' />;
  }
}

// ─── Page Component ──────────────────────────────────────────────────────────

export default function TrainingAnalysisPage() {
  const [analysis, setAnalysis] = useState<TrainingAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);

  useEffect(() => {
    getTrainingAnalysis()
      .then((res) => setAnalysis(res.analysis))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleEstimate() {
    setEstimating(true);
    try {
      const res = await runAnalysisApi(false);
      if ('estimate' in res) {
        setEstimate(res.estimate);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to estimate cost'
      );
    } finally {
      setEstimating(false);
    }
  }

  async function handleRunAnalysis() {
    setRunning(true);
    try {
      const res = await runAnalysisApi(true);
      if ('analysis' in res) {
        setAnalysis(res.analysis);
        toast.success('Analysis complete!');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setRunning(false);
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-2 p-6'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
        <span className='text-muted-foreground text-sm'>
          Loading analysis...
        </span>
      </div>
    );
  }

  // No analysis yet — full-page CTA
  if (!analysis) {
    return (
      <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
        <div className='flex items-center gap-2'>
          <Link href='/dashboard/settings/training'>
            <Button variant='ghost' size='sm'>
              <ArrowLeft className='mr-1 h-4 w-4' />
              Back to Training Data
            </Button>
          </Link>
        </div>

        <div className='flex flex-1 flex-col items-center justify-center gap-4 py-12'>
          <div className='bg-muted flex h-16 w-16 items-center justify-center rounded-full'>
            <BarChart3 className='text-muted-foreground h-8 w-8' />
          </div>
          <h2 className='text-xl font-semibold'>No Analysis Yet</h2>
          <p className='text-muted-foreground max-w-md text-center text-sm'>
            Run a training data analysis to see how ready your AI is. We&apos;ll
            check quantity, voice consistency, lead diversity, stage coverage,
            outcome distribution, and objection handling.
          </p>
          <AnalysisCostDialog
            estimate={estimate}
            loading={estimating}
            running={running}
            onEstimate={handleEstimate}
            onConfirm={handleRunAnalysis}
          />
        </div>
      </div>
    );
  }

  // Has analysis — full results page
  const categories = analysis.categoryScores;
  const categoryKeys = Object.keys(CATEGORY_META) as Array<
    keyof typeof CATEGORY_META
  >;
  const recs = analysis.recommendations || [];

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      {/* Nav */}
      <div className='flex items-center gap-2'>
        <Link href='/dashboard/settings/training'>
          <Button variant='ghost' size='sm'>
            <ArrowLeft className='mr-1 h-4 w-4' />
            Back to Training Data
          </Button>
        </Link>
      </div>

      {/* Header: overall score + meta */}
      <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>
            Training Data Analysis
          </h2>
          <p className='text-muted-foreground text-sm'>
            {analysis.totalConversations} conversations &middot;{' '}
            {analysis.totalMessages.toLocaleString()} messages &middot; Last
            analyzed{' '}
            {new Date(analysis.runAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })}
          </p>
        </div>

        <div className='flex items-center gap-4'>
          {/* Overall score */}
          <div className='flex items-center gap-3'>
            {scoreBadge(analysis.overallScore)}
            <span
              className={`text-4xl font-bold ${scoreColor(analysis.overallScore)}`}
            >
              {analysis.overallScore}
            </span>
            <span className='text-muted-foreground text-sm'>/100</span>
          </div>

          {/* Re-run */}
          <AnalysisCostDialog
            estimate={estimate}
            loading={estimating}
            running={running}
            onEstimate={handleEstimate}
            onConfirm={handleRunAnalysis}
          />
        </div>
      </div>

      {/* Overall progress */}
      <Progress value={analysis.overallScore} className='h-3' />

      {/* 6 Category cards in 2x3 grid */}
      <div className='grid gap-4 md:grid-cols-2 lg:grid-cols-3'>
        {categoryKeys.map((key) => {
          const meta = CATEGORY_META[key];
          const score = categories[key as keyof typeof categories] ?? 0;
          const Icon = meta.icon;
          const categoryRecs = recs.filter((r) => r.category === key);

          return (
            <Card key={key}>
              <CardHeader className='pb-2'>
                <div className='flex items-center justify-between'>
                  <CardTitle className='flex items-center gap-2 text-sm font-medium'>
                    <Icon className='h-4 w-4' />
                    {meta.label}
                  </CardTitle>
                  {scoreBadge(score)}
                </div>
              </CardHeader>
              <CardContent className='space-y-3'>
                {/* Score bar */}
                <div className='flex items-center gap-3'>
                  <Progress value={score} className='h-2 flex-1' />
                  <span className={`text-lg font-bold ${scoreColor(score)}`}>
                    {score}
                  </span>
                </div>

                {/* Description */}
                <p className='text-muted-foreground text-xs'>
                  {meta.description}
                </p>

                {/* Category-specific recommendations */}
                {categoryRecs.length > 0 && (
                  <div className='border-t pt-2'>
                    <div className='space-y-1.5'>
                      {categoryRecs.map((rec, i) => (
                        <div key={i} className='flex items-start gap-2 text-xs'>
                          {severityIcon(rec.severity)}
                          <span className='text-muted-foreground'>
                            {rec.recommendation}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* All Recommendations */}
      {recs.length > 0 && (
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-base'>All Recommendations</CardTitle>
          </CardHeader>
          <CardContent>
            <div className='space-y-3'>
              {recs.map((rec, i) => {
                const meta =
                  CATEGORY_META[rec.category as keyof typeof CATEGORY_META];
                return (
                  <div
                    key={i}
                    className='flex items-start gap-3 rounded-md border p-3'
                  >
                    {severityIcon(rec.severity)}
                    <div className='flex-1 space-y-1'>
                      <div className='flex items-center gap-2'>
                        <span className='text-sm font-medium'>
                          {rec.recommendation}
                        </span>
                        {meta && (
                          <Badge variant='outline' className='text-xs'>
                            {meta.label}
                          </Badge>
                        )}
                        <Badge
                          variant='outline'
                          className={`text-xs ${
                            rec.severity === 'high'
                              ? 'border-red-300 text-red-700'
                              : rec.severity === 'medium'
                                ? 'border-amber-300 text-amber-700'
                                : 'border-gray-300 text-gray-500'
                          }`}
                        >
                          {rec.severity}
                        </Badge>
                      </div>
                      {rec.description && (
                        <p className='text-muted-foreground text-xs'>
                          {rec.description}
                        </p>
                      )}
                      {rec.evidence && (
                        <p className='text-muted-foreground text-xs italic'>
                          {rec.evidence}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
