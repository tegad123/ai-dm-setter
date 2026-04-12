'use client';

import { useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Upload, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { uploadVoiceNote, processVoiceNote } from '@/lib/api';
import {
  ALLOWED_AUDIO_TYPES,
  MAX_FILE_SIZE,
  DURATION_WARN_LONG,
  DURATION_WARN_SHORT,
  estimateAudioDuration,
  estimateProcessingCost
} from '@/lib/voice-note-library';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (itemId: string) => void;
}

type Step = 'select' | 'duration_warning' | 'cost_confirm' | 'uploading';

export default function UploadVoiceNoteDialog({
  open,
  onOpenChange,
  onComplete
}: Props) {
  const [step, setStep] = useState<Step>('select');
  const [file, setFile] = useState<File | null>(null);
  const [estimatedDuration, setEstimatedDuration] = useState(0);
  const [durationWarning, setDurationWarning] = useState('');
  const [uploading, setUploading] = useState(false);

  const reset = useCallback(() => {
    setStep('select');
    setFile(null);
    setEstimatedDuration(0);
    setDurationWarning('');
    setUploading(false);
  }, []);

  function handleClose(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;

    if (!ALLOWED_AUDIO_TYPES.includes(f.type)) {
      toast.error('Unsupported audio format. Use mp3, m4a, wav, or ogg.');
      return;
    }

    if (f.size > MAX_FILE_SIZE) {
      toast.error('File too large. Maximum size is 10 MB.');
      return;
    }

    const duration = estimateAudioDuration(f.size);
    setFile(f);
    setEstimatedDuration(duration);

    // Check duration warnings
    if (duration > DURATION_WARN_LONG) {
      setDurationWarning(
        'This voice note is unusually long. Voice notes typically work best under 90 seconds. Continue anyway?'
      );
      setStep('duration_warning');
    } else if (duration < DURATION_WARN_SHORT) {
      setDurationWarning(
        'This voice note is unusually short. Continue anyway?'
      );
      setStep('duration_warning');
    } else {
      setStep('cost_confirm');
    }
  }

  async function handleUpload() {
    if (!file) return;
    setStep('uploading');
    setUploading(true);

    try {
      const uploadRes = await uploadVoiceNote(file);
      const itemId = uploadRes.item.id;

      // Trigger processing (fire-and-forget from the UI perspective)
      processVoiceNote(itemId).catch((err) =>
        console.error('Process trigger failed:', err)
      );

      toast.success('Voice note uploaded! Processing has started.');
      onComplete(itemId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to upload voice note'
      );
      setStep('select');
    } finally {
      setUploading(false);
    }
  }

  const cost = estimateProcessingCost(estimatedDuration);

  return (
    <>
      <Dialog
        open={open && step !== 'duration_warning'}
        onOpenChange={handleClose}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Voice Note</DialogTitle>
            <DialogDescription>
              Upload a pre-recorded audio file. The AI will transcribe and label
              it automatically.
            </DialogDescription>
          </DialogHeader>

          {step === 'select' && (
            <div className='py-4'>
              <label className='hover:border-primary flex cursor-pointer flex-col items-center gap-3 rounded-lg border-2 border-dashed p-8 transition-colors'>
                <Upload className='text-muted-foreground h-10 w-10' />
                <span className='text-sm font-medium'>
                  Click to select an audio file
                </span>
                <span className='text-muted-foreground text-xs'>
                  MP3, M4A, WAV, OGG — max 10 MB
                </span>
                <input
                  type='file'
                  accept='audio/*'
                  className='hidden'
                  onChange={handleFileSelect}
                />
              </label>
            </div>
          )}

          {step === 'cost_confirm' && file && (
            <div className='space-y-4 py-4'>
              <div className='flex items-center gap-3'>
                <div className='bg-muted flex h-10 w-10 items-center justify-center rounded-full'>
                  <Upload className='h-5 w-5' />
                </div>
                <div>
                  <p className='text-sm font-medium'>{file.name}</p>
                  <p className='text-muted-foreground text-xs'>
                    ~{Math.round(estimatedDuration)}s estimated duration
                  </p>
                </div>
              </div>

              <Card>
                <CardContent className='space-y-2 py-3'>
                  <p className='text-sm font-medium'>
                    Estimated Processing Cost
                  </p>
                  <div className='space-y-1 text-sm'>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Whisper transcription
                      </span>
                      <span>${cost.whisper.toFixed(3)}</span>
                    </div>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        AI labeling (Sonnet)
                      </span>
                      <span>${cost.llm.toFixed(3)}</span>
                    </div>
                    <div className='flex justify-between'>
                      <span className='text-muted-foreground'>
                        Embedding generation
                      </span>
                      <span>${cost.embedding.toFixed(3)}</span>
                    </div>
                    <div className='flex justify-between border-t pt-1 font-medium'>
                      <span>Total</span>
                      <span>${cost.total.toFixed(3)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <DialogFooter>
                <Button variant='outline' onClick={() => setStep('select')}>
                  Back
                </Button>
                <Button onClick={handleUpload}>Process Voice Note</Button>
              </DialogFooter>
            </div>
          )}

          {step === 'uploading' && (
            <div className='flex flex-col items-center gap-4 py-10'>
              <Loader2 className='text-primary h-10 w-10 animate-spin' />
              <p className='text-muted-foreground text-sm font-medium'>
                Uploading and starting processing...
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Duration warning dialog */}
      <AlertDialog
        open={step === 'duration_warning'}
        onOpenChange={(isOpen) => {
          if (!isOpen) setStep('select');
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center gap-2'>
              <AlertCircle className='h-5 w-5 text-amber-500' />
              Duration Warning
            </AlertDialogTitle>
            <AlertDialogDescription>{durationWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setStep('select')}>
              Go Back
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => setStep('cost_confirm')}>
              Continue Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
