'use client';

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Mic,
  Link as LinkIcon,
  FileText,
  Brain,
  AlertCircle,
  Check,
  X,
  ExternalLink,
  Volume2,
  Library,
  Upload,
  Loader2
} from 'lucide-react';
import type { ScriptSlot, SlotType } from '@/lib/script-slot-types';
import { apiFetch } from '@/lib/api';
import type { VoiceNoteLibraryItem } from '@/lib/api';
import { toast } from 'sonner';

// ─── Slot Type Config ────────────────────────────────────────────────────

const SLOT_CONFIG: Record<
  SlotType,
  { icon: typeof Mic; color: string; borderColor: string; label: string }
> = {
  voice_note: {
    icon: Mic,
    color: 'text-blue-600 dark:text-blue-400',
    borderColor: 'border-l-blue-500',
    label: 'Voice Note'
  },
  link: {
    icon: LinkIcon,
    color: 'text-violet-600 dark:text-violet-400',
    borderColor: 'border-l-violet-500',
    label: 'Link / URL'
  },
  form: {
    icon: FileText,
    color: 'text-amber-600 dark:text-amber-400',
    borderColor: 'border-l-amber-500',
    label: 'Form'
  },
  runtime_judgment: {
    icon: Brain,
    color: 'text-emerald-600 dark:text-emerald-400',
    borderColor: 'border-l-emerald-500',
    label: 'AI Handles This'
  },
  text_gap: {
    icon: AlertCircle,
    color: 'text-orange-600 dark:text-orange-400',
    borderColor: 'border-l-orange-500',
    label: 'Text Content'
  }
};

// ─── Status Badge ────────────────────────────────────────────────────────

function SlotStatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'bound':
      return (
        <Badge variant='default' className='bg-green-600 text-xs'>
          <Check className='mr-1 h-3 w-3' /> Bound
        </Badge>
      );
    case 'filled':
    case 'complete':
      return (
        <Badge variant='default' className='bg-green-600 text-xs'>
          <Check className='mr-1 h-3 w-3' />{' '}
          {status === 'complete' ? 'Complete' : 'Filled'}
        </Badge>
      );
    case 'partially_filled':
      return (
        <Badge variant='secondary' className='text-xs'>
          Partial
        </Badge>
      );
    case 'unfilled':
      return (
        <Badge variant='outline' className='text-muted-foreground text-xs'>
          Unfilled
        </Badge>
      );
    default:
      return null;
  }
}

// ─── Shared Props ────────────────────────────────────────────────────────

interface SlotCardProps {
  slot: ScriptSlot;
  breakdownId: string;
  onSlotUpdate: (updatedSlot: ScriptSlot) => void;
  libraryVoiceNotes?: VoiceNoteLibraryItem[];
  onRequestUpload?: (slotId: string) => void;
}

// ─── Voice Note Slot Card ────────────────────────────────────────────────

function VoiceNoteSlotCard({
  slot,
  breakdownId,
  onSlotUpdate,
  libraryVoiceNotes = [],
  onRequestUpload
}: SlotCardProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleBind = useCallback(
    async (voiceNoteId: string) => {
      setSaving(true);
      try {
        const result = await apiFetch<{ slot: ScriptSlot }>(
          `/settings/persona/script/${breakdownId}/slot`,
          {
            method: 'PUT',
            body: JSON.stringify({
              slotId: slot.id,
              action: 'bind_voice_note',
              voiceNoteId
            })
          }
        );
        onSlotUpdate(result.slot);
        setShowPicker(false);
        toast.success('Voice note bound');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to bind');
      } finally {
        setSaving(false);
      }
    },
    [slot.id, breakdownId, onSlotUpdate]
  );

  const handleUnbind = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'unbind_voice_note'
          })
        }
      );
      onSlotUpdate(result.slot);
      toast.success('Voice note unbound');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unbind');
    } finally {
      setSaving(false);
    }
  }, [slot.id, breakdownId, onSlotUpdate]);

  return (
    <div className='space-y-2'>
      <p className='text-muted-foreground text-xs'>{slot.description}</p>

      {slot.status === 'bound' && slot.boundVoiceNote ? (
        <div className='bg-muted/50 flex items-center gap-2 rounded-md p-2'>
          <Volume2 className='text-muted-foreground h-4 w-4 shrink-0' />
          <div className='min-w-0 flex-1'>
            <p className='truncate text-sm font-medium'>
              {slot.boundVoiceNote.userLabel || 'Voice Note'}
            </p>
            <p className='text-muted-foreground text-xs'>
              {Math.round(slot.boundVoiceNote.durationSeconds)}s
            </p>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={handleUnbind}
            disabled={saving}
            className='text-destructive h-7 text-xs'
          >
            {saving ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              <X className='h-3 w-3' />
            )}
            <span className='ml-1'>Unbind</span>
          </Button>
        </div>
      ) : (
        <div className='flex gap-2'>
          {onRequestUpload && (
            <Button
              variant='outline'
              size='sm'
              onClick={() => onRequestUpload(slot.id)}
              className='h-7 text-xs'
            >
              <Upload className='mr-1 h-3 w-3' />
              Upload New
            </Button>
          )}
          <Button
            variant='outline'
            size='sm'
            onClick={() => setShowPicker(!showPicker)}
            className='h-7 text-xs'
          >
            <Library className='mr-1 h-3 w-3' />
            Use Existing
          </Button>
        </div>
      )}

      {showPicker && (
        <div className='border-border max-h-48 space-y-1 overflow-y-auto rounded-md border p-2'>
          {libraryVoiceNotes.length === 0 ? (
            <p className='text-muted-foreground py-2 text-center text-xs'>
              No voice notes in library
            </p>
          ) : (
            libraryVoiceNotes.map((vn) => (
              <button
                key={vn.id}
                onClick={() => handleBind(vn.id)}
                disabled={saving}
                className='hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors'
              >
                <Volume2 className='text-muted-foreground h-3.5 w-3.5 shrink-0' />
                <span className='min-w-0 flex-1 truncate'>
                  {vn.userLabel || vn.summary || 'Untitled'}
                </span>
                <span className='text-muted-foreground text-xs'>
                  {Math.round(vn.durationSeconds)}s
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Link Slot Card ──────────────────────────────────────────────────────

function LinkSlotCard({ slot, breakdownId, onSlotUpdate }: SlotCardProps) {
  const [url, setUrl] = useState(slot.url || '');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!url.trim()) return;
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'fill_url',
            url: url.trim()
          })
        }
      );
      onSlotUpdate(result.slot);
      toast.success('URL saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save URL');
    } finally {
      setSaving(false);
    }
  }, [url, slot.id, breakdownId, onSlotUpdate]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'clear_url'
          })
        }
      );
      onSlotUpdate(result.slot);
      setUrl('');
      toast.success('URL cleared');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setSaving(false);
    }
  }, [slot.id, breakdownId, onSlotUpdate]);

  return (
    <div className='space-y-2'>
      <p className='text-muted-foreground text-xs'>
        {slot.linkDescription || slot.description}
      </p>

      <div className='flex items-center gap-2'>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder='Paste URL here...'
          className='h-8 text-sm'
        />
        {slot.status === 'filled' ? (
          <div className='flex gap-1'>
            <Button variant='ghost' size='sm' asChild className='h-8 w-8 p-0'>
              <a
                href={slot.url || ''}
                target='_blank'
                rel='noopener noreferrer'
              >
                <ExternalLink className='h-3.5 w-3.5' />
              </a>
            </Button>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleClear}
              disabled={saving}
              className='text-destructive h-8 w-8 p-0'
            >
              <X className='h-3.5 w-3.5' />
            </Button>
          </div>
        ) : (
          <Button
            size='sm'
            onClick={handleSave}
            disabled={!url.trim() || saving}
            className='h-8'
          >
            {saving ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Save'}
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Form Slot Card ──────────────────────────────────────────────────────

function FormSlotCard({ slot, breakdownId, onSlotUpdate }: SlotCardProps) {
  type FormField = {
    field_id: string;
    field_type: string;
    label: string;
    placeholder: string;
    required: boolean;
  };
  const initialSchema = slot.formSchema as { fields: FormField[] } | null;
  const [fields, setFields] = useState<FormField[]>(
    initialSchema?.fields || []
  );
  const [values, setValues] = useState<Record<string, string>>(
    (slot.formValues as Record<string, string>) || {}
  );
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'fill_form',
            values,
            formSchema: { fields }
          })
        }
      );
      onSlotUpdate(result.slot);
      toast.success('Form saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save form');
    } finally {
      setSaving(false);
    }
  }, [values, fields, slot.id, breakdownId, onSlotUpdate]);

  const handleAddQAPair = useCallback(() => {
    const idx = Math.floor(fields.length / 2) + 1;
    const qId = `added_q_${Date.now()}_${idx}`;
    const aId = `added_a_${Date.now()}_${idx}`;
    setFields((prev) => [
      ...prev,
      {
        field_id: qId,
        field_type: 'qa_pair',
        label: `Question ${idx}`,
        placeholder: 'Enter question...',
        required: false
      },
      {
        field_id: aId,
        field_type: 'qa_pair',
        label: `Answer ${idx}`,
        placeholder: 'Enter answer...',
        required: false
      }
    ]);
  }, [fields.length]);

  const handleRemoveField = useCallback((fieldId: string) => {
    setFields((prev) => prev.filter((f) => f.field_id !== fieldId));
    setValues((prev) => {
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  if (fields.length === 0) {
    return (
      <div className='space-y-2'>
        <p className='text-muted-foreground text-xs italic'>
          No form fields configured yet.
        </p>
        <Button
          size='sm'
          variant='outline'
          onClick={handleAddQAPair}
          className='h-7 text-xs'
        >
          + Add Q/A Pair
        </Button>
      </div>
    );
  }

  return (
    <div className='space-y-3'>
      {fields.map((field) => (
        <div key={field.field_id} className='space-y-1'>
          <div className='flex items-center justify-between'>
            <label className='text-xs font-medium'>
              {field.label}
              {field.required && (
                <span className='text-destructive ml-0.5'>*</span>
              )}
            </label>
            {!field.required && field.field_id.startsWith('added_') && (
              <Button
                size='sm'
                variant='ghost'
                className='text-muted-foreground hover:text-destructive h-5 w-5 p-0'
                onClick={() => handleRemoveField(field.field_id)}
              >
                <X className='h-3 w-3' />
              </Button>
            )}
          </div>
          {field.field_type === 'text' || field.field_type === 'qa_pair' ? (
            <Textarea
              rows={2}
              value={values[field.field_id] || ''}
              onChange={(e) =>
                setValues((prev) => ({
                  ...prev,
                  [field.field_id]: e.target.value
                }))
              }
              placeholder={field.placeholder}
              className='text-sm'
            />
          ) : field.field_type === 'number' ? (
            <Input
              type='number'
              value={values[field.field_id] || ''}
              onChange={(e) =>
                setValues((prev) => ({
                  ...prev,
                  [field.field_id]: e.target.value
                }))
              }
              placeholder={field.placeholder}
              className='h-8 text-sm'
            />
          ) : (
            <Textarea
              rows={3}
              value={values[field.field_id] || ''}
              onChange={(e) =>
                setValues((prev) => ({
                  ...prev,
                  [field.field_id]: e.target.value
                }))
              }
              placeholder={field.placeholder}
              className='text-sm'
            />
          )}
        </div>
      ))}
      <div className='flex items-center gap-2'>
        <Button
          size='sm'
          onClick={handleSave}
          disabled={saving}
          className='h-7 text-xs'
        >
          {saving ? <Loader2 className='mr-1 h-3 w-3 animate-spin' /> : null}
          Save Form
        </Button>
        <Button
          size='sm'
          variant='outline'
          onClick={handleAddQAPair}
          className='h-7 text-xs'
        >
          + Add Q/A Pair
        </Button>
      </div>
    </div>
  );
}

// ─── Runtime Judgment Slot Card ──────────────────────────────────────────

function RuntimeJudgmentSlotCard({ slot }: { slot: ScriptSlot }) {
  return (
    <div className='space-y-1.5'>
      <p className='text-sm italic'>&ldquo;{slot.instruction}&rdquo;</p>
      {slot.context && (
        <p className='text-muted-foreground text-xs'>{slot.context}</p>
      )}
      <p className='text-muted-foreground text-xs'>
        The AI will handle this at runtime based on conversation context. No
        action needed.
      </p>
    </div>
  );
}

// ─── Text Gap Slot Card ─────────────────────────────────────────────────

function TextGapSlotCard({ slot, breakdownId, onSlotUpdate }: SlotCardProps) {
  const [content, setContent] = useState(
    slot.userContent || slot.suggestedContent || ''
  );
  const [saving, setSaving] = useState(false);

  const isUsingDefault = !slot.userContent && !!slot.suggestedContent;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'fill_text',
            content
          })
        }
      );
      onSlotUpdate(result.slot);
      toast.success('Content saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [content, slot.id, breakdownId, onSlotUpdate]);

  const handleAcceptSuggestion = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiFetch<{ slot: ScriptSlot }>(
        `/settings/persona/script/${breakdownId}/slot`,
        {
          method: 'PUT',
          body: JSON.stringify({
            slotId: slot.id,
            action: 'accept_suggestion'
          })
        }
      );
      onSlotUpdate(result.slot);
      toast.success('Suggestion accepted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to accept');
    } finally {
      setSaving(false);
    }
  }, [slot.id, breakdownId, onSlotUpdate]);

  return (
    <div className='space-y-2'>
      <p className='text-muted-foreground text-xs'>{slot.description}</p>

      <Textarea
        rows={3}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder='Enter the missing content...'
        className='text-sm'
      />

      <div className='flex gap-2'>
        <Button
          size='sm'
          onClick={handleSave}
          disabled={saving || !content.trim()}
          className='h-7 text-xs'
        >
          {saving ? <Loader2 className='mr-1 h-3 w-3 animate-spin' /> : null}
          Save
        </Button>
        {isUsingDefault && slot.suggestedContent && (
          <Button
            variant='outline'
            size='sm'
            onClick={handleAcceptSuggestion}
            disabled={saving}
            className='h-7 text-xs'
          >
            Accept AI Suggestion
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Main Slot Card (dispatches to type-specific cards) ──────────────────

export function ScriptSlotCard({
  slot,
  breakdownId,
  onSlotUpdate,
  libraryVoiceNotes,
  onRequestUpload
}: SlotCardProps) {
  const config = SLOT_CONFIG[slot.slotType as SlotType];
  if (!config) return null;

  const Icon = config.icon;

  return (
    <div
      className={`border-l-4 ${config.borderColor} bg-muted/30 rounded-md rounded-l-none p-3`}
    >
      <div className='mb-2 flex items-center gap-2'>
        <Icon className={`h-4 w-4 ${config.color}`} />
        <span className='text-xs font-semibold tracking-wide uppercase'>
          {config.label}
        </span>
        {slot.detectedName && (
          <span className='text-muted-foreground text-xs'>
            &mdash; {slot.detectedName}
          </span>
        )}
        <div className='ml-auto'>
          <SlotStatusBadge status={slot.status} />
        </div>
      </div>

      {slot.slotType === 'voice_note' && (
        <VoiceNoteSlotCard
          slot={slot}
          breakdownId={breakdownId}
          onSlotUpdate={onSlotUpdate}
          libraryVoiceNotes={libraryVoiceNotes}
          onRequestUpload={onRequestUpload}
        />
      )}
      {slot.slotType === 'link' && (
        <LinkSlotCard
          slot={slot}
          breakdownId={breakdownId}
          onSlotUpdate={onSlotUpdate}
        />
      )}
      {slot.slotType === 'form' && (
        <FormSlotCard
          slot={slot}
          breakdownId={breakdownId}
          onSlotUpdate={onSlotUpdate}
        />
      )}
      {slot.slotType === 'runtime_judgment' && (
        <RuntimeJudgmentSlotCard slot={slot} />
      )}
      {slot.slotType === 'text_gap' && (
        <TextGapSlotCard
          slot={slot}
          breakdownId={breakdownId}
          onSlotUpdate={onSlotUpdate}
        />
      )}
    </div>
  );
}

// ─── Slot Status Summary ─────────────────────────────────────────────────

export function SlotStatusSummary({ slots }: { slots: ScriptSlot[] }) {
  if (slots.length === 0) return null;

  const vnSlots = slots.filter((s) => s.slotType === 'voice_note');
  const linkSlots = slots.filter((s) => s.slotType === 'link');
  const formSlots = slots.filter((s) => s.slotType === 'form');
  const rjSlots = slots.filter((s) => s.slotType === 'runtime_judgment');
  const tgSlots = slots.filter((s) => s.slotType === 'text_gap');

  const vnBound = vnSlots.filter((s) => s.status === 'bound').length;
  const linkFilled = linkSlots.filter((s) => s.status === 'filled').length;
  const formComplete = formSlots.filter((s) => s.status === 'complete').length;
  const tgFilled = tgSlots.filter((s) => s.status === 'filled').length;

  const unfilledCount =
    vnSlots.filter((s) => s.status === 'unfilled').length +
    linkSlots.filter((s) => s.status === 'unfilled').length +
    tgSlots.filter((s) => s.status === 'unfilled').length;

  const segments: string[] = [];
  if (vnSlots.length > 0) {
    segments.push(
      `${vnSlots.length} voice note slot${vnSlots.length !== 1 ? 's' : ''} (${vnBound} bound)`
    );
  }
  if (linkSlots.length > 0) {
    segments.push(
      `${linkSlots.length} link slot${linkSlots.length !== 1 ? 's' : ''} (${linkFilled} filled)`
    );
  }
  if (formSlots.length > 0) {
    segments.push(
      `${formSlots.length} form${formSlots.length !== 1 ? 's' : ''} (${formComplete} complete)`
    );
  }
  if (rjSlots.length > 0) {
    segments.push(
      `${rjSlots.length} runtime judgment instruction${rjSlots.length !== 1 ? 's' : ''}`
    );
  }
  if (tgSlots.length > 0) {
    segments.push(
      `${tgSlots.length} text gap${tgSlots.length !== 1 ? 's' : ''} (${tgFilled} filled)`
    );
  }

  return (
    <div className='bg-muted/50 rounded-lg border p-3'>
      <p className='text-sm'>
        <span className='font-medium'>Script parsed successfully.</span>{' '}
        {segments.join(', ')}.
      </p>
      {unfilledCount > 0 && (
        <p className='text-muted-foreground mt-1 text-xs'>
          You can activate the persona now &mdash; {unfilledCount} unfilled slot
          {unfilledCount !== 1 ? 's' : ''} will fall back to text at runtime.
        </p>
      )}
    </div>
  );
}
