'use client';

import { useState } from 'react';
import {
  IconPlus,
  IconTrash,
  IconArrowsShuffle,
  IconBrain,
  IconMessageCircle
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { allStages } from '@/features/shared/lead-stage-badge';
import ChipSelector from './chip-selector';
import type {
  VoiceNoteTrigger,
  StageTransitionTrigger,
  ContentIntentTrigger,
  ConversationalMoveTrigger
} from '@/lib/voice-note-triggers';
import {
  CONTENT_INTENTS,
  CONTENT_INTENT_LABELS,
  generateTriggerDescription
} from '@/lib/voice-note-triggers';

// ---------------------------------------------------------------------------
// Stage options for dropdowns
// ---------------------------------------------------------------------------

const STAGE_OPTIONS = allStages.map((s) => ({
  value: s.value.toUpperCase(),
  label: s.label
}));

const FROM_STAGE_OPTIONS = [
  { value: 'any', label: 'Any Stage' },
  ...STAGE_OPTIONS
];

// ---------------------------------------------------------------------------
// Default triggers for each type
// ---------------------------------------------------------------------------

function defaultStageTransition(): StageTransitionTrigger {
  return { type: 'stage_transition', from_stage: 'any', to_stage: 'NEW_LEAD' };
}

function defaultContentIntent(): ContentIntentTrigger {
  return { type: 'content_intent', intent: 'price_objection' };
}

function defaultConversationalMove(): ConversationalMoveTrigger {
  return {
    type: 'conversational_move',
    suggested_moments: [],
    required_pipeline_stages: [],
    cooldown: { type: 'messages', value: 5 }
  };
}

// ---------------------------------------------------------------------------
// Stage Transition Card
// ---------------------------------------------------------------------------

function StageTransitionCard({
  trigger,
  onChange,
  onRemove
}: {
  trigger: StageTransitionTrigger;
  onChange: (t: StageTransitionTrigger) => void;
  onRemove: () => void;
}) {
  return (
    <Card className='border-l-4 border-l-blue-400'>
      <CardContent className='space-y-3 pt-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <IconArrowsShuffle className='h-4 w-4 text-blue-500' />
            <span className='text-sm font-medium'>Stage Transition</span>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={onRemove}
            className='h-7 w-7 p-0'
          >
            <IconTrash className='h-3.5 w-3.5' />
          </Button>
        </div>

        <div className='grid gap-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label className='text-xs'>From Stage</Label>
            <Select
              value={trigger.from_stage}
              onValueChange={(v) => onChange({ ...trigger, from_stage: v })}
            >
              <SelectTrigger className='h-8 text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FROM_STAGE_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label className='text-xs'>To Stage</Label>
            <Select
              value={trigger.to_stage}
              onValueChange={(v) => onChange({ ...trigger, to_stage: v })}
            >
              <SelectTrigger className='h-8 text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className='text-muted-foreground text-xs italic'>
          Fires when a lead moves from{' '}
          {trigger.from_stage === 'any'
            ? 'any stage'
            : (FROM_STAGE_OPTIONS.find((s) => s.value === trigger.from_stage)
                ?.label ?? trigger.from_stage)}{' '}
          →{' '}
          {STAGE_OPTIONS.find((s) => s.value === trigger.to_stage)?.label ??
            trigger.to_stage}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Content Intent Card
// ---------------------------------------------------------------------------

function ContentIntentCard({
  trigger,
  onChange,
  onRemove
}: {
  trigger: ContentIntentTrigger;
  onChange: (t: ContentIntentTrigger) => void;
  onRemove: () => void;
}) {
  return (
    <Card className='border-l-4 border-l-amber-400'>
      <CardContent className='space-y-3 pt-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <IconBrain className='h-4 w-4 text-amber-500' />
            <span className='text-sm font-medium'>Content Intent</span>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={onRemove}
            className='h-7 w-7 p-0'
          >
            <IconTrash className='h-3.5 w-3.5' />
          </Button>
        </div>

        <div className='space-y-1.5'>
          <Label className='text-xs'>Detected Intent</Label>
          <Select
            value={trigger.intent}
            onValueChange={(v) =>
              onChange({
                ...trigger,
                intent: v as (typeof CONTENT_INTENTS)[number]
              })
            }
          >
            <SelectTrigger className='h-8 text-xs'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTENT_INTENTS.map((intent) => (
                <SelectItem key={intent} value={intent}>
                  {CONTENT_INTENT_LABELS[intent]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className='text-muted-foreground text-xs italic'>
          Fires when the lead&apos;s message expresses{' '}
          {CONTENT_INTENT_LABELS[trigger.intent]}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Conversational Move Card
// ---------------------------------------------------------------------------

function ConversationalMoveCard({
  trigger,
  onChange,
  onRemove
}: {
  trigger: ConversationalMoveTrigger;
  onChange: (t: ConversationalMoveTrigger) => void;
  onRemove: () => void;
}) {
  // Convert suggested_moments between string[] and textarea text
  const momentsText = trigger.suggested_moments.join('\n');

  const stageSuggestions = STAGE_OPTIONS.map((s) => s.value);

  return (
    <Card className='border-l-4 border-l-green-400'>
      <CardContent className='space-y-3 pt-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <IconMessageCircle className='h-4 w-4 text-green-500' />
            <span className='text-sm font-medium'>Conversational Move</span>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            onClick={onRemove}
            className='h-7 w-7 p-0'
          >
            <IconTrash className='h-3.5 w-3.5' />
          </Button>
        </div>

        {/* Suggested moments */}
        <div className='space-y-1.5'>
          <Label className='text-xs'>Suggested Moments</Label>
          <Textarea
            value={momentsText}
            onChange={(e) =>
              onChange({
                ...trigger,
                suggested_moments: e.target.value
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
              })
            }
            rows={3}
            placeholder={
              "One moment per line, e.g.:\nlead is engaged but hasn't seen proof yet\nlead expressed doubt about results"
            }
          />
          <p className='text-muted-foreground text-[10px]'>
            Describe when the AI should consider sending this voice note. One
            description per line.
          </p>
        </div>

        {/* Required pipeline stages */}
        <div className='space-y-1.5'>
          <Label className='text-xs'>Required Pipeline Stages</Label>
          <ChipSelector
            suggestions={stageSuggestions}
            selected={trigger.required_pipeline_stages}
            onChange={(stages) =>
              onChange({ ...trigger, required_pipeline_stages: stages })
            }
            allowCustom={false}
            placeholder='Add stage...'
          />
          <p className='text-muted-foreground text-[10px]'>
            Voice note can only fire when the lead is in one of these stages.
          </p>
        </div>

        {/* Cooldown */}
        <div className='space-y-1.5'>
          <Label className='text-xs'>Cooldown</Label>
          <div className='flex items-center gap-2'>
            <Select
              value={trigger.cooldown.type}
              onValueChange={(v) =>
                onChange({
                  ...trigger,
                  cooldown: {
                    ...trigger.cooldown,
                    type: v as 'messages' | 'conversation' | 'time'
                  }
                })
              }
            >
              <SelectTrigger className='h-8 w-[160px] text-xs'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='messages'>Messages</SelectItem>
                <SelectItem value='conversation'>Per Conversation</SelectItem>
                <SelectItem value='time'>Time (seconds)</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type='number'
              min={1}
              value={trigger.cooldown.value}
              onChange={(e) =>
                onChange({
                  ...trigger,
                  cooldown: {
                    ...trigger.cooldown,
                    value: Math.max(1, parseInt(e.target.value) || 1)
                  }
                })
              }
              className='h-8 w-20 text-xs'
            />
          </div>
          <p className='text-muted-foreground text-[10px]'>
            {trigger.cooldown.type === 'messages' &&
              `Wait at least ${trigger.cooldown.value} messages before sending again.`}
            {trigger.cooldown.type === 'conversation' &&
              `Send at most ${trigger.cooldown.value} time(s) per conversation.`}
            {trigger.cooldown.type === 'time' &&
              `Wait at least ${trigger.cooldown.value} seconds before sending again.`}
          </p>
        </div>

        <p className='text-muted-foreground text-xs italic'>
          Fires when AI judges the moment is right
          {trigger.suggested_moments.length > 0
            ? ` for "${trigger.suggested_moments[0]}"`
            : ''}
          {trigger.required_pipeline_stages.length > 0
            ? `, only in ${trigger.required_pipeline_stages.map((s) => STAGE_OPTIONS.find((o) => o.value === s)?.label ?? s).join(', ')}`
            : ''}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// TriggerBuilder — main export
// ---------------------------------------------------------------------------

interface TriggerBuilderProps {
  triggers: VoiceNoteTrigger[];
  onChange: (triggers: VoiceNoteTrigger[]) => void;
  legacyText?: string | null;
}

export default function TriggerBuilder({
  triggers,
  onChange,
  legacyText
}: TriggerBuilderProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  function addTrigger(type: VoiceNoteTrigger['type']) {
    let newTrigger: VoiceNoteTrigger;
    switch (type) {
      case 'stage_transition':
        newTrigger = defaultStageTransition();
        break;
      case 'content_intent':
        newTrigger = defaultContentIntent();
        break;
      case 'conversational_move':
        newTrigger = defaultConversationalMove();
        break;
    }
    onChange([...triggers, newTrigger]);
    setMenuOpen(false);
  }

  function updateTrigger(index: number, updated: VoiceNoteTrigger) {
    const next = [...triggers];
    next[index] = updated;
    onChange(next);
  }

  function removeTrigger(index: number) {
    onChange(triggers.filter((_, i) => i !== index));
  }

  const description = generateTriggerDescription(triggers);

  return (
    <div className='space-y-3'>
      <Label>Triggers</Label>

      {/* Legacy text reference */}
      {legacyText && (
        <div className='bg-muted rounded-md border border-dashed p-3'>
          <p className='text-muted-foreground text-xs font-medium'>
            Original trigger text:
          </p>
          <p className='text-muted-foreground mt-1 text-xs'>{legacyText}</p>
        </div>
      )}

      {/* Trigger cards */}
      {triggers.length === 0 ? (
        <div className='text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs'>
          No triggers configured. This voice note will only be matched via
          metadata (use cases, lead types, etc).
        </div>
      ) : (
        <div className='space-y-2'>
          {triggers.map((trigger, i) => {
            switch (trigger.type) {
              case 'stage_transition':
                return (
                  <StageTransitionCard
                    key={`st-${i}`}
                    trigger={trigger}
                    onChange={(t) => updateTrigger(i, t)}
                    onRemove={() => removeTrigger(i)}
                  />
                );
              case 'content_intent':
                return (
                  <ContentIntentCard
                    key={`ci-${i}`}
                    trigger={trigger}
                    onChange={(t) => updateTrigger(i, t)}
                    onRemove={() => removeTrigger(i)}
                  />
                );
              case 'conversational_move':
                return (
                  <ConversationalMoveCard
                    key={`cm-${i}`}
                    trigger={trigger}
                    onChange={(t) => updateTrigger(i, t)}
                    onRemove={() => removeTrigger(i)}
                  />
                );
            }
          })}
        </div>
      )}

      {/* Add Trigger button */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button type='button' variant='outline' size='sm'>
            <IconPlus className='mr-1.5 h-3.5 w-3.5' />
            Add Trigger
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start'>
          <DropdownMenuItem onClick={() => addTrigger('stage_transition')}>
            <IconArrowsShuffle className='mr-2 h-4 w-4 text-blue-500' />
            Stage Transition
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => addTrigger('content_intent')}>
            <IconBrain className='mr-2 h-4 w-4 text-amber-500' />
            Content Intent
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => addTrigger('conversational_move')}>
            <IconMessageCircle className='mr-2 h-4 w-4 text-green-500' />
            Conversational Move
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Auto-generated description */}
      {description && (
        <div className='bg-muted/50 rounded-md p-3'>
          <p className='text-muted-foreground text-xs'>{description}</p>
        </div>
      )}

      <p className='text-muted-foreground text-[10px]'>
        Voice note fires if ANY trigger matches. Triggers are checked at every
        message.
      </p>
    </div>
  );
}
