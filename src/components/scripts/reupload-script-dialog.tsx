'use client';

import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  Upload,
  Loader2,
  AlertCircle,
  AlertTriangle,
  File
} from 'lucide-react';
import { reuploadScript } from '@/lib/api';

interface ReuploadScriptDialogProps {
  scriptId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}

type Step = 'upload' | 'parsing' | 'error';

export default function ReuploadScriptDialog({
  scriptId,
  open,
  onOpenChange,
  onComplete
}: ReuploadScriptDialogProps) {
  const [step, setStep] = useState<Step>('upload');
  const [pasteText, setPasteText] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload');
    setPasteText('');
    setSelectedFile(null);
    setErrorMessage('');
  };

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ext = file.name.split('.').pop()?.toLowerCase();
    const validExts = ['txt', 'md', 'docx'];
    if (!validExts.includes(ext || '')) {
      toast.error('Please upload a .txt, .md, or .docx file');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File is too large. Maximum 5MB.');
      return;
    }
    setSelectedFile(file);
  };

  const handleReupload = async () => {
    setStep('parsing');

    try {
      let data: { text?: string; fileBase64?: string; fileName?: string };

      if (selectedFile) {
        const base64 = await fileToBase64(selectedFile);
        data = { fileBase64: base64, fileName: selectedFile.name };
      } else {
        data = { text: pasteText };
      }

      const result = await reuploadScript(scriptId, data);
      toast.success(
        `Script re-parsed. ${result.parseWarnings.length} warnings.`
      );
      onComplete();
      handleOpenChange(false);
    } catch (err: any) {
      console.error('Re-upload failed:', err);
      setErrorMessage(err?.message || 'Failed to re-parse script.');
      setStep('error');
    }
  };

  const canParse = selectedFile || pasteText.trim().length > 50;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='max-w-lg'>
        {step === 'upload' && (
          <>
            <DialogHeader>
              <DialogTitle>Re-upload Script</DialogTitle>
              <DialogDescription>
                Upload a corrected version of your formatted script.
              </DialogDescription>
            </DialogHeader>

            {/* Warning */}
            <div className='flex items-start gap-2 rounded-lg bg-amber-50 p-3 dark:bg-amber-950/20'>
              <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-amber-600' />
              <p className='text-sm text-amber-800 dark:text-amber-300'>
                Re-uploading will replace parsed text content but keep your URL
                fills, voice note bindings, and form content.
              </p>
            </div>

            <Tabs defaultValue='upload' className='mt-2'>
              <TabsList className='w-full'>
                <TabsTrigger value='upload' className='flex-1'>
                  Upload File
                </TabsTrigger>
                <TabsTrigger value='paste' className='flex-1'>
                  Paste Text
                </TabsTrigger>
              </TabsList>

              <TabsContent value='upload' className='mt-3'>
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className='border-border hover:border-primary/50 cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors'
                >
                  <input
                    ref={fileInputRef}
                    type='file'
                    accept='.txt,.md,.docx'
                    className='hidden'
                    onChange={handleFileSelect}
                  />
                  {selectedFile ? (
                    <div className='flex flex-col items-center gap-2'>
                      <File className='text-primary h-8 w-8' />
                      <p className='font-medium'>{selectedFile.name}</p>
                      <p className='text-muted-foreground text-xs'>
                        {(selectedFile.size / 1024).toFixed(1)} KB — Click to
                        change
                      </p>
                    </div>
                  ) : (
                    <div className='flex flex-col items-center gap-2'>
                      <Upload className='text-muted-foreground h-8 w-8' />
                      <p className='text-muted-foreground text-sm'>
                        Click to select a .txt, .md, or .docx file
                      </p>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value='paste' className='mt-3'>
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={`# STEP 1: Intro\n## BRANCH: Default\n[MSG]: Hey! Thanks for reaching out...\n...`}
                  className='min-h-[200px] font-mono text-sm'
                />
                <p className='text-muted-foreground mt-1 text-xs'>
                  {pasteText.length} characters
                </p>
              </TabsContent>
            </Tabs>

            <div className='flex justify-end pt-2'>
              <Button onClick={handleReupload} disabled={!canParse}>
                Re-parse Script
              </Button>
            </div>
          </>
        )}

        {step === 'parsing' && (
          <div className='flex flex-col items-center gap-4 py-12'>
            <Loader2 className='text-primary h-10 w-10 animate-spin' />
            <div className='text-center'>
              <p className='font-medium'>Re-parsing your script...</p>
              <p className='text-muted-foreground text-sm'>
                Preserving your URL fills and voice note bindings.
              </p>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div className='flex flex-col items-center gap-4 py-8'>
            <div className='rounded-full bg-red-500/10 p-3'>
              <AlertCircle className='h-8 w-8 text-red-500' />
            </div>
            <div className='text-center'>
              <p className='font-medium'>Re-upload Failed</p>
              <p className='text-muted-foreground mt-1 max-w-sm text-sm'>
                {errorMessage}
              </p>
            </div>
            <div className='flex gap-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setStep('upload');
                  setErrorMessage('');
                }}
              >
                Try Again
              </Button>
              <Button variant='ghost' onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
