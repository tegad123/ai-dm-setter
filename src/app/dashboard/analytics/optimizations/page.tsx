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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  IconLoader2,
  IconSparkles,
  IconBulb,
  IconCheck,
  IconX,
  IconArrowBackUp,
  IconRocket
} from '@tabler/icons-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SuggestionType =
  | 'SYSTEM_PROMPT_UPDATE'
  | 'MESSAGE_VARIATION'
  | 'FLOW_ADJUSTMENT';

type SuggestionStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'STAGING_TEST'
  | 'APPLIED'
  | 'REJECTED'
  | 'REVERTED';

interface Optimization {
  id: string;
  type: SuggestionType;
  status: SuggestionStatus;
  reasoning: string;
  sample_size: number;
  confidence_level: number;
  expected_improvement: number;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const typeBadge: Record<SuggestionType, { label: string; className: string }> =
  {
    SYSTEM_PROMPT_UPDATE: {
      label: 'System Prompt',
      className:
        'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800'
    },
    MESSAGE_VARIATION: {
      label: 'Message Variation',
      className:
        'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
    },
    FLOW_ADJUSTMENT: {
      label: 'Flow Adjustment',
      className:
        'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800'
    }
  };

const statusBadge: Record<
  SuggestionStatus,
  { label: string; className: string }
> = {
  PENDING_APPROVAL: {
    label: 'Pending Approval',
    className:
      'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800'
  },
  APPROVED: {
    label: 'Approved',
    className:
      'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800'
  },
  STAGING_TEST: {
    label: 'Staging Test',
    className:
      'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800'
  },
  APPLIED: {
    label: 'Applied',
    className:
      'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200 dark:border-green-800'
  },
  REJECTED: {
    label: 'Rejected',
    className:
      'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
  },
  REVERTED: {
    label: 'Reverted',
    className:
      'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400 border-gray-200 dark:border-gray-800'
  }
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function OptimizationsPage() {
  const [suggestions, setSuggestions] = useState<Optimization[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notesMap, setNotesMap] = useState<Record<string, string>>({});

  // -------------------------------------------------------------------------
  // Fetch
  // -------------------------------------------------------------------------

  const fetchSuggestions = useCallback(async () => {
    try {
      const data = await apiFetch<Optimization[]>('/admin/optimizations');
      setSuggestions(data);
      // Initialise notes from existing data
      const notes: Record<string, string> = {};
      for (const s of data) {
        notes[s.id] = s.admin_notes ?? '';
      }
      setNotesMap(notes);
    } catch {
      toast.error('Failed to load optimizations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  // -------------------------------------------------------------------------
  // Run Analysis
  // -------------------------------------------------------------------------

  const handleRunAnalysis = async () => {
    setAnalysisRunning(true);
    try {
      await apiFetch('/admin/optimizations', { method: 'POST' });
      toast.success('Analysis complete. New suggestions generated.');
      await fetchSuggestions();
    } catch {
      toast.error('Failed to run analysis');
    } finally {
      setAnalysisRunning(false);
    }
  };

  // -------------------------------------------------------------------------
  // Status Update
  // -------------------------------------------------------------------------

  const updateStatus = async (id: string, newStatus: SuggestionStatus) => {
    setActionLoading(id);
    try {
      await apiFetch(`/admin/optimizations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: newStatus,
          admin_notes: notesMap[id] ?? ''
        })
      });
      toast.success(`Suggestion ${newStatus.toLowerCase().replace('_', ' ')}`);
      await fetchSuggestions();
    } catch {
      toast.error('Failed to update suggestion');
    } finally {
      setActionLoading(null);
    }
  };

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  const pendingCount = suggestions.filter(
    (s) => s.status === 'PENDING_APPROVAL'
  ).length;
  const approvedCount = suggestions.filter(
    (s) => s.status === 'APPROVED'
  ).length;
  const appliedCount = suggestions.filter((s) => s.status === 'APPLIED').length;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:px-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>
            Optimization Queue
          </h1>
          <p className='text-muted-foreground text-sm'>
            AI-generated suggestions to improve conversation performance
          </p>
        </div>
        <Button onClick={handleRunAnalysis} disabled={analysisRunning}>
          {analysisRunning ? (
            <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
          ) : (
            <IconSparkles className='mr-2 h-4 w-4' />
          )}
          Run Analysis
        </Button>
      </div>

      <Separator />

      {/* Stats bar */}
      {!loading && suggestions.length > 0 && (
        <div className='grid grid-cols-3 gap-4'>
          <Card>
            <CardContent className='flex items-center gap-3 py-4'>
              <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-yellow-100 dark:bg-yellow-900/30'>
                <IconBulb className='h-5 w-5 text-yellow-600 dark:text-yellow-400' />
              </div>
              <div>
                <p className='text-2xl font-bold'>{pendingCount}</p>
                <p className='text-muted-foreground text-xs'>Pending</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className='flex items-center gap-3 py-4'>
              <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-900/30'>
                <IconCheck className='h-5 w-5 text-blue-600 dark:text-blue-400' />
              </div>
              <div>
                <p className='text-2xl font-bold'>{approvedCount}</p>
                <p className='text-muted-foreground text-xs'>Approved</p>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className='flex items-center gap-3 py-4'>
              <div className='flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 dark:bg-green-900/30'>
                <IconRocket className='h-5 w-5 text-green-600 dark:text-green-400' />
              </div>
              <div>
                <p className='text-2xl font-bold'>{appliedCount}</p>
                <p className='text-muted-foreground text-xs'>Applied</p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className='flex flex-col items-center justify-center py-16'>
          <IconLoader2 className='text-muted-foreground h-8 w-8 animate-spin' />
          <p className='text-muted-foreground mt-3 text-sm'>
            Loading optimizations...
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && suggestions.length === 0 && (
        <Card>
          <CardContent className='flex flex-col items-center justify-center py-16'>
            <IconBulb className='text-muted-foreground mb-4 h-12 w-12' />
            <h3 className='mb-1 text-lg font-semibold'>
              No optimization suggestions yet
            </h3>
            <p className='text-muted-foreground mb-2 max-w-md text-center text-sm'>
              Click &quot;Run Analysis&quot; to generate insights based on
              conversation performance data.
            </p>
            <p className='text-muted-foreground mb-4 text-xs'>
              Note: Requires a minimum number of conversations before meaningful
              suggestions can be generated.
            </p>
            <Button onClick={handleRunAnalysis} disabled={analysisRunning}>
              {analysisRunning ? (
                <IconLoader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : (
                <IconSparkles className='mr-2 h-4 w-4' />
              )}
              Run Analysis
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Suggestion list */}
      {!loading && suggestions.length > 0 && (
        <div className='grid gap-4'>
          {suggestions.map((suggestion) => {
            const isActionLoading = actionLoading === suggestion.id;
            const tBadge = typeBadge[suggestion.type];
            const sBadge = statusBadge[suggestion.status];

            return (
              <Card key={suggestion.id}>
                <CardHeader className='pb-3'>
                  <div className='flex items-start justify-between'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <Badge className={tBadge.className}>{tBadge.label}</Badge>
                      <Badge className={sBadge.className}>{sBadge.label}</Badge>
                    </div>
                    <CardDescription className='text-xs'>
                      {new Date(suggestion.created_at).toLocaleDateString()}
                    </CardDescription>
                  </div>
                </CardHeader>

                <CardContent className='space-y-4'>
                  {/* Reasoning */}
                  <p className='text-sm leading-relaxed'>
                    {suggestion.reasoning}
                  </p>

                  {/* Supporting data */}
                  <div className='bg-muted/50 grid grid-cols-3 gap-4 rounded-lg border p-3'>
                    <div className='text-center'>
                      <p className='text-lg font-bold'>
                        {suggestion.sample_size.toLocaleString()}
                      </p>
                      <p className='text-muted-foreground text-xs'>
                        Sample Size
                      </p>
                    </div>
                    <div className='text-center'>
                      <p className='text-lg font-bold'>
                        {(suggestion.confidence_level * 100).toFixed(0)}%
                      </p>
                      <p className='text-muted-foreground text-xs'>
                        Confidence
                      </p>
                    </div>
                    <div className='text-center'>
                      <p className='text-lg font-bold text-green-600 dark:text-green-400'>
                        +{(suggestion.expected_improvement * 100).toFixed(1)}%
                      </p>
                      <p className='text-muted-foreground text-xs'>
                        Expected Improvement
                      </p>
                    </div>
                  </div>

                  {/* Admin notes */}
                  <div className='grid gap-2'>
                    <Label
                      htmlFor={`notes-${suggestion.id}`}
                      className='text-xs'
                    >
                      Admin Notes
                    </Label>
                    <Textarea
                      id={`notes-${suggestion.id}`}
                      placeholder='Add notes about this suggestion...'
                      rows={2}
                      value={notesMap[suggestion.id] ?? ''}
                      onChange={(e) =>
                        setNotesMap((prev) => ({
                          ...prev,
                          [suggestion.id]: e.target.value
                        }))
                      }
                    />
                  </div>

                  {/* Action buttons */}
                  <div className='flex gap-2'>
                    {suggestion.status === 'PENDING_APPROVAL' && (
                      <>
                        <Button
                          size='sm'
                          onClick={() =>
                            updateStatus(suggestion.id, 'APPROVED')
                          }
                          disabled={isActionLoading}
                        >
                          {isActionLoading ? (
                            <IconLoader2 className='mr-1 h-3 w-3 animate-spin' />
                          ) : (
                            <IconCheck className='mr-1 h-3 w-3' />
                          )}
                          Approve
                        </Button>
                        <Button
                          variant='destructive'
                          size='sm'
                          onClick={() =>
                            updateStatus(suggestion.id, 'REJECTED')
                          }
                          disabled={isActionLoading}
                        >
                          {isActionLoading ? (
                            <IconLoader2 className='mr-1 h-3 w-3 animate-spin' />
                          ) : (
                            <IconX className='mr-1 h-3 w-3' />
                          )}
                          Reject
                        </Button>
                      </>
                    )}

                    {suggestion.status === 'APPROVED' && (
                      <Button
                        size='sm'
                        onClick={() => updateStatus(suggestion.id, 'APPLIED')}
                        disabled={isActionLoading}
                      >
                        {isActionLoading ? (
                          <IconLoader2 className='mr-1 h-3 w-3 animate-spin' />
                        ) : (
                          <IconRocket className='mr-1 h-3 w-3' />
                        )}
                        Apply
                      </Button>
                    )}

                    {suggestion.status === 'APPLIED' && (
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => updateStatus(suggestion.id, 'REVERTED')}
                        disabled={isActionLoading}
                      >
                        {isActionLoading ? (
                          <IconLoader2 className='mr-1 h-3 w-3 animate-spin' />
                        ) : (
                          <IconArrowBackUp className='mr-1 h-3 w-3' />
                        )}
                        Revert
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
