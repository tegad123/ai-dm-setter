'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  GripVertical,
  Trash2,
  Clock,
  MessageSquare,
  AlertCircle,
  Check
} from 'lucide-react';
import { cn } from '@/lib/utils';
import ActionTypeSelector from './action-type-selector';
import VoiceNotePickerInline from './voice-note-picker-inline';
import FormReferenceSelector from './form-reference-selector';
import { updateAction, deleteAction } from '@/lib/api';
import { SCRIPT_ACTION_TYPE_LABELS } from '@/lib/script-types';
import type {
  ScriptAction,
  ScriptActionType,
  ScriptForm
} from '@/lib/script-types';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ActionCardProps {
  action: ScriptAction;
  scriptId: string;
  forms: ScriptForm[];
  onUpdate: (action: ScriptAction) => void;
  onDelete: (actionId: string) => void;
}

export default function ActionCard({
  action,
  scriptId,
  forms,
  onUpdate,
  onDelete
}: ActionCardProps) {
  const [saving, setSaving] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: action.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const handleFieldSave = useCallback(
    async (field: string, value: any) => {
      setSaving(true);
      try {
        // When user edits any content field, also mark as confirmed
        const extra: Record<string, any> = {};
        if (
          field !== 'userConfirmed' &&
          field !== 'parserStatus' &&
          action.parserConfidence &&
          !action.userConfirmed
        ) {
          extra.userConfirmed = true;
          extra.parserStatus = null;
        }

        const result = await updateAction(scriptId, action.id, {
          [field]: value,
          ...extra
        });
        onUpdate({ ...action, ...result });
      } catch (err) {
        toast.error('Failed to save');
      } finally {
        setSaving(false);
      }
    },
    [scriptId, action, onUpdate]
  );

  const handleTypeChange = async (newType: ScriptActionType) => {
    await handleFieldSave('actionType', newType);
  };

  const handleDeleteAction = async () => {
    try {
      await deleteAction(scriptId, action.id);
      onDelete(action.id);
    } catch (err) {
      toast.error('Failed to delete action');
    }
  };

  // Render type-specific fields
  const renderFields = () => {
    switch (action.actionType) {
      case 'send_message':
      case 'ask_question':
        return (
          <Textarea
            defaultValue={action.content || ''}
            placeholder={
              action.actionType === 'ask_question'
                ? 'Enter the question to ask...'
                : 'Enter the message to send...'
            }
            onBlur={(e) => {
              if (e.target.value !== (action.content || '')) {
                handleFieldSave('content', e.target.value);
              }
            }}
            className='min-h-[60px] text-sm'
          />
        );

      case 'send_voice_note':
        return (
          <div className='space-y-2'>
            {action.content && (
              <p className='text-muted-foreground text-xs italic'>
                {action.content}
              </p>
            )}
            <VoiceNotePickerInline
              value={action.voiceNoteId}
              onChange={(id) => handleFieldSave('voiceNoteId', id)}
            />
          </div>
        );

      case 'send_link':
      case 'send_video':
        return (
          <div className='space-y-2'>
            <Textarea
              defaultValue={action.content || ''}
              placeholder='Context message to send with the link...'
              onBlur={(e) => {
                if (e.target.value !== (action.content || '')) {
                  handleFieldSave('content', e.target.value);
                }
              }}
              className='min-h-[40px] text-sm'
            />
            <div className='grid grid-cols-2 gap-2'>
              <div>
                <Label className='text-xs'>URL</Label>
                <Input
                  defaultValue={action.linkUrl || ''}
                  placeholder='https://...'
                  onBlur={(e) => {
                    if (e.target.value !== (action.linkUrl || '')) {
                      handleFieldSave('linkUrl', e.target.value);
                    }
                  }}
                  className='text-sm'
                />
              </div>
              <div>
                <Label className='text-xs'>Label</Label>
                <Input
                  defaultValue={action.linkLabel || ''}
                  placeholder='Link label'
                  onBlur={(e) => {
                    if (e.target.value !== (action.linkLabel || '')) {
                      handleFieldSave('linkLabel', e.target.value);
                    }
                  }}
                  className='text-sm'
                />
              </div>
            </div>
          </div>
        );

      case 'form_reference':
        return (
          <div className='space-y-2'>
            <Textarea
              defaultValue={action.content || ''}
              placeholder='Context for when this form should be referenced...'
              onBlur={(e) => {
                if (e.target.value !== (action.content || '')) {
                  handleFieldSave('content', e.target.value);
                }
              }}
              className='min-h-[40px] text-sm'
            />
            <FormReferenceSelector
              forms={forms}
              value={action.formId}
              onChange={(id) => handleFieldSave('formId', id)}
            />
          </div>
        );

      case 'runtime_judgment':
        return (
          <Textarea
            defaultValue={action.content || ''}
            placeholder='Describe when and how the AI should use its judgment...'
            onBlur={(e) => {
              if (e.target.value !== (action.content || '')) {
                handleFieldSave('content', e.target.value);
              }
            }}
            className='min-h-[60px] text-sm'
          />
        );

      case 'wait_for_response':
        return (
          <div className='flex items-center gap-2 py-1'>
            <Clock className='text-muted-foreground h-4 w-4' />
            <span className='text-muted-foreground text-sm'>
              Wait for the lead to respond before continuing
            </span>
          </div>
        );

      case 'wait_duration':
        return (
          <div className='flex items-center gap-2'>
            <Label className='text-xs'>Wait (seconds):</Label>
            <Input
              type='number'
              defaultValue={action.waitDuration || 0}
              onBlur={(e) => {
                const val = parseInt(e.target.value) || 0;
                if (val !== (action.waitDuration || 0)) {
                  handleFieldSave('waitDuration', val);
                }
              }}
              className='w-24 text-sm'
            />
          </div>
        );

      default:
        return null;
    }
  };

  const typeColor: Record<string, string> = {
    send_message: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
    ask_question: 'bg-purple-500/10 text-purple-700 dark:text-purple-400',
    send_voice_note: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
    send_link: 'bg-green-500/10 text-green-700 dark:text-green-400',
    send_video: 'bg-green-500/10 text-green-700 dark:text-green-400',
    form_reference: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    runtime_judgment: 'bg-pink-500/10 text-pink-700 dark:text-pink-400',
    wait_for_response: 'bg-gray-500/10 text-gray-700 dark:text-gray-400',
    wait_duration: 'bg-gray-500/10 text-gray-700 dark:text-gray-400'
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('border-border bg-card rounded border p-3', {
        'border-amber-400/60 bg-amber-500/5':
          action.parserStatus === 'needs_review' ||
          action.parserStatus === 'needs_user_input'
      })}
    >
      <div className='flex items-start gap-2'>
        <button
          className='text-muted-foreground hover:text-foreground mt-1 cursor-grab'
          {...attributes}
          {...listeners}
        >
          <GripVertical className='h-4 w-4' />
        </button>

        <div className='min-w-0 flex-1 space-y-2'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2'>
              <ActionTypeSelector
                value={action.actionType}
                onChange={handleTypeChange}
              />
              {action.parserConfidence && (
                <span
                  className={cn('h-2 w-2 shrink-0 rounded-full', {
                    'bg-green-500': action.parserConfidence === 'high',
                    'bg-yellow-500': action.parserConfidence === 'medium',
                    'bg-red-500': action.parserConfidence === 'low'
                  })}
                  title={`Parser confidence: ${action.parserConfidence}`}
                />
              )}
              {action.parserConfidence && !action.userConfirmed && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-6 px-2 text-xs text-green-600'
                  onClick={() => handleFieldSave('userConfirmed', true)}
                >
                  <Check className='mr-1 h-3 w-3' />
                  Confirm
                </Button>
              )}
              {saving && (
                <span className='text-muted-foreground text-xs'>Saving...</span>
              )}
            </div>
            <Button
              variant='ghost'
              size='icon'
              className='h-7 w-7'
              onClick={handleDeleteAction}
            >
              <Trash2 className='h-3.5 w-3.5 text-red-500' />
            </Button>
          </div>

          {action.parserStatus === 'needs_review' && (
            <div className='flex items-center gap-1 text-xs text-amber-600'>
              <AlertCircle className='h-3 w-3' />
              Needs review — parser was unsure about this action
            </div>
          )}
          {action.parserStatus === 'needs_user_input' && (
            <div className='flex items-center gap-1 text-xs text-amber-600'>
              <AlertCircle className='h-3 w-3' />
              Needs your input — bind a voice note, paste a URL, or select a
              form
            </div>
          )}

          {renderFields()}
        </div>
      </div>
    </div>
  );
}
