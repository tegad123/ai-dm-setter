'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import {
  IconArrowLeft,
  IconMessageCircle,
  IconArrowRight
} from '@tabler/icons-react';
import { toast } from 'sonner';
import { LeadStageBadge, allStages } from '@/features/shared/lead-stage-badge';
import type { LeadStage } from '@/features/shared/lead-stage-badge';
import { PlatformIcon } from '@/features/shared/platform-icon';
import { TagBadge } from '@/features/tags/components/tag-badge';
import { useLeadStageHistory } from '@/hooks/use-api';
import { transitionLeadStage, apiFetch } from '@/lib/api';

interface LeadData {
  id: string;
  name: string;
  handle: string;
  platform: string;
  stage: string;
  previousStage?: string | null;
  stageEnteredAt?: string;
  qualityScore: number;
  triggerType: string;
  bookedAt?: string | null;
  revenue?: number | null;
  tags?: Array<{ tag: { id: string; name: string; color: string } }>;
  createdAt: string;
}

// Stage-specific primary action buttons
const STAGE_ACTIONS: Record<string, { label: string; stage: string }[]> = {
  BOOKED: [
    { label: 'Mark as Showed', stage: 'SHOWED' },
    { label: 'Mark as No-Showed', stage: 'NO_SHOWED' },
    { label: 'Mark as Rescheduled', stage: 'RESCHEDULED' }
  ],
  SHOWED: [
    { label: 'Closed Won', stage: 'CLOSED_WON' },
    { label: 'Closed Lost', stage: 'CLOSED_LOST' }
  ]
};

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export default function LeadDetail({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [lead, setLead] = useState<LeadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState(false);
  const [overrideStage, setOverrideStage] = useState('');
  const { transitions, refetch: refetchHistory } = useLeadStageHistory(leadId);

  const fetchLead = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/leads/${leadId}`);
      setLead(data.lead ?? data);
    } catch {
      toast.error('Failed to load lead');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    fetchLead();
  }, [fetchLead]);

  const handleTransition = useCallback(
    async (stage: string, reason?: string) => {
      if (transitioning) return;
      setTransitioning(true);
      try {
        await transitionLeadStage(leadId, stage, reason);
        toast.success(`Stage updated to ${stage.replace(/_/g, ' ')}`);
        await fetchLead();
        refetchHistory();
      } catch {
        toast.error('Failed to update stage');
      } finally {
        setTransitioning(false);
      }
    },
    [leadId, transitioning, fetchLead, refetchHistory]
  );

  if (loading) {
    return (
      <div className='text-muted-foreground py-12 text-center text-sm'>
        Loading lead...
      </div>
    );
  }

  if (!lead) {
    return (
      <div className='text-muted-foreground py-12 text-center text-sm'>
        Lead not found.
      </div>
    );
  }

  const stageKey = lead.stage.toLowerCase() as LeadStage;
  const primaryActions = STAGE_ACTIONS[lead.stage.toUpperCase()] ?? [];

  return (
    <div className='space-y-6'>
      {/* Back link */}
      <Button
        variant='ghost'
        size='sm'
        onClick={() => router.push('/dashboard/leads')}
      >
        <IconArrowLeft className='mr-1 h-4 w-4' />
        Back to Leads
      </Button>

      {/* Header */}
      <div className='flex items-start justify-between'>
        <div className='space-y-1'>
          <div className='flex items-center gap-3'>
            <h1 className='text-2xl font-bold'>{lead.name}</h1>
            <PlatformIcon
              platform={lead.platform.toLowerCase() as 'instagram' | 'facebook'}
            />
          </div>
          <p className='text-muted-foreground text-sm'>@{lead.handle}</p>
        </div>
        <div className='flex flex-col items-end gap-1'>
          <LeadStageBadge stage={stageKey} />
          {lead.stageEnteredAt && (
            <span className='text-muted-foreground text-xs'>
              {timeAgo(lead.stageEnteredAt)} in this stage
            </span>
          )}
        </div>
      </div>

      {/* Stage Actions */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Stage Actions</CardTitle>
        </CardHeader>
        <CardContent className='space-y-4'>
          {/* Primary actions */}
          {primaryActions.length > 0 && (
            <div className='flex flex-wrap gap-2'>
              {primaryActions.map((action) => (
                <Button
                  key={action.stage}
                  size='sm'
                  disabled={transitioning}
                  onClick={() => handleTransition(action.stage)}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          )}

          {/* Secondary: Nurture + Manual Override */}
          <div className='flex flex-wrap items-center gap-2'>
            {lead.stage.toUpperCase() !== 'NURTURE' && (
              <Button
                variant='outline'
                size='sm'
                disabled={transitioning}
                onClick={() => handleTransition('NURTURE', 'Moved to nurture')}
              >
                Move to Nurture
              </Button>
            )}
            <div className='flex items-center gap-2'>
              <Select value={overrideStage} onValueChange={setOverrideStage}>
                <SelectTrigger className='w-[180px]'>
                  <SelectValue placeholder='Manual override...' />
                </SelectTrigger>
                <SelectContent>
                  {allStages
                    .filter((s) => s.value !== stageKey)
                    .map((s) => (
                      <SelectItem key={s.value} value={s.value.toUpperCase()}>
                        {s.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Button
                variant='outline'
                size='sm'
                disabled={transitioning || !overrideStage}
                onClick={() => {
                  if (overrideStage) {
                    handleTransition(overrideStage, 'Manual override');
                    setOverrideStage('');
                  }
                }}
              >
                Apply
              </Button>
            </div>
          </div>

          {primaryActions.length === 0 &&
            lead.stage.toUpperCase() === 'NURTURE' && (
              <p className='text-muted-foreground text-sm'>
                Use the manual override dropdown to change this lead&apos;s
                stage.
              </p>
            )}
        </CardContent>
      </Card>

      {/* Stage History */}
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Stage History</CardTitle>
        </CardHeader>
        <CardContent>
          {!transitions || transitions.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              No stage transitions yet.
            </p>
          ) : (
            <div className='space-y-3'>
              {transitions.map(
                (t: {
                  id: string;
                  fromStage: string;
                  toStage: string;
                  transitionedBy: string;
                  reason?: string | null;
                  createdAt: string;
                }) => (
                  <div key={t.id} className='flex items-center gap-2 text-sm'>
                    <LeadStageBadge
                      stage={t.fromStage.toLowerCase() as LeadStage}
                    />
                    <IconArrowRight className='text-muted-foreground h-3 w-3 shrink-0' />
                    <LeadStageBadge
                      stage={t.toStage.toLowerCase() as LeadStage}
                    />
                    <span className='text-muted-foreground text-xs'>
                      by {t.transitionedBy}
                    </span>
                    {t.reason && (
                      <span className='text-muted-foreground truncate text-xs italic'>
                        — {t.reason}
                      </span>
                    )}
                    <span className='text-muted-foreground ml-auto shrink-0 text-xs'>
                      {new Date(t.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info Grid */}
      <div className='grid grid-cols-2 gap-4 md:grid-cols-4'>
        <Card>
          <CardContent className='pt-4'>
            <p className='text-muted-foreground mb-1 text-xs'>Quality Score</p>
            <div className='flex items-center gap-2'>
              <Progress value={lead.qualityScore} className='h-2 flex-1' />
              <span className='text-sm font-medium'>{lead.qualityScore}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='pt-4'>
            <p className='text-muted-foreground mb-1 text-xs'>Trigger</p>
            <Badge variant='outline' className='capitalize'>
              {lead.triggerType === 'DM' ? 'DM' : 'Comment'}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='pt-4'>
            <p className='text-muted-foreground mb-1 text-xs'>Booked At</p>
            <p className='text-sm'>
              {lead.bookedAt
                ? new Date(lead.bookedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })
                : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className='pt-4'>
            <p className='text-muted-foreground mb-1 text-xs'>Revenue</p>
            <p className='text-sm'>
              {lead.revenue ? (
                <span className='font-medium text-emerald-600'>
                  ${lead.revenue.toLocaleString()}
                </span>
              ) : (
                '—'
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tags */}
      {lead.tags && lead.tags.length > 0 && (
        <Card>
          <CardContent className='flex flex-wrap gap-1 pt-4'>
            {lead.tags.map((lt) => (
              <TagBadge
                key={lt.tag.id}
                name={lt.tag.name}
                color={lt.tag.color}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Link to conversation */}
      <Button
        variant='outline'
        onClick={() => router.push('/dashboard/conversations')}
      >
        <IconMessageCircle className='mr-2 h-4 w-4' />
        Open Conversations
      </Button>
    </div>
  );
}
