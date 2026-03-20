'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiveConversation {
  id: string;
  anonymousId: string;
  platform: 'instagram' | 'facebook';
  stage: string;
  intentTag: 'HIGH_INTENT' | 'RESISTANT' | 'NEUTRAL' | 'UNQUALIFIED';
  messageCount: number;
  durationSeconds: number;
  velocityScore: number;
}

interface LiveConversationsResponse {
  conversations: LiveConversation[];
  totalActive: number;
  avgVelocity: number;
  flaggedCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

const STAGE_COLORS: Record<string, string> = {
  greeting: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  qualifying:
    'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  pitching:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300',
  objection_handling:
    'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
  booking:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300',
  follow_up:
    'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  closed: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  lost: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
};

const INTENT_STYLES: Record<
  LiveConversation['intentTag'],
  { className: string; label: string }
> = {
  HIGH_INTENT: {
    className:
      'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
    label: 'High Intent'
  },
  RESISTANT: {
    className: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
    label: 'Resistant'
  },
  NEUTRAL: {
    className: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300',
    label: 'Neutral'
  },
  UNQUALIFIED: {
    className:
      'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
    label: 'Unqualified'
  }
};

const PLATFORM_STYLES: Record<string, string> = {
  instagram: 'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300',
  facebook: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
};

function VelocityIndicator({ score }: { score: number }) {
  if (score > 1.5) {
    return (
      <span className='font-medium text-green-600 dark:text-green-400'>
        ⚡ Fast
      </span>
    );
  }
  if (score >= 0.8) {
    return <span className='text-muted-foreground font-medium'>Normal</span>;
  }
  if (score >= 0.3) {
    return (
      <span className='font-medium text-yellow-600 dark:text-yellow-400'>
        🐢 Slow
      </span>
    );
  }
  return (
    <span className='font-medium text-red-600 dark:text-red-400'>🐢 Slow</span>
  );
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function LiveConversationsPage() {
  const [conversations, setConversations] = useState<LiveConversation[]>([]);
  const [totalActive, setTotalActive] = useState(0);
  const [avgVelocity, setAvgVelocity] = useState(0);
  const [flaggedCount, setFlaggedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const data = await apiFetch<LiveConversationsResponse>(
        '/analytics/live-conversations'
      );
      setConversations(data.conversations);
      setTotalActive(data.totalActive);
      setAvgVelocity(data.avgVelocity);
      setFlaggedCount(data.flaggedCount);
      setLastRefresh(new Date());
    } catch {
      toast.error('Failed to load live conversations');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Auto-refresh interval
  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchData, REFRESH_INTERVAL_MS);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, fetchData]);

  // ------ Loading state ------
  if (loading) {
    return (
      <div className='flex flex-1 flex-col items-center justify-center gap-3 p-8'>
        <div className='border-primary h-8 w-8 animate-spin rounded-full border-4 border-t-transparent' />
        <p className='text-muted-foreground text-sm'>
          Loading live conversations...
        </p>
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:px-6'>
      {/* ---- Header ---- */}
      <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h1 className='text-2xl font-bold tracking-tight'>
            Live Conversations
          </h1>
          {lastRefresh && (
            <p className='text-muted-foreground mt-1 text-sm'>
              Last updated {formatTimestamp(lastRefresh)}
            </p>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <Switch
            id='auto-refresh'
            checked={autoRefresh}
            onCheckedChange={setAutoRefresh}
          />
          <Label htmlFor='auto-refresh' className='text-sm'>
            Auto-refresh
          </Label>
        </div>
      </div>

      {/* ---- Summary Bar ---- */}
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-muted-foreground text-sm font-medium'>
              Active Conversations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-2xl font-bold'>{totalActive}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-muted-foreground text-sm font-medium'>
              Avg Velocity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-2xl font-bold'>{avgVelocity.toFixed(2)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className='pb-2'>
            <CardTitle className='text-muted-foreground text-sm font-medium'>
              Flagged for Review
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className='text-2xl font-bold text-red-600 dark:text-red-400'>
              {flaggedCount}
            </p>
          </CardContent>
        </Card>
      </div>

      <Separator />

      {/* ---- Conversation List or Empty State ---- */}
      {conversations.length === 0 ? (
        <Card>
          <CardContent className='flex flex-col items-center justify-center py-16'>
            <p className='text-muted-foreground text-lg font-medium'>
              No active conversations right now
            </p>
            <p className='text-muted-foreground mt-2 text-sm'>
              Active conversations will appear here when leads are being engaged
              via Instagram or Facebook DMs.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className='flex flex-col gap-4'>
          {conversations.map((convo) => {
            const stageClass =
              STAGE_COLORS[convo.stage] ??
              'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
            const intent = INTENT_STYLES[convo.intentTag];
            const platformClass =
              PLATFORM_STYLES[convo.platform] ??
              'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300';
            const isFlagged = convo.velocityScore < 0.3;

            return (
              <Card key={convo.id}>
                <CardContent className='flex flex-col gap-3 p-4 sm:p-6'>
                  {/* Row 1: Identifier + badges */}
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='font-semibold'>
                      Lead #{convo.anonymousId}
                    </span>

                    <Badge variant='outline' className={platformClass}>
                      {convo.platform === 'instagram'
                        ? 'Instagram'
                        : 'Facebook'}
                    </Badge>

                    <Badge variant='outline' className={stageClass}>
                      {convo.stage.replace(/_/g, ' ')}
                    </Badge>

                    <Badge variant='outline' className={intent.className}>
                      {intent.label}
                    </Badge>

                    {isFlagged && (
                      <Badge variant='destructive' className='ml-auto sm:ml-0'>
                        ⚠ Flagged for review
                      </Badge>
                    )}
                  </div>

                  {/* Row 2: Stats */}
                  <div className='text-muted-foreground flex flex-wrap items-center gap-4 text-sm'>
                    <span>
                      Messages:{' '}
                      <span className='text-foreground font-medium'>
                        {convo.messageCount}
                      </span>
                    </span>
                    <span>
                      Duration:{' '}
                      <span className='text-foreground font-medium'>
                        {formatDuration(convo.durationSeconds)}
                      </span>
                    </span>
                    <span>
                      Velocity:{' '}
                      <VelocityIndicator score={convo.velocityScore} />
                      <span className='text-muted-foreground ml-1'>
                        ({convo.velocityScore.toFixed(2)})
                      </span>
                    </span>
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
