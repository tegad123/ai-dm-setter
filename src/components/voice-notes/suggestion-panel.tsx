'use client';

import { useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, CheckCircle2, Pencil, X, Loader2 } from 'lucide-react';
import type { VoiceNoteTrigger } from '@/lib/voice-note-triggers';
import { generateTriggerDescription } from '@/lib/voice-note-triggers';
import { respondToSuggestion } from '@/lib/api';
import { toast } from 'sonner';

interface SuggestionPanelProps {
  voiceNoteId: string;
  triggers: VoiceNoteTrigger[];
  status: string | null;
  onApproved: (triggers: VoiceNoteTrigger[]) => void;
  onRejected: () => void;
  onEditRequested: () => void;
}

function TriggerSummaryItem({ trigger }: { trigger: VoiceNoteTrigger }) {
  if (trigger.type === 'stage_transition') {
    return (
      <div className='flex items-center gap-2 text-sm'>
        <Badge variant='outline' className='text-xs'>
          Stage
        </Badge>
        <span>
          {trigger.from_stage === 'any' ? 'Any' : trigger.from_stage}
          {' \u2192 '}
          {trigger.to_stage}
        </span>
      </div>
    );
  }

  if (trigger.type === 'content_intent') {
    return (
      <div className='flex items-center gap-2 text-sm'>
        <Badge variant='outline' className='text-xs'>
          Intent
        </Badge>
        <span>{trigger.intent.replace(/_/g, ' ')}</span>
      </div>
    );
  }

  if (trigger.type === 'conversational_move') {
    return (
      <div className='flex items-center gap-2 text-sm'>
        <Badge variant='outline' className='text-xs'>
          Move
        </Badge>
        <span>
          {trigger.suggested_moments?.join(', ').replace(/_/g, ' ') ||
            'Conversational moment'}
        </span>
      </div>
    );
  }

  return null;
}

export default function SuggestionPanel({
  voiceNoteId,
  triggers,
  status,
  onApproved,
  onRejected,
  onEditRequested
}: SuggestionPanelProps) {
  const [loading, setLoading] = useState<string | null>(null);

  if (status !== 'pending' || !triggers || triggers.length === 0) {
    return null;
  }

  const description = generateTriggerDescription(triggers);

  async function handleApprove() {
    setLoading('approve');
    try {
      await respondToSuggestion(voiceNoteId, 'approve');
      onApproved(triggers);
      toast.success('Triggers approved from AI suggestion');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to approve suggestions'
      );
    } finally {
      setLoading(null);
    }
  }

  async function handleReject() {
    setLoading('reject');
    try {
      await respondToSuggestion(voiceNoteId, 'reject');
      onRejected();
      toast.success('Suggestions skipped');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to skip suggestions'
      );
    } finally {
      setLoading(null);
    }
  }

  return (
    <Card className='border-purple-200 bg-purple-50 dark:border-purple-800 dark:bg-purple-950/30'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-2'>
          <Sparkles className='h-4 w-4 text-purple-600' />
          <CardTitle className='text-base'>AI-Suggested Triggers</CardTitle>
        </div>
        <CardDescription>
          Our AI analyzed this voice note and suggested triggers for when it
          should be sent. Review and approve, edit, or skip.
        </CardDescription>
      </CardHeader>
      <CardContent className='space-y-4'>
        {/* Trigger summary */}
        <div className='space-y-2 rounded-md border bg-white p-3 dark:bg-black'>
          <p className='text-muted-foreground text-xs font-medium uppercase'>
            Suggested Triggers ({triggers.length})
          </p>
          <div className='space-y-1.5'>
            {triggers.map((trigger, i) => (
              <TriggerSummaryItem key={i} trigger={trigger} />
            ))}
          </div>
          {description && (
            <p className='text-muted-foreground mt-2 border-t pt-2 text-xs italic'>
              {description}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div className='flex gap-2'>
          <Button
            size='sm'
            onClick={handleApprove}
            disabled={loading !== null}
            className='bg-purple-600 hover:bg-purple-700'
          >
            {loading === 'approve' ? (
              <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
            ) : (
              <CheckCircle2 className='mr-1.5 h-4 w-4' />
            )}
            Approve
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={onEditRequested}
            disabled={loading !== null}
          >
            <Pencil className='mr-1.5 h-4 w-4' />
            Edit
          </Button>
          <Button
            variant='ghost'
            size='sm'
            onClick={handleReject}
            disabled={loading !== null}
          >
            {loading === 'reject' ? (
              <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
            ) : (
              <X className='mr-1.5 h-4 w-4' />
            )}
            Skip
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
