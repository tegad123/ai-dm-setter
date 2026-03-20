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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {
  IconLoader2,
  IconPlus,
  IconFlask,
  IconTrophy
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ABTestVariant {
  sample_count: number;
  response_rate: number;
  booking_rate: number;
}

interface ABTest {
  id: string;
  name: string;
  stage: string;
  status: 'RUNNING' | 'COMPLETED' | 'PAUSED';
  sample_size: number;
  variant_a: string;
  variant_b: string;
  results: {
    variant_a: ABTestVariant;
    variant_b: ABTestVariant;
  };
  winner?: 'A' | 'B' | null;
  created_at: string;
}

interface ABTestResults {
  statistical_significance: number;
  confidence_level: number;
  winner: 'A' | 'B' | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGES = [
  { value: 'opener', label: 'Opener' },
  { value: 'qualification', label: 'Qualification' },
  { value: 'vision_building', label: 'Vision Building' },
  { value: 'pain_identification', label: 'Pain Identification' },
  { value: 'urgency', label: 'Urgency' },
  { value: 'solution_offer', label: 'Solution Offer' },
  { value: 'capital_qualification', label: 'Capital Qualification' },
  { value: 'booking', label: 'Booking' },
  { value: 'follow_up', label: 'Follow Up' }
] as const;

const statusColors: Record<string, string> = {
  RUNNING:
    'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  COMPLETED:
    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800',
  PAUSED:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800'
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ABTestsPage() {
  const [tests, setTests] = useState<ABTest[]>([]);
  const [resultsMap, setResultsMap] = useState<Record<string, ABTestResults>>(
    {}
  );
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Form state
  const [testName, setTestName] = useState('');
  const [stage, setStage] = useState('');
  const [variantA, setVariantA] = useState('');
  const [variantB, setVariantB] = useState('');
  const [sampleSize, setSampleSize] = useState('50');

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  const fetchTests = useCallback(async () => {
    try {
      const data = await apiFetch<ABTest[]>('/admin/ab-tests');
      setTests(data);

      // Fetch results for each test
      const results: Record<string, ABTestResults> = {};
      await Promise.allSettled(
        data.map(async (test) => {
          try {
            const r = await apiFetch<ABTestResults>(
              `/admin/ab-tests/${test.id}/results`
            );
            results[test.id] = r;
          } catch {
            // Individual result fetch failure is non-critical
          }
        })
      );
      setResultsMap(results);
    } catch {
      toast.error('Failed to load A/B tests');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTests();
  }, [fetchTests]);

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  const resetForm = () => {
    setTestName('');
    setStage('');
    setVariantA('');
    setVariantB('');
    setSampleSize('50');
  };

  const handleCreate = async () => {
    if (!testName.trim() || !stage || !variantA.trim() || !variantB.trim()) {
      toast.error('Please fill in all required fields');
      return;
    }
    setCreating(true);
    try {
      await apiFetch('/admin/ab-tests', {
        method: 'POST',
        body: JSON.stringify({
          name: testName.trim(),
          stage,
          variant_a: variantA.trim(),
          variant_b: variantB.trim(),
          sample_size: parseInt(sampleSize, 10) || 50
        })
      });
      toast.success('A/B test created successfully');
      setDialogOpen(false);
      resetForm();
      await fetchTests();
    } catch {
      toast.error('Failed to create A/B test');
    } finally {
      setCreating(false);
    }
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleTogglePause = async (test: ABTest) => {
    const newStatus = test.status === 'PAUSED' ? 'RUNNING' : 'PAUSED';
    setActionLoading(test.id);
    try {
      await apiFetch(`/admin/ab-tests/${test.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus })
      });
      toast.success(newStatus === 'PAUSED' ? 'Test paused' : 'Test resumed');
      await fetchTests();
    } catch {
      toast.error('Failed to update test');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (test: ABTest) => {
    setActionLoading(test.id);
    try {
      await apiFetch(`/admin/ab-tests/${test.id}`, { method: 'DELETE' });
      toast.success('Test deleted');
      await fetchTests();
    } catch {
      toast.error('Failed to delete test');
    } finally {
      setActionLoading(null);
    }
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const stageLabel = (value: string) =>
    STAGES.find((s) => s.value === value)?.label ?? value;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:px-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>A/B Tests</h1>
          <p className='text-muted-foreground text-sm'>
            Test message variations to optimise conversion rates
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <IconPlus className='mr-2 h-4 w-4' />
              Create Test
            </Button>
          </DialogTrigger>
          <DialogContent className='sm:max-w-lg'>
            <DialogHeader>
              <DialogTitle>Create A/B Test</DialogTitle>
              <DialogDescription>
                Define two message variants to test against each other.
              </DialogDescription>
            </DialogHeader>

            <div className='grid gap-4 py-4'>
              <div className='grid gap-2'>
                <Label htmlFor='test-name'>Test Name</Label>
                <Input
                  id='test-name'
                  placeholder='e.g. Opener tone test'
                  value={testName}
                  onChange={(e) => setTestName(e.target.value)}
                />
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='stage'>Stage</Label>
                <Select value={stage} onValueChange={setStage}>
                  <SelectTrigger id='stage'>
                    <SelectValue placeholder='Select a conversation stage' />
                  </SelectTrigger>
                  <SelectContent>
                    {STAGES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='variant-a'>Variant A</Label>
                <Textarea
                  id='variant-a'
                  placeholder='Enter message text for Variant A...'
                  rows={3}
                  value={variantA}
                  onChange={(e) => setVariantA(e.target.value)}
                />
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='variant-b'>Variant B</Label>
                <Textarea
                  id='variant-b'
                  placeholder='Enter message text for Variant B...'
                  rows={3}
                  value={variantB}
                  onChange={(e) => setVariantB(e.target.value)}
                />
              </div>

              <div className='grid gap-2'>
                <Label htmlFor='sample-size'>Sample Size per Variant</Label>
                <Input
                  id='sample-size'
                  type='number'
                  min={10}
                  value={sampleSize}
                  onChange={(e) => setSampleSize(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant='outline'
                onClick={() => {
                  setDialogOpen(false);
                  resetForm();
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={creating}>
                {creating && (
                  <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                Create Test
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Separator />

      {/* Loading */}
      {loading && (
        <div className='flex flex-col items-center justify-center py-16'>
          <IconLoader2 className='text-muted-foreground h-8 w-8 animate-spin' />
          <p className='text-muted-foreground mt-3 text-sm'>
            Loading A/B tests...
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && tests.length === 0 && (
        <Card>
          <CardContent className='flex flex-col items-center justify-center py-16'>
            <IconFlask className='text-muted-foreground mb-4 h-12 w-12' />
            <h3 className='mb-1 text-lg font-semibold'>No A/B tests yet</h3>
            <p className='text-muted-foreground mb-4 text-sm'>
              Create your first test to start optimising message performance.
            </p>
            <Button onClick={() => setDialogOpen(true)}>
              <IconPlus className='mr-2 h-4 w-4' />
              Create Test
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Test list */}
      {!loading && tests.length > 0 && (
        <div className='grid gap-4'>
          {tests.map((test) => {
            const result = resultsMap[test.id];
            const isActionLoading = actionLoading === test.id;

            return (
              <Card key={test.id}>
                <CardHeader className='pb-3'>
                  <div className='flex items-start justify-between'>
                    <div className='flex items-center gap-2'>
                      <CardTitle className='text-lg'>{test.name}</CardTitle>
                      <Badge variant='outline'>{stageLabel(test.stage)}</Badge>
                      <Badge className={statusColors[test.status] ?? ''}>
                        {test.status}
                      </Badge>
                    </div>
                    <div className='flex gap-2'>
                      {test.status !== 'COMPLETED' && (
                        <Button
                          variant='outline'
                          size='sm'
                          disabled={isActionLoading}
                          onClick={() => handleTogglePause(test)}
                        >
                          {isActionLoading ? (
                            <IconLoader2 className='mr-1 h-3 w-3 animate-spin' />
                          ) : null}
                          {test.status === 'PAUSED' ? 'Resume' : 'Pause'}
                        </Button>
                      )}
                      <Button
                        variant='destructive'
                        size='sm'
                        disabled={isActionLoading}
                        onClick={() => handleDelete(test)}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  <CardDescription>
                    Sample size: {test.sample_size} per variant
                  </CardDescription>
                </CardHeader>

                <CardContent>
                  <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
                    {/* Variant A */}
                    <div className='rounded-lg border p-4'>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='text-sm font-semibold'>Variant A</span>
                        {test.status === 'COMPLETED' && test.winner === 'A' && (
                          <Badge className='border-green-200 bg-green-100 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400'>
                            <IconTrophy className='mr-1 h-3 w-3' />
                            Winner
                          </Badge>
                        )}
                      </div>
                      <p className='text-muted-foreground mb-3 text-xs leading-relaxed'>
                        {test.variant_a}
                      </p>
                      <div className='grid grid-cols-3 gap-2 text-center'>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_a.sample_count}
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Samples
                          </p>
                        </div>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_a.response_rate.toFixed(1)}%
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Response Rate
                          </p>
                        </div>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_a.booking_rate.toFixed(1)}%
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Booking Rate
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Variant B */}
                    <div className='rounded-lg border p-4'>
                      <div className='mb-2 flex items-center gap-2'>
                        <span className='text-sm font-semibold'>Variant B</span>
                        {test.status === 'COMPLETED' && test.winner === 'B' && (
                          <Badge className='border-green-200 bg-green-100 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-400'>
                            <IconTrophy className='mr-1 h-3 w-3' />
                            Winner
                          </Badge>
                        )}
                      </div>
                      <p className='text-muted-foreground mb-3 text-xs leading-relaxed'>
                        {test.variant_b}
                      </p>
                      <div className='grid grid-cols-3 gap-2 text-center'>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_b.sample_count}
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Samples
                          </p>
                        </div>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_b.response_rate.toFixed(1)}%
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Response Rate
                          </p>
                        </div>
                        <div>
                          <p className='text-lg font-bold'>
                            {test.results.variant_b.booking_rate.toFixed(1)}%
                          </p>
                          <p className='text-muted-foreground text-xs'>
                            Booking Rate
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Statistical significance */}
                  {result && (
                    <div className='bg-muted/50 mt-4 rounded-lg border p-3'>
                      <div className='flex items-center justify-between text-sm'>
                        <span className='text-muted-foreground'>
                          Statistical Significance
                        </span>
                        <div className='flex items-center gap-3'>
                          <span className='font-medium'>
                            {(result.statistical_significance * 100).toFixed(1)}
                            %
                          </span>
                          <Badge
                            variant='outline'
                            className={
                              result.confidence_level >= 0.95
                                ? 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-400'
                                : result.confidence_level >= 0.9
                                  ? 'border-yellow-300 text-yellow-700 dark:border-yellow-800 dark:text-yellow-400'
                                  : 'border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400'
                            }
                          >
                            {result.confidence_level >= 0.95
                              ? 'High Confidence'
                              : result.confidence_level >= 0.9
                                ? 'Moderate Confidence'
                                : 'Low Confidence'}
                          </Badge>
                        </div>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
