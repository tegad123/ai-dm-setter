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
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { IconLoader2 } from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PredictionModelInfo {
  id: string;
  accountId: string;
  version: number;
  modelType: string;
  features: unknown;
  trainingSize: number;
  holdoutSize: number;
  accuracy: number;
  auc: number;
  precision: number;
  recall: number;
  isActive: boolean;
  trainedAt: string;
  predictionCount: number;
}

interface ModelsResponse {
  models: PredictionModelInfo[];
}

interface EvaluationResponse {
  modelVersion: number;
  holdoutAccuracy: number;
  realWorldAccuracy: number;
  totalPredictions: number;
  correctPredictions: number;
  incorrectPredictions: number;
  degraded: boolean;
}

interface PredictionItem {
  conversationId: string;
  leadAnonymized: string;
  probability: number;
  confidence: string;
  stage: string;
  velocity: string;
}

interface PredictionsAvailable {
  predictions: PredictionItem[];
  modelVersion: number;
  modelAccuracy: number;
}

interface PredictionsUnavailable {
  available: false;
  reason: string;
  conversationsNeeded: number;
}

type PredictionsResponse = PredictionsAvailable | PredictionsUnavailable;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function probColor(probability: number): string {
  if (probability > 0.6) return 'text-green-600 dark:text-green-400';
  if (probability >= 0.3) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}

function probBadgeVariant(
  probability: number
): 'default' | 'secondary' | 'destructive' {
  if (probability > 0.6) return 'default';
  if (probability >= 0.3) return 'secondary';
  return 'destructive';
}

function confidenceTier(trainingSize: number): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive';
} {
  if (trainingSize >= 500) return { label: 'Reliable', variant: 'default' };
  if (trainingSize >= 200)
    return { label: 'Early Model', variant: 'secondary' };
  return { label: 'Not Available', variant: 'destructive' };
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ---------------------------------------------------------------------------
// Loading Spinner
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
// Section 1: Model Status Card
// ---------------------------------------------------------------------------

function ModelStatusCard() {
  const [models, setModels] = useState<PredictionModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [training, setTraining] = useState(false);
  const [conversationCount, setConversationCount] = useState(0);

  const fetchModels = useCallback(async () => {
    try {
      const res = await apiFetch<ModelsResponse>('/admin/prediction/models');
      setModels(res.models);
    } catch {
      toast.error('Failed to load prediction models');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch conversation count for progress when no model exists
  const fetchConversationCount = useCallback(async () => {
    try {
      const res = await apiFetch<PredictionsUnavailable>(
        '/analytics/predictions'
      );
      if ('conversationsNeeded' in res) {
        // conversationsNeeded = 200 - currentCount, so currentCount = 200 - conversationsNeeded
        setConversationCount(200 - (res.conversationsNeeded ?? 0));
      }
    } catch {
      // Silently ignore; the models fetch will show the main error
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    if (!loading && models.length === 0) {
      fetchConversationCount();
    }
  }, [loading, models.length, fetchConversationCount]);

  const handleTrain = async () => {
    setTraining(true);
    try {
      await apiFetch('/admin/prediction/train', { method: 'POST' });
      toast.success('Model training complete');
      fetchModels();
    } catch {
      toast.error('Failed to train model');
    } finally {
      setTraining(false);
    }
  };

  if (loading) return <LoadingSpinner label='Loading model status...' />;

  const activeModel = models.find((m) => m.isActive);
  const MIN_CONVERSATIONS = 200;
  const progressPercent = Math.min(
    (conversationCount / MIN_CONVERSATIONS) * 100,
    100
  );

  if (!activeModel) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Model Status</CardTitle>
          <CardDescription>
            Booking prediction model is not yet available
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className='space-y-4'>
            <Badge variant='destructive'>Model Not Available</Badge>

            <div className='space-y-2'>
              <div className='flex justify-between text-sm'>
                <span className='text-muted-foreground'>
                  Conversations needed for training
                </span>
                <span className='font-medium'>
                  {conversationCount} / {MIN_CONVERSATIONS}
                </span>
              </div>
              <Progress value={progressPercent} className='h-2' />
              <p className='text-muted-foreground text-xs'>
                Collect at least {MIN_CONVERSATIONS} resolved conversations to
                enable model training.
              </p>
            </div>

            <Button
              onClick={handleTrain}
              disabled={conversationCount < MIN_CONVERSATIONS || training}
            >
              {training && (
                <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
              )}
              Train Model
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const tier = confidenceTier(activeModel.trainingSize);

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <div>
            <CardTitle>Model Status</CardTitle>
            <CardDescription>
              Active prediction model v{activeModel.version}
            </CardDescription>
          </div>
          <Badge variant={tier.variant}>{tier.label}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className='grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6'>
          <div>
            <p className='text-muted-foreground text-xs'>Version</p>
            <p className='text-lg font-semibold'>v{activeModel.version}</p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Accuracy</p>
            <p className='text-lg font-semibold'>{pct(activeModel.accuracy)}</p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>AUC</p>
            <p className='text-lg font-semibold'>{pct(activeModel.auc)}</p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Precision</p>
            <p className='text-lg font-semibold'>
              {pct(activeModel.precision)}
            </p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Recall</p>
            <p className='text-lg font-semibold'>{pct(activeModel.recall)}</p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Training Size</p>
            <p className='text-lg font-semibold'>{activeModel.trainingSize}</p>
          </div>
        </div>

        <Separator className='my-4' />

        <div className='flex items-center justify-between'>
          <p className='text-muted-foreground text-xs'>
            Trained on {formatDate(activeModel.trainedAt)}
          </p>
          <Button
            variant='outline'
            size='sm'
            onClick={handleTrain}
            disabled={training}
          >
            {training && <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />}
            Retrain Model
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 2: Model Evaluation Card
// ---------------------------------------------------------------------------

function ModelEvaluationCard() {
  const [evaluation, setEvaluation] = useState<EvaluationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [noModel, setNoModel] = useState(false);

  const fetchEvaluation = useCallback(async () => {
    try {
      const res = await apiFetch<EvaluationResponse>(
        '/admin/prediction/evaluate'
      );
      setEvaluation(res);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 400) {
        setNoModel(true);
      } else {
        toast.error('Failed to load model evaluation');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvaluation();
  }, [fetchEvaluation]);

  if (loading) return <LoadingSpinner label='Loading model evaluation...' />;
  if (noModel || !evaluation) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Model Evaluation</CardTitle>
          <CardDescription>
            No active model to evaluate. Train a model first.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const accuracyDegraded =
    evaluation.degraded || evaluation.realWorldAccuracy < 0.6;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model Evaluation</CardTitle>
        <CardDescription>
          Real-world performance of model v{evaluation.modelVersion}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {accuracyDegraded && (
          <div className='mb-4 rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950/30'>
            <p className='text-sm font-medium text-red-800 dark:text-red-300'>
              Model accuracy has degraded below 60%. Consider retraining with
              recent data.
            </p>
          </div>
        )}

        <div className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <div>
            <p className='text-muted-foreground text-xs'>Real-world Accuracy</p>
            <p
              className={`text-lg font-semibold ${accuracyDegraded ? 'text-red-600 dark:text-red-400' : ''}`}
            >
              {pct(evaluation.realWorldAccuracy)}
            </p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Holdout Accuracy</p>
            <p className='text-lg font-semibold'>
              {pct(evaluation.holdoutAccuracy)}
            </p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Correct</p>
            <p className='text-lg font-semibold text-green-600 dark:text-green-400'>
              {evaluation.correctPredictions}
            </p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Incorrect</p>
            <p className='text-lg font-semibold text-red-600 dark:text-red-400'>
              {evaluation.incorrectPredictions}
            </p>
          </div>
        </div>

        <Separator className='my-4' />

        <p className='text-muted-foreground text-xs'>
          Total predictions evaluated: {evaluation.totalPredictions}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 3: Live Predictions Table
// ---------------------------------------------------------------------------

function LivePredictionsTable() {
  const [predictions, setPredictions] = useState<PredictionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [conversationsNeeded, setConversationsNeeded] = useState(0);

  const fetchPredictions = useCallback(async () => {
    try {
      const res = await apiFetch<PredictionsResponse>('/analytics/predictions');

      if ('available' in res && res.available === false) {
        setUnavailable(true);
        setConversationsNeeded(res.conversationsNeeded);
      } else if ('predictions' in res) {
        setPredictions(res.predictions);
      }
    } catch {
      toast.error('Failed to load booking predictions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPredictions();
  }, [fetchPredictions]);

  if (loading) return <LoadingSpinner label='Loading predictions...' />;

  if (unavailable) {
    const currentCount = 200 - conversationsNeeded;
    const progressPercent = Math.min((currentCount / 200) * 100, 100);

    return (
      <Card>
        <CardHeader>
          <CardTitle>Live Booking Predictions</CardTitle>
          <CardDescription>Prediction model not yet available</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='space-y-3'>
            <div className='flex justify-between text-sm'>
              <span className='text-muted-foreground'>
                Conversations toward training threshold
              </span>
              <span className='font-medium'>
                {Math.max(0, currentCount)} / 200
              </span>
            </div>
            <Progress value={progressPercent} className='h-2' />
            <p className='text-muted-foreground text-xs'>
              {conversationsNeeded > 0
                ? `${conversationsNeeded} more resolved conversations needed before predictions are available.`
                : 'Sufficient data collected. Train the model above to enable predictions.'}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Booking Predictions</CardTitle>
        <CardDescription>
          Real-time probability estimates for ongoing conversations (
          {predictions.length} active)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {predictions.length === 0 ? (
          <p className='text-muted-foreground py-8 text-center text-sm'>
            No ongoing conversations to predict.
          </p>
        ) : (
          <div className='overflow-x-auto'>
            <table className='w-full text-sm'>
              <thead>
                <tr className='text-muted-foreground border-b text-left text-xs'>
                  <th className='pr-4 pb-2 font-medium'>Lead</th>
                  <th className='pr-4 pb-2 font-medium'>Stage</th>
                  <th className='pr-4 pb-2 text-right font-medium'>
                    Probability
                  </th>
                  <th className='pr-4 pb-2 font-medium'>Confidence</th>
                  <th className='pb-2 font-medium'>Velocity</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => (
                  <tr key={p.conversationId} className='border-b last:border-0'>
                    <td className='py-2.5 pr-4 font-medium'>
                      {p.leadAnonymized}
                    </td>
                    <td className='py-2.5 pr-4'>
                      <Badge variant='outline' className='text-xs'>
                        {p.stage}
                      </Badge>
                    </td>
                    <td className='py-2.5 pr-4 text-right'>
                      <Badge variant={probBadgeVariant(p.probability)}>
                        <span className={probColor(p.probability)}>
                          {pct(p.probability)}
                        </span>
                      </Badge>
                    </td>
                    <td className='py-2.5 pr-4'>
                      <span className='text-xs'>{p.confidence}</span>
                    </td>
                    <td className='py-2.5'>
                      <span className='text-xs'>{p.velocity}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section 4: Model History
// ---------------------------------------------------------------------------

function ModelHistory() {
  const [models, setModels] = useState<PredictionModelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchModels = useCallback(async () => {
    try {
      const res = await apiFetch<ModelsResponse>('/admin/prediction/models');
      setModels(res.models);
    } catch {
      toast.error('Failed to load model history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  if (loading) return <LoadingSpinner label='Loading model history...' />;

  if (models.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Model History</CardTitle>
          <CardDescription>No models have been trained yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model History</CardTitle>
        <CardDescription>
          Past model versions and performance comparison
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-muted-foreground border-b text-left text-xs'>
                <th className='pr-4 pb-2 font-medium'>Version</th>
                <th className='pr-4 pb-2 text-right font-medium'>Accuracy</th>
                <th className='pr-4 pb-2 text-right font-medium'>AUC</th>
                <th className='pr-4 pb-2 text-right font-medium'>Precision</th>
                <th className='pr-4 pb-2 text-right font-medium'>Recall</th>
                <th className='pr-4 pb-2 text-right font-medium'>
                  Training Size
                </th>
                <th className='pr-4 pb-2 text-right font-medium'>
                  Predictions
                </th>
                <th className='pb-2 font-medium'>Trained</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className='border-b last:border-0'>
                  <td className='py-2.5 pr-4 font-medium'>
                    v{m.version}
                    {m.isActive && (
                      <Badge variant='default' className='ml-2 text-[10px]'>
                        Active
                      </Badge>
                    )}
                  </td>
                  <td className='py-2.5 pr-4 text-right'>{pct(m.accuracy)}</td>
                  <td className='py-2.5 pr-4 text-right'>{pct(m.auc)}</td>
                  <td className='py-2.5 pr-4 text-right'>{pct(m.precision)}</td>
                  <td className='py-2.5 pr-4 text-right'>{pct(m.recall)}</td>
                  <td className='py-2.5 pr-4 text-right'>{m.trainingSize}</td>
                  <td className='py-2.5 pr-4 text-right'>
                    {m.predictionCount}
                  </td>
                  <td className='text-muted-foreground py-2.5 text-xs'>
                    {formatDate(m.trainedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PredictionDashboardPage() {
  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:px-6'>
      {/* Header */}
      <div>
        <h1 className='text-2xl font-bold tracking-tight'>
          Booking Predictions
        </h1>
        <p className='text-muted-foreground text-sm'>
          AI-powered booking probability estimates and model performance
        </p>
      </div>

      <Separator />

      {/* Model Status */}
      <ModelStatusCard />

      {/* Model Evaluation */}
      <ModelEvaluationCard />

      {/* Live Predictions Table */}
      <LivePredictionsTable />

      {/* Model History */}
      <ModelHistory />
    </div>
  );
}
