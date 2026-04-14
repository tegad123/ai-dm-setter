'use client';

import { useState, useRef, useCallback } from 'react';
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
  FileText,
  Plus,
  ArrowLeft,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  File,
  BookOpen
} from 'lucide-react';
import { createScript, parseScript } from '@/lib/api';

interface CreateScriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (scriptId: string) => void;
}

type Step = 'choose' | 'upload' | 'parsing' | 'error';

export default function CreateScriptDialog({
  open,
  onOpenChange,
  onCreated
}: CreateScriptDialogProps) {
  const [step, setStep] = useState<Step>('choose');
  const [creating, setCreating] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [guideOpen, setGuideOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setStep('choose');
    setCreating(false);
    setPasteText('');
    setSelectedFile(null);
    setErrorMessage('');
    setGuideOpen(false);
  }, []);

  const handleOpenChange = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  // Create from template or blank
  const handleCreate = async (fromDefault: boolean) => {
    setCreating(true);
    try {
      const script = await createScript({
        fromDefault,
        name: fromDefault ? undefined : 'New Script'
      });
      toast.success(
        fromDefault
          ? 'Created script from default template'
          : 'Created blank script'
      );
      onCreated(script.id);
      handleOpenChange(false);
    } catch (err) {
      console.error('Failed to create script:', err);
      toast.error('Failed to create script');
    } finally {
      setCreating(false);
    }
  };

  // File selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = [
      'text/plain',
      'text/markdown',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const ext = file.name.split('.').pop()?.toLowerCase();
    const validExts = ['txt', 'md', 'docx'];

    if (!validTypes.includes(file.type) && !validExts.includes(ext || '')) {
      toast.error('Please upload a .txt, .md, or .docx file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('File is too large. Maximum 5MB.');
      return;
    }

    setSelectedFile(file);
  };

  // Parse the script
  const handleParse = async () => {
    setStep('parsing');

    try {
      let data: { text?: string; fileBase64?: string; fileName?: string };

      if (selectedFile) {
        const base64 = await fileToBase64(selectedFile);
        data = { fileBase64: base64, fileName: selectedFile.name };
      } else {
        data = { text: pasteText };
      }

      const result = await parseScript(data);
      toast.success(`Script parsed: ${result.parseWarnings.length} warnings`);
      onCreated(result.script.id);
      handleOpenChange(false);
    } catch (err: any) {
      console.error('Parse failed:', err);
      setErrorMessage(
        err?.message || 'Failed to parse script. Please check the formatting.'
      );
      setStep('error');
    }
  };

  const canParse = selectedFile || pasteText.trim().length > 50;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className='max-h-[85vh] max-w-lg overflow-y-auto'>
        {step === 'choose' && (
          <>
            <DialogHeader>
              <DialogTitle>Create New Script</DialogTitle>
              <DialogDescription>
                Choose how you want to create your sales script.
              </DialogDescription>
            </DialogHeader>

            <div className='grid gap-3 py-4'>
              {/* Upload & Parse */}
              <button
                onClick={() => setStep('upload')}
                disabled={creating}
                className='border-primary/20 hover:border-primary/50 hover:bg-primary/5 flex items-start gap-4 rounded-lg border-2 p-4 text-left transition-colors'
              >
                <div className='bg-primary/10 rounded-lg p-2'>
                  <Upload className='text-primary h-5 w-5' />
                </div>
                <div>
                  <p className='font-semibold'>Upload & Parse</p>
                  <p className='text-muted-foreground text-sm'>
                    Write your script in our standardized format and upload it.
                    The AI will parse it and fill in the structure.
                  </p>
                </div>
              </button>

              {/* From Template */}
              <button
                onClick={() => handleCreate(true)}
                disabled={creating}
                className='border-border flex items-start gap-4 rounded-lg border-2 p-4 text-left transition-colors hover:border-green-500/50 hover:bg-green-500/5'
              >
                <div className='rounded-lg bg-green-500/10 p-2'>
                  <FileText className='h-5 w-5 text-green-600' />
                </div>
                <div>
                  <p className='font-semibold'>
                    From Default Template
                    {creating && (
                      <Loader2 className='ml-2 inline h-4 w-4 animate-spin' />
                    )}
                  </p>
                  <p className='text-muted-foreground text-sm'>
                    Start with a proven 10-step DM setter framework
                    pre-populated with example content.
                  </p>
                </div>
              </button>

              {/* Blank */}
              <button
                onClick={() => handleCreate(false)}
                disabled={creating}
                className='border-border hover:border-border hover:bg-muted/50 flex items-start gap-4 rounded-lg border p-4 text-left transition-colors'
              >
                <div className='bg-muted rounded-lg p-2'>
                  <Plus className='text-muted-foreground h-5 w-5' />
                </div>
                <div>
                  <p className='font-semibold'>Blank Script</p>
                  <p className='text-muted-foreground text-sm'>
                    Build your script from scratch with no pre-populated
                    content.
                  </p>
                </div>
              </button>
            </div>
          </>
        )}

        {step === 'upload' && (
          <>
            <DialogHeader>
              <div className='flex items-center gap-2'>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8'
                  onClick={() => {
                    setStep('choose');
                    setSelectedFile(null);
                    setPasteText('');
                  }}
                >
                  <ArrowLeft className='h-4 w-4' />
                </Button>
                <DialogTitle>Upload & Parse Script</DialogTitle>
              </div>
              <DialogDescription>
                Upload a .txt, .md, or .docx file written in the standardized
                script format, or paste it directly.
              </DialogDescription>
            </DialogHeader>

            {/* Inline Format Guide */}
            <div className='rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/20'>
              <button
                type='button'
                onClick={() => setGuideOpen(!guideOpen)}
                className='flex w-full items-center gap-2 p-3 text-left'
              >
                <BookOpen className='h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400' />
                <span className='flex-1 text-sm font-medium text-blue-800 dark:text-blue-300'>
                  Script Formatting Guide
                </span>
                {guideOpen ? (
                  <ChevronUp className='h-4 w-4 text-blue-600 dark:text-blue-400' />
                ) : (
                  <ChevronDown className='h-4 w-4 text-blue-600 dark:text-blue-400' />
                )}
              </button>

              {guideOpen && (
                <div className='border-t border-blue-200 px-3 pt-2 pb-3 dark:border-blue-900'>
                  <div className='space-y-2.5 font-mono text-xs text-blue-900 dark:text-blue-200'>
                    {/* Steps */}
                    <div>
                      <p className='mb-1 font-sans text-[11px] font-semibold tracking-wide text-blue-600 uppercase dark:text-blue-400'>
                        Steps
                      </p>
                      <p className='text-muted-foreground font-sans text-[11px]'>
                        Each step starts with a heading:
                      </p>
                      <pre className='bg-background/60 mt-1 rounded px-2 py-1.5'>
                        {'# STEP 1: Intro\n# STEP 2: Qualification'}
                      </pre>
                    </div>

                    {/* Branches */}
                    <div>
                      <p className='mb-1 font-sans text-[11px] font-semibold tracking-wide text-blue-600 uppercase dark:text-blue-400'>
                        Branches
                      </p>
                      <p className='text-muted-foreground font-sans text-[11px]'>
                        Each branch within a step:
                      </p>
                      <pre className='bg-background/60 mt-1 rounded px-2 py-1.5'>
                        {'## BRANCH: Default\n## BRANCH: Already interested'}
                      </pre>
                    </div>

                    {/* Action Tags */}
                    <div>
                      <p className='mb-1 font-sans text-[11px] font-semibold tracking-wide text-blue-600 uppercase dark:text-blue-400'>
                        Action Tags
                      </p>
                      <div className='bg-background/60 rounded px-2 py-1.5'>
                        <div className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5'>
                          <span className='font-semibold'>[MSG]:</span>
                          <span className='font-sans opacity-70'>
                            Send a message
                          </span>
                          <span className='font-semibold'>[Q]:</span>
                          <span className='font-sans opacity-70'>
                            Ask a question
                          </span>
                          <span className='font-semibold'>[VN]:</span>
                          <span className='font-sans opacity-70'>
                            Voice note label
                          </span>
                          <span className='font-semibold'>[LINK]:</span>
                          <span className='font-sans opacity-70'>
                            Link label
                          </span>
                          <span className='font-semibold'>[VIDEO]:</span>
                          <span className='font-sans opacity-70'>
                            Video label
                          </span>
                          <span className='font-semibold'>[FORM]:</span>
                          <span className='font-sans opacity-70'>
                            Form name
                          </span>
                          <span className='font-semibold'>[JUDGE]:</span>
                          <span className='font-sans opacity-70'>
                            AI judgment instruction
                          </span>
                          <span className='font-semibold'>[WAIT]:</span>
                          <span className='font-sans opacity-70'>
                            Wait for reply
                          </span>
                          <span className='font-semibold'>[DELAY]:</span>
                          <span className='font-sans opacity-70'>
                            Wait N seconds
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Example */}
                    <div>
                      <p className='mb-1 font-sans text-[11px] font-semibold tracking-wide text-blue-600 uppercase dark:text-blue-400'>
                        Example
                      </p>
                      <pre className='bg-background/60 rounded px-2 py-1.5 leading-relaxed whitespace-pre-wrap'>
                        {`# STEP 1: Intro
## BRANCH: Default
[MSG]: Hey! Thanks for reaching out.
[Q]: What made you interested?
[WAIT]:

# STEP 2: Qualify
## BRANCH: Default
[MSG]: Great — let me ask a few questions.
[FORM]: Qualification Questions`}
                      </pre>
                    </div>
                  </div>
                </div>
              )}
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
                      <p className='text-muted-foreground text-xs'>
                        Maximum 5MB
                      </p>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value='paste' className='mt-3'>
                <Textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={`# STEP 1: Intro\n## BRANCH: Default\n[MSG]: Hey! Thanks for reaching out...\n[WAIT]:\n\n# STEP 2: Qualification\n...`}
                  className='h-[180px] max-h-[35vh] resize-y font-mono text-sm'
                />
                <p className='text-muted-foreground mt-1 text-xs'>
                  {pasteText.length} characters
                </p>
              </TabsContent>
            </Tabs>

            <div className='flex justify-end pt-2'>
              <Button onClick={handleParse} disabled={!canParse}>
                Parse Script
              </Button>
            </div>
          </>
        )}

        {step === 'parsing' && (
          <div className='flex flex-col items-center gap-4 py-12'>
            <Loader2 className='text-primary h-10 w-10 animate-spin' />
            <div className='text-center'>
              <p className='font-medium'>Parsing your script...</p>
              <p className='text-muted-foreground text-sm'>
                The AI is analyzing your script structure. This may take a
                moment.
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
              <p className='font-medium'>Parsing Failed</p>
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip the data:...;base64, prefix
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
