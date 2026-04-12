'use client';

import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Loader2,
  Mic,
  Upload,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Play,
  Volume2
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VoiceNoteSlot {
  id: string;
  slotName: string;
  description: string;
  triggerCondition: {
    natural_language?: string;
    structured?: {
      step_id?: string;
      branch_id?: string;
      action_id?: string;
    };
  };
  audioFileUrl: string | null;
  audioDurationSecs: number | null;
  uploadedAt: string | null;
  fallbackBehavior:
    | 'BLOCK_UNTIL_FILLED'
    | 'SEND_TEXT_EQUIVALENT'
    | 'SKIP_ACTION';
  fallbackText: string | null;
  status: 'EMPTY' | 'UPLOADED' | 'APPROVED';
  userApproved: boolean;
}

interface VoiceNoteSlotsViewProps {
  slots: VoiceNoteSlot[];
  onSlotsChange: (slots: VoiceNoteSlot[]) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusIcon(status: string) {
  switch (status) {
    case 'APPROVED':
      return <CheckCircle2 className='h-4 w-4 text-green-600' />;
    case 'UPLOADED':
      return <Volume2 className='h-4 w-4 text-amber-600' />;
    default:
      return <AlertCircle className='h-4 w-4 text-red-500' />;
  }
}

function statusBadge(status: string) {
  if (status === 'APPROVED')
    return (
      <Badge className='border-green-300 bg-green-100 text-green-800'>
        Approved
      </Badge>
    );
  if (status === 'UPLOADED')
    return (
      <Badge className='border-amber-300 bg-amber-100 text-amber-800'>
        Uploaded
      </Badge>
    );
  return (
    <Badge className='border-red-300 bg-red-100 text-red-800'>No audio</Badge>
  );
}

function fallbackLabel(behavior: string) {
  switch (behavior) {
    case 'BLOCK_UNTIL_FILLED':
      return 'Block until filled';
    case 'SEND_TEXT_EQUIVALENT':
      return 'Send text equivalent';
    case 'SKIP_ACTION':
      return 'Skip action';
    default:
      return behavior;
  }
}

function formatDuration(secs: number | null) {
  if (!secs) return '';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function VoiceNoteSlotsView({
  slots,
  onSlotsChange
}: VoiceNoteSlotsViewProps) {
  const [uploadingSlotId, setUploadingSlotId] = useState<string | null>(null);
  const [savingSlotId, setSavingSlotId] = useState<string | null>(null);
  const [deletingSlotId, setDeletingSlotId] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Upload audio
  const handleAudioUpload = useCallback(
    async (slotId: string, file: File) => {
      if (file.size > 10 * 1024 * 1024) {
        toast.error('Audio file too large. Maximum is 10MB.');
        return;
      }

      setUploadingSlotId(slotId);
      try {
        // Convert to base64
        const buffer = await file.arrayBuffer();
        const base64 = btoa(
          new Uint8Array(buffer).reduce(
            (data, byte) => data + String.fromCharCode(byte),
            ''
          )
        );

        const result = await apiFetch<{ slot: VoiceNoteSlot }>(
          '/settings/persona/voice-slots/upload',
          {
            method: 'POST',
            body: JSON.stringify({
              slotId,
              audioBase64: base64,
              contentType: file.type,
              fileName: file.name
            })
          }
        );

        onSlotsChange(slots.map((s) => (s.id === slotId ? result.slot : s)));
        toast.success('Audio uploaded');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        toast.error(msg);
      } finally {
        setUploadingSlotId(null);
      }
    },
    [slots, onSlotsChange]
  );

  // Update slot config
  const updateSlot = useCallback(
    async (
      slotId: string,
      data: {
        fallbackBehavior?: string;
        fallbackText?: string;
        userApproved?: boolean;
      }
    ) => {
      setSavingSlotId(slotId);
      try {
        const result = await apiFetch<{ slot: VoiceNoteSlot }>(
          '/settings/persona/voice-slots',
          {
            method: 'PUT',
            body: JSON.stringify({ slotId, ...data })
          }
        );
        onSlotsChange(slots.map((s) => (s.id === slotId ? result.slot : s)));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Update failed';
        toast.error(msg);
      } finally {
        setSavingSlotId(null);
      }
    },
    [slots, onSlotsChange]
  );

  // Delete slot
  const deleteSlot = useCallback(
    async (slotId: string) => {
      setDeletingSlotId(slotId);
      try {
        await apiFetch(`/settings/persona/voice-slots?slotId=${slotId}`, {
          method: 'DELETE'
        });
        onSlotsChange(slots.filter((s) => s.id !== slotId));
        toast.success('Voice note slot removed');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Delete failed';
        toast.error(msg);
      } finally {
        setDeletingSlotId(null);
      }
    },
    [slots, onSlotsChange]
  );

  // Summary counts
  const emptyCount = slots.filter((s) => s.status === 'EMPTY').length;
  const uploadedCount = slots.filter((s) => s.status === 'UPLOADED').length;
  const approvedCount = slots.filter((s) => s.status === 'APPROVED').length;
  const blockingCount = slots.filter(
    (s) => s.status === 'EMPTY' && s.fallbackBehavior === 'BLOCK_UNTIL_FILLED'
  ).length;

  // Empty state
  if (!slots || slots.length === 0) {
    return (
      <Card>
        <CardContent className='py-8 text-center'>
          <Mic className='text-muted-foreground mx-auto mb-3 h-8 w-8' />
          <p className='text-muted-foreground'>
            No voice note slots detected. Upload a sales script that references
            voice notes to auto-detect trigger points.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className='space-y-3'>
      {/* Summary bar */}
      <Card>
        <CardContent className='flex flex-wrap items-center gap-4 py-3'>
          <span className='text-sm font-medium'>
            {slots.length} voice note slot{slots.length !== 1 ? 's' : ''}
          </span>
          {approvedCount > 0 && (
            <span className='text-sm text-green-700'>
              {approvedCount} approved
            </span>
          )}
          {uploadedCount > 0 && (
            <span className='text-sm text-amber-700'>
              {uploadedCount} uploaded
            </span>
          )}
          {emptyCount > 0 && (
            <span className='text-sm text-red-700'>{emptyCount} empty</span>
          )}
          {blockingCount > 0 && (
            <Badge variant='destructive' className='ml-auto text-xs'>
              {blockingCount} blocking activation
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Slot cards */}
      {slots.map((slot) => {
        const isUploading = uploadingSlotId === slot.id;
        const isSaving = savingSlotId === slot.id;
        const isDeleting = deletingSlotId === slot.id;

        return (
          <Card
            key={slot.id}
            className={
              slot.status === 'APPROVED'
                ? 'border-l-4 border-l-green-500'
                : slot.status === 'UPLOADED'
                  ? 'border-l-4 border-l-amber-400'
                  : 'border-l-4 border-l-red-300'
            }
          >
            <CardHeader className='py-3'>
              <div className='flex items-center gap-3'>
                {statusIcon(slot.status)}
                <CardTitle className='flex-1 text-sm font-semibold'>
                  {slot.slotName}
                </CardTitle>
                {statusBadge(slot.status)}
              </div>
            </CardHeader>

            <CardContent className='space-y-4 pt-0'>
              {/* Description */}
              <p className='text-muted-foreground text-xs'>
                {slot.description}
              </p>

              {/* Trigger condition */}
              {slot.triggerCondition?.natural_language && (
                <div className='rounded-md border bg-indigo-50/50 p-2'>
                  <span className='text-xs font-medium text-indigo-700'>
                    Triggers when:
                  </span>
                  <p className='mt-0.5 text-xs text-indigo-600'>
                    {slot.triggerCondition.natural_language}
                  </p>
                </div>
              )}

              {/* Audio section */}
              <div className='space-y-2'>
                <Label className='text-xs font-medium'>Audio File</Label>

                {slot.audioFileUrl ? (
                  <div className='flex items-center gap-3 rounded-md border bg-green-50/50 p-2'>
                    <audio
                      controls
                      src={slot.audioFileUrl}
                      className='h-8 flex-1'
                      preload='metadata'
                    />
                    {slot.audioDurationSecs && (
                      <span className='text-xs text-gray-500'>
                        {formatDuration(slot.audioDurationSecs)}
                      </span>
                    )}
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-7 text-xs'
                      onClick={() => fileInputRefs.current[slot.id]?.click()}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <button
                    onClick={() => fileInputRefs.current[slot.id]?.click()}
                    disabled={isUploading}
                    className='flex w-full cursor-pointer items-center justify-center gap-2 rounded-md border-2 border-dashed border-gray-300 p-4 text-sm transition-colors hover:border-purple-400 hover:bg-purple-50/50 disabled:cursor-not-allowed disabled:opacity-50'
                  >
                    {isUploading ? (
                      <Loader2 className='h-4 w-4 animate-spin' />
                    ) : (
                      <Upload className='h-4 w-4 text-purple-600' />
                    )}
                    <span className='text-muted-foreground'>
                      {isUploading
                        ? 'Uploading...'
                        : 'Click to upload audio (mp3, m4a, wav, ogg)'}
                    </span>
                  </button>
                )}

                <input
                  ref={(el) => {
                    fileInputRefs.current[slot.id] = el;
                  }}
                  type='file'
                  accept='audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/ogg,audio/webm'
                  className='hidden'
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleAudioUpload(slot.id, file);
                    e.target.value = '';
                  }}
                />
              </div>

              {/* Fallback config */}
              <div className='grid gap-3 sm:grid-cols-2'>
                <div className='space-y-1'>
                  <Label className='text-xs font-medium'>
                    Fallback behavior
                  </Label>
                  <Select
                    value={slot.fallbackBehavior}
                    onValueChange={(val) =>
                      updateSlot(slot.id, { fallbackBehavior: val })
                    }
                  >
                    <SelectTrigger className='h-8 text-xs'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='SEND_TEXT_EQUIVALENT'>
                        Send text equivalent
                      </SelectItem>
                      <SelectItem value='SKIP_ACTION'>Skip action</SelectItem>
                      <SelectItem value='BLOCK_UNTIL_FILLED'>
                        Block until filled
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {slot.fallbackBehavior === 'SEND_TEXT_EQUIVALENT' && (
                  <div className='space-y-1 sm:col-span-2'>
                    <Label className='text-xs font-medium'>Fallback text</Label>
                    <Textarea
                      value={slot.fallbackText || ''}
                      onChange={(e) => {
                        // Update local state immediately
                        onSlotsChange(
                          slots.map((s) =>
                            s.id === slot.id
                              ? { ...s, fallbackText: e.target.value }
                              : s
                          )
                        );
                      }}
                      onBlur={(e) => {
                        updateSlot(slot.id, { fallbackText: e.target.value });
                      }}
                      placeholder='Text to send if no audio is uploaded...'
                      className='min-h-[60px] text-xs'
                    />
                  </div>
                )}
              </div>

              {/* Actions row */}
              <div className='flex items-center gap-2 border-t pt-3'>
                {/* Approve button */}
                {slot.status === 'UPLOADED' && !slot.userApproved && (
                  <Button
                    size='sm'
                    className='h-7 text-xs'
                    disabled={isSaving}
                    onClick={() =>
                      updateSlot(slot.id, { userApproved: true }).then(() => {
                        onSlotsChange(
                          slots.map((s) =>
                            s.id === slot.id
                              ? { ...s, status: 'APPROVED', userApproved: true }
                              : s
                          )
                        );
                      })
                    }
                  >
                    {isSaving ? (
                      <Loader2 className='mr-1 h-3 w-3 animate-spin' />
                    ) : (
                      <CheckCircle2 className='mr-1 h-3 w-3' />
                    )}
                    Approve
                  </Button>
                )}

                <div className='ml-auto'>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 text-xs text-red-600'
                    disabled={isDeleting}
                    onClick={() => deleteSlot(slot.id)}
                  >
                    {isDeleting ? (
                      <Loader2 className='mr-1 h-3 w-3 animate-spin' />
                    ) : (
                      <Trash2 className='mr-1 h-3 w-3' />
                    )}
                    Remove
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
