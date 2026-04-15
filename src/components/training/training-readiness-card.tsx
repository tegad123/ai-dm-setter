'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  BarChart3,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Loader2
} from 'lucide-react';
import {
  getTrainingAnalysis,
  runTrainingAnalysis as runAnalysisApi
} from '@/lib/api';
import type { TrainingAnalysisResult, CostEstimate } from '@/lib/api';
import AnalysisCostDialog from './analysis-cost-dialog';
import { toast } from 'sonner';

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-red-600';
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

export default function TrainingReadinessCard() {
  const [analysis, setAnalysis] = useState<TrainingAnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);

  useEffect(() => {
    getTrainingAnalysis()
      .then((res) => setAnalysis(res.analysis))
      .catch(() => {
        /* no analysis yet — that's fine */
      })
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

  if (loading) {
    return (
      <Card>
        <CardContent className='flex items-center gap-2 py-4'>
          <Loader2 className='text-muted-foreground h-4 w-4 animate-spin' />
          <span className='text-muted-foreground text-sm'>
            Loading analysis...
          </span>
        </CardContent>
      </Card>
    );
  }

  // Running analysis — show progress
  if (running) {
    return (
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='flex items-center gap-2 text-base'>
            <BarChart3 className='h-4 w-4' />
            Training Data Readiness
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='flex items-center gap-3 py-4'>
            <Loader2 className='h-5 w-5 animate-spin text-blue-500' />
            <div>
              <p className='text-sm font-medium'>
                Analyzing your training data...
              </p>
              <p className='text-muted-foreground text-xs'>
                This typically takes 30-90 seconds. Checking quantity, voice
                style, lead types, stage coverage, outcomes, and objection
                handling.
              </p>
            </div>
          </div>
          <Progress value={undefined} className='h-2 animate-pulse' />
        </CardContent>
      </Card>
    );
  }

  // Never run — show CTA
  if (!analysis) {
    return (
      <Card className='border-dashed'>
        <CardHeader className='pb-2'>
          <CardTitle className='flex items-center gap-2 text-base'>
            <BarChart3 className='h-4 w-4' />
            Training Data Readiness
          </CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <p className='text-muted-foreground text-sm'>
            Analyze your training data to see if your AI has enough material to
            perform well. Checks quantity, voice consistency, lead diversity,
            stage coverage, outcomes, and objection handling.
          </p>
          <AnalysisCostDialog
            estimate={estimate}
            loading={estimating}
            running={running}
            onEstimate={handleEstimate}
            onConfirm={handleRunAnalysis}
          />
        </CardContent>
      </Card>
    );
  }

  // Has analysis — show compact readiness card
  const topRecs = analysis.recommendations?.slice(0, 2) || [];

  return (
    <Card>
      <CardHeader className='pb-2'>
        <div className='flex items-center justify-between'>
          <CardTitle className='flex items-center gap-2 text-base'>
            <BarChart3 className='h-4 w-4' />
            Training Data Readiness
          </CardTitle>
          <div className='flex items-center gap-2'>
            {scoreBadge(analysis.overallScore)}
            <span
              className={`text-2xl font-bold ${scoreColor(analysis.overallScore)}`}
            >
              {analysis.overallScore}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        <Progress value={analysis.overallScore} className='h-2' />

        {topRecs.length > 0 && (
          <div className='space-y-1.5'>
            {topRecs.map((rec, i) => (
              <div key={i} className='flex items-start gap-2 text-sm'>
                <AlertCircle
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                    rec.severity === 'high'
                      ? 'text-red-500'
                      : rec.severity === 'medium'
                        ? 'text-amber-500'
                        : 'text-gray-400'
                  }`}
                />
                <span className='text-muted-foreground'>
                  {rec.recommendation}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className='flex items-center justify-between'>
          <Link href='/dashboard/settings/training/analysis'>
            <Button variant='ghost' size='sm'>
              View Details
              <ArrowRight className='ml-1 h-3.5 w-3.5' />
            </Button>
          </Link>
          <AnalysisCostDialog
            estimate={estimate}
            loading={estimating}
            running={running}
            onEstimate={handleEstimate}
            onConfirm={handleRunAnalysis}
          />
        </div>
      </CardContent>
    </Card>
  );
}
