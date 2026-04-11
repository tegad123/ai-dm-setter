'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
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
import { toast } from 'sonner';
import {
  FileText,
  CheckCircle2,
  Loader2,
  ChevronDown,
  ChevronUp,
  Upload,
  AlertCircle,
  Trash2
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UploadResult {
  upload: {
    id: string;
    fileName: string;
    status: string;
    tokenEstimate: number | null;
    conversationCount: number | null;
    createdAt: string;
  };
  preflight?: {
    passed: boolean;
    isConversationExport: boolean;
    reason: string;
    estimatedConversations: number;
    closerName: string | null;
  };
  estimate?: {
    inputTokens: number;
    estimatedCostCents: number;
    requiresConfirmation: boolean;
  };
}

interface UploadConversation {
  id: string;
  leadIdentifier: string;
  outcomeLabel: string;
  messageCount: number;
  closerMessageCount: number;
  leadMessageCount: number;
  voiceNoteCount: number;
  startedAt: string | null;
  endedAt: string | null;
  messages?: Array<{
    id: string;
    sender: string;
    text: string | null;
    timestamp: string | null;
    messageType: string;
    orderIndex: number;
  }>;
}

interface UploadListItem {
  id: string;
  fileName: string;
  status: string;
  tokenEstimate: number | null;
  conversationCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  conversations: UploadConversation[];
}

const OUTCOME_OPTIONS = [
  { value: 'CLOSED_WIN', label: 'Closed (Won)' },
  { value: 'GHOSTED', label: 'Ghosted' },
  { value: 'OBJECTION_LOST', label: 'Lost to Objection' },
  { value: 'HARD_NO', label: 'Hard No' },
  { value: 'BOOKED_NO_SHOW', label: 'Booked - No Show' },
  { value: 'UNKNOWN', label: 'Unknown' }
];

const OUTCOME_COLORS: Record<string, string> = {
  CLOSED_WIN:
    'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  GHOSTED: 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300',
  OBJECTION_LOST: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  HARD_NO: 'bg-red-200 text-red-900 dark:bg-red-950 dark:text-red-200',
  BOOKED_NO_SHOW:
    'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
  UNKNOWN: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TrainingDataPage() {
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // PDF upload state
  const [uploadStep, setUploadStep] = useState<
    'idle' | 'uploading' | 'preflight_passed' | 'structuring' | 'results'
  >('idle');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [structuredConversations, setStructuredConversations] = useState<
    UploadConversation[]
  >([]);
  const [expandedConvo, setExpandedConvo] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadListItem[]>([]);
  const [showUploads, setShowUploads] = useState(false);
  const [labelingAll, setLabelingAll] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [structuringUploadId, setStructuringUploadId] = useState<string | null>(
    null
  );
  const [structureProgress, setStructureProgress] = useState(0);
  const [structureMessage, setStructureMessage] = useState('');

  // --------------------------------------------------
  // Fetch persona ID on mount
  // --------------------------------------------------

  const fetchPersona = useCallback(async () => {
    try {
      const res = await apiFetch<{ persona: { id: string } | null }>(
        '/settings/persona'
      );
      if (res.persona) setPersonaId(res.persona.id);
    } catch {
      toast.error(
        'Failed to load persona. Please configure your persona first.'
      );
    }
  }, []);

  // Fetch upload history
  const fetchUploads = useCallback(async () => {
    try {
      const res = await apiFetch<{ uploads: UploadListItem[] }>(
        '/settings/training/upload'
      );
      setUploads(res.uploads ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPersona();
    fetchUploads();
  }, [fetchPersona, fetchUploads]);

  // --------------------------------------------------
  // Batch-by-batch structure helper (one LLM call per request)
  // --------------------------------------------------

  async function runStructure(uploadId: string): Promise<{
    upload: { id: string; status: string; conversationCount: number };
    conversations: UploadConversation[];
    duplicatesSkipped: number;
  }> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await apiFetch<any>(
        `/settings/training/upload/${uploadId}/structure`,
        { method: 'POST' }
      );

      if (result.type === 'complete') {
        setStructureProgress(100);
        setStructureMessage('Done!');
        return result;
      }

      if (result.type === 'error') {
        throw new Error(result.message);
      }

      // type === 'processing' — update progress and loop for next batch
      setStructureProgress(result.percent ?? 0);
      setStructureMessage(result.message ?? 'Processing...');
    }
  }

  // --------------------------------------------------
  // PDF Upload handlers
  // --------------------------------------------------

  async function processFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Please upload a PDF file');
      return;
    }

    if (file.size > 3 * 1024 * 1024) {
      toast.error('PDF too large. Maximum size is 3MB.');
      return;
    }

    setUploadStep('uploading');
    setUploadResult(null);
    setStructuredConversations([]);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ''
        )
      );

      const result = await apiFetch<UploadResult>('/settings/training/upload', {
        method: 'POST',
        body: JSON.stringify({ pdfBase64: base64, fileName: file.name })
      });

      setUploadResult(result);

      if (result.preflight?.passed) {
        setUploadStep('preflight_passed');
        toast.success(
          `Detected ~${result.preflight.estimatedConversations} conversations`
        );
      } else {
        setUploadStep('idle');
        toast.error(
          result.preflight?.reason ||
            'This does not appear to be a conversation export'
        );
      }
    } catch (err: any) {
      setUploadStep('idle');
      toast.error(err?.message || 'Upload failed');
    }
  }

  function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    processFile(file);
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }

  async function handleStructure() {
    if (!uploadResult?.upload?.id) return;

    setUploadStep('structuring');
    setStructureProgress(0);
    setStructureMessage('Starting...');
    try {
      const result = await runStructure(uploadResult.upload.id);

      setStructuredConversations(result.conversations);
      setUploadStep('results');
      await fetchUploads();

      let msg = `Structured ${result.conversations.length} conversations`;
      if (result.duplicatesSkipped > 0) {
        msg += ` (${result.duplicatesSkipped} duplicates skipped)`;
      }
      toast.success(msg);
    } catch (err: any) {
      setUploadStep('preflight_passed');
      setStructureProgress(0);
      toast.error(err?.message || 'Structuring failed. Please try again.');
    }
  }

  async function handleLabelAll(outcomeLabel: string) {
    if (!uploadResult?.upload?.id) return;

    setLabelingAll(true);
    try {
      const result = await apiFetch<{ updated: number }>(
        `/settings/training/upload/${uploadResult.upload.id}/label`,
        {
          method: 'PUT',
          body: JSON.stringify({ outcomeLabel })
        }
      );
      setStructuredConversations((prev) =>
        prev.map((c) => ({ ...c, outcomeLabel }))
      );
      toast.success(
        `Labeled ${result.updated} conversations as ${OUTCOME_OPTIONS.find((o) => o.value === outcomeLabel)?.label || outcomeLabel}`
      );
      await fetchUploads();
    } catch {
      toast.error('Failed to update labels');
    } finally {
      setLabelingAll(false);
    }
  }

  async function handleLabelSingle(
    conversationId: string,
    outcomeLabel: string
  ) {
    if (!uploadResult?.upload?.id) return;
    try {
      await apiFetch(
        `/settings/training/upload/${uploadResult.upload.id}/label`,
        {
          method: 'PUT',
          body: JSON.stringify({ conversationId, outcomeLabel })
        }
      );
      setStructuredConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, outcomeLabel } : c))
      );
    } catch {
      toast.error('Failed to update label');
    }
  }

  async function handleViewUpload(uploadId: string) {
    try {
      const res = await apiFetch<{
        upload: UploadListItem & { conversations: UploadConversation[] };
      }>(`/settings/training/upload/${uploadId}`);
      if (res.upload) {
        setUploadResult({
          upload: {
            id: res.upload.id,
            fileName: res.upload.fileName,
            status: res.upload.status,
            tokenEstimate: res.upload.tokenEstimate,
            conversationCount: res.upload.conversationCount,
            createdAt: res.upload.createdAt
          }
        });
        setStructuredConversations(res.upload.conversations || []);
        setUploadStep('results');
      }
    } catch {
      toast.error('Failed to load upload details');
    }
  }

  async function handleStructureFromHistory(uploadId: string) {
    setStructuringUploadId(uploadId);
    setUploadStep('structuring');
    setStructureProgress(0);
    setStructureMessage('Starting...');
    try {
      const result = await runStructure(uploadId);

      setUploadResult({
        upload: {
          id: result.upload.id,
          fileName:
            uploads.find((u) => u.id === uploadId)?.fileName ?? 'Upload',
          status: result.upload.status,
          tokenEstimate: null,
          conversationCount: result.upload.conversationCount,
          createdAt: ''
        }
      });
      setStructuredConversations(result.conversations);
      setUploadStep('results');
      await fetchUploads();

      let msg = `Structured ${result.conversations.length} conversations`;
      if (result.duplicatesSkipped > 0) {
        msg += ` (${result.duplicatesSkipped} duplicates skipped)`;
      }
      toast.success(msg);
    } catch (err: any) {
      setUploadStep('idle');
      setStructureProgress(0);
      toast.error(err?.message || 'Structuring failed. Please try again.');
    } finally {
      setStructuringUploadId(null);
    }
  }

  async function handleDeleteUpload(uploadId: string) {
    if (
      !confirm(
        'Delete this upload and all its conversations? This cannot be undone.'
      )
    ) {
      return;
    }
    try {
      await apiFetch(`/settings/training/upload/${uploadId}`, {
        method: 'DELETE'
      });
      toast.success('Upload deleted');
      // Clear current view if we're viewing the deleted upload
      if (uploadResult?.upload?.id === uploadId) {
        setUploadStep('idle');
        setUploadResult(null);
        setStructuredConversations([]);
      }
      await fetchUploads();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to delete upload');
    }
  }

  // --------------------------------------------------
  // Stats from uploads
  // --------------------------------------------------

  const totalConversations = uploads.reduce(
    (sum, u) => sum + (u.conversationCount ?? 0),
    0
  );
  const completedUploads = uploads.filter(
    (u) => u.status === 'COMPLETE'
  ).length;

  // --------------------------------------------------
  // Render
  // --------------------------------------------------

  if (loading) {
    return (
      <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Training Data</h2>
          <p className='text-muted-foreground'>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-1 flex-col gap-6 p-4 md:p-6'>
      {/* Header */}
      <div>
        <h2 className='text-2xl font-bold tracking-tight'>Training Data</h2>
        <p className='text-muted-foreground'>
          Upload your real DM conversations so the AI can learn exactly how you
          sell. Export your Instagram DMs as a PDF and upload them here.
        </p>
      </div>

      {/* Stats bar */}
      {completedUploads > 0 && (
        <div className='bg-muted grid grid-cols-2 gap-4 rounded-lg p-4 sm:grid-cols-3'>
          <div>
            <p className='text-muted-foreground text-xs'>Total Conversations</p>
            <p className='text-2xl font-bold'>{totalConversations}</p>
          </div>
          <div>
            <p className='text-muted-foreground text-xs'>Uploads Processed</p>
            <p className='text-2xl font-bold'>{completedUploads}</p>
          </div>
          <div className='hidden sm:block'>
            <p className='text-muted-foreground text-xs'>Status</p>
            <p className='text-sm font-medium text-green-600 dark:text-green-400'>
              {totalConversations >= 20
                ? 'Good training set'
                : `Need ${20 - totalConversations} more convos`}
            </p>
          </div>
        </div>
      )}

      {/* ── PDF Upload Card ─────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-lg'>
            <Upload className='h-5 w-5' />
            Upload Conversation Export
          </CardTitle>
          <p className='text-muted-foreground text-sm'>
            Upload a PDF export of your Instagram DM conversations. The AI will
            parse every message, identify your selling patterns, and learn your
            voice.
          </p>
        </CardHeader>
        <CardContent className='space-y-4'>
          {!personaId && (
            <div className='flex items-start gap-3 rounded-lg bg-amber-50 p-4 dark:bg-amber-950/30'>
              <AlertCircle className='mt-0.5 h-5 w-5 shrink-0 text-amber-600' />
              <div>
                <p className='text-sm font-medium text-amber-800 dark:text-amber-300'>
                  Set up your persona first
                </p>
                <p className='mt-1 text-xs text-amber-700 dark:text-amber-400'>
                  Go to Settings &rarr; Persona to create your AI persona before
                  uploading training data.
                </p>
              </div>
            </div>
          )}

          {/* Step 1: Upload */}
          {uploadStep === 'idle' && personaId && (
            <label
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors ${
                dragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input
                type='file'
                accept='.pdf'
                className='hidden'
                onChange={handlePdfUpload}
              />
              <FileText className='text-muted-foreground mb-3 h-12 w-12' />
              <p className='text-sm font-medium'>
                {dragging
                  ? 'Drop your PDF here'
                  : 'Drop a PDF here or click to browse'}
              </p>
              <p className='text-muted-foreground mt-1 text-xs'>
                PDF up to 3MB &middot; Instagram DM exports &middot;
                Conversation histories
              </p>
            </label>
          )}

          {/* Uploading spinner */}
          {uploadStep === 'uploading' && (
            <div className='flex flex-col items-center justify-center py-10'>
              <Loader2 className='text-primary mb-3 h-8 w-8 animate-spin' />
              <p className='text-sm font-medium'>Analyzing PDF...</p>
              <p className='text-muted-foreground text-xs'>
                Extracting text and running pre-flight check
              </p>
            </div>
          )}

          {/* Step 2: Pre-flight passed — show estimate + confirm */}
          {uploadStep === 'preflight_passed' && uploadResult && (
            <div className='space-y-4'>
              <div className='flex items-start gap-3 rounded-lg bg-green-50 p-4 dark:bg-green-950/30'>
                <CheckCircle2 className='mt-0.5 h-5 w-5 shrink-0 text-green-600' />
                <div>
                  <p className='text-sm font-medium text-green-800 dark:text-green-300'>
                    Valid conversation export detected
                  </p>
                  <p className='mt-1 text-xs text-green-700 dark:text-green-400'>
                    {uploadResult.upload.fileName}
                    {uploadResult.preflight?.closerName &&
                      ` — Closer: ${uploadResult.preflight.closerName}`}
                  </p>
                </div>
              </div>

              <div className='bg-muted rounded-lg p-4'>
                <div className='grid grid-cols-2 gap-4 text-sm'>
                  <div>
                    <p className='text-muted-foreground text-xs'>
                      Est. Conversations
                    </p>
                    <p className='text-lg font-semibold'>
                      {uploadResult.preflight?.estimatedConversations ?? '?'}
                    </p>
                  </div>
                  <div>
                    <p className='text-muted-foreground text-xs'>Est. Cost</p>
                    <p className='text-lg font-semibold'>
                      ~$
                      {(
                        (uploadResult.estimate?.estimatedCostCents ?? 0) / 100
                      ).toFixed(2)}
                    </p>
                  </div>
                </div>
              </div>

              <div className='flex gap-2'>
                <Button onClick={handleStructure}>
                  Structure Conversations
                </Button>
                <Button
                  variant='outline'
                  onClick={() => {
                    setUploadStep('idle');
                    setUploadResult(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Structuring in progress — progress bar */}
          {uploadStep === 'structuring' && (
            <div className='flex flex-col items-center justify-center gap-3 py-10'>
              <div className='w-full max-w-md'>
                <div className='bg-muted relative h-3 w-full overflow-hidden rounded-full'>
                  {/* Animated shimmer behind the progress bar */}
                  <div className='absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/20 to-transparent' />
                  <div
                    className='bg-primary relative h-3 rounded-full transition-all duration-700 ease-out'
                    style={{ width: `${Math.max(structureProgress, 2)}%` }}
                  />
                </div>
                <div className='mt-2 flex items-center justify-between'>
                  <div className='flex items-center gap-2'>
                    <Loader2 className='text-muted-foreground h-3 w-3 animate-spin' />
                    <p className='text-muted-foreground text-xs'>
                      {structureMessage || 'Preparing...'}
                    </p>
                  </div>
                  <p className='text-xs font-medium'>{structureProgress}%</p>
                </div>
              </div>
              <p className='text-muted-foreground mt-1 text-xs'>
                Each batch takes 1-2 minutes to analyze
              </p>
            </div>
          )}

          {/* Step 4: Results + Labeling */}
          {uploadStep === 'results' && structuredConversations.length > 0 && (
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <p className='text-sm font-medium'>
                  {structuredConversations.length} conversations structured
                </p>
                {/* Bulk label */}
                <div className='flex items-center gap-2'>
                  <span className='text-muted-foreground text-xs'>
                    Label all as:
                  </span>
                  <Select
                    onValueChange={(val) => handleLabelAll(val)}
                    disabled={labelingAll}
                  >
                    <SelectTrigger className='h-8 w-[160px] text-xs'>
                      <SelectValue placeholder='Select...' />
                    </SelectTrigger>
                    <SelectContent>
                      {OUTCOME_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Conversation list */}
              <div className='max-h-[500px] space-y-2 overflow-y-auto'>
                {structuredConversations.map((conv) => (
                  <div key={conv.id} className='rounded-lg border p-3'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-2'>
                        <button
                          className='text-muted-foreground hover:text-foreground'
                          onClick={() =>
                            setExpandedConvo(
                              expandedConvo === conv.id ? null : conv.id
                            )
                          }
                        >
                          {expandedConvo === conv.id ? (
                            <ChevronUp className='h-4 w-4' />
                          ) : (
                            <ChevronDown className='h-4 w-4' />
                          )}
                        </button>
                        <span className='text-sm font-medium'>
                          {conv.leadIdentifier}
                        </span>
                        <span className='text-muted-foreground text-xs'>
                          {conv.messageCount} msgs ({conv.closerMessageCount}{' '}
                          you / {conv.leadMessageCount} lead)
                        </span>
                        {conv.voiceNoteCount > 0 && (
                          <Badge variant='outline' className='text-xs'>
                            {conv.voiceNoteCount} voice notes
                          </Badge>
                        )}
                      </div>
                      <Select
                        value={conv.outcomeLabel}
                        onValueChange={(val) => handleLabelSingle(conv.id, val)}
                      >
                        <SelectTrigger className='h-7 w-[140px] text-xs'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {OUTCOME_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Expanded message list */}
                    {expandedConvo === conv.id && conv.messages && (
                      <div className='mt-3 max-h-[300px] space-y-1 overflow-y-auto border-t pt-3'>
                        {conv.messages.map((msg) => (
                          <div
                            key={msg.id}
                            className={`rounded px-2 py-1 text-xs ${
                              msg.sender === 'CLOSER'
                                ? 'bg-primary/10 ml-8'
                                : 'bg-muted mr-8'
                            }`}
                          >
                            <span className='text-muted-foreground font-medium'>
                              {msg.sender === 'CLOSER' ? 'You' : 'Lead'}
                              {msg.messageType !== 'TEXT' &&
                                ` [${msg.messageType.toLowerCase().replace('_', ' ')}]`}
                            </span>
                            {msg.text && <p className='mt-0.5'>{msg.text}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <Button
                variant='outline'
                onClick={() => {
                  setUploadStep('idle');
                  setUploadResult(null);
                  setStructuredConversations([]);
                }}
              >
                Upload Another
              </Button>
            </div>
          )}

          {/* No results state */}
          {uploadStep === 'results' && structuredConversations.length === 0 && (
            <div className='flex flex-col items-center justify-center py-10'>
              <AlertCircle className='text-muted-foreground mb-3 h-8 w-8' />
              <p className='text-sm font-medium'>No conversations were found</p>
              <p className='text-muted-foreground text-xs'>
                The PDF may not contain recognizable DM conversations
              </p>
              <Button
                variant='outline'
                className='mt-4'
                onClick={() => {
                  setUploadStep('idle');
                  setUploadResult(null);
                  setStructuredConversations([]);
                }}
              >
                Try Again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Upload History ─────────────────────────────── */}
      {uploads.length > 0 && (
        <Card>
          <CardHeader>
            <button
              className='flex w-full items-center justify-between'
              onClick={() => setShowUploads(!showUploads)}
            >
              <CardTitle className='text-lg'>
                Upload History ({uploads.length})
              </CardTitle>
              {showUploads ? (
                <ChevronUp className='text-muted-foreground h-5 w-5' />
              ) : (
                <ChevronDown className='text-muted-foreground h-5 w-5' />
              )}
            </button>
          </CardHeader>
          {showUploads && (
            <CardContent className='space-y-2'>
              {uploads.map((u) => (
                <div
                  key={u.id}
                  className='flex items-center justify-between rounded-lg border p-3'
                >
                  <div>
                    <p className='text-sm font-medium'>{u.fileName}</p>
                    <p className='text-muted-foreground text-xs'>
                      {u.conversationCount ?? 0} conversations
                      {' \u00B7 '}
                      {new Date(u.createdAt).toLocaleDateString()}
                    </p>
                    {u.errorMessage && (
                      <p className='mt-1 text-xs text-red-600 dark:text-red-400'>
                        {u.errorMessage}
                      </p>
                    )}
                  </div>
                  <div className='flex items-center gap-2'>
                    <Badge
                      variant='secondary'
                      className={
                        u.status === 'COMPLETE'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300'
                          : u.status === 'FAILED' ||
                              u.status === 'PREFLIGHT_FAILED'
                            ? 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300'
                            : u.status === 'STRUCTURING' ||
                                u.status === 'EXTRACTING'
                              ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300'
                              : u.status === 'AWAITING_CONFIRMATION'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300'
                                : ''
                      }
                    >
                      {u.status.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                    {(u.status === 'AWAITING_CONFIRMATION' ||
                      u.status === 'FAILED') && (
                      <Button
                        size='sm'
                        disabled={structuringUploadId === u.id}
                        onClick={() => handleStructureFromHistory(u.id)}
                      >
                        {structuringUploadId === u.id ? (
                          <>
                            <Loader2 className='mr-1 h-3 w-3 animate-spin' />
                            Structuring...
                          </>
                        ) : u.status === 'FAILED' ? (
                          'Retry'
                        ) : (
                          'Structure'
                        )}
                      </Button>
                    )}
                    {u.status === 'COMPLETE' && (
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => handleViewUpload(u.id)}
                      >
                        View
                      </Button>
                    )}
                    <Button
                      variant='ghost'
                      size='sm'
                      className='text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30'
                      onClick={() => handleDeleteUpload(u.id)}
                    >
                      <Trash2 className='h-4 w-4' />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Empty state (no uploads yet) ─────────────── */}
      {uploads.length === 0 && uploadStep === 'idle' && !loading && (
        <Card>
          <CardContent className='flex flex-col items-center justify-center py-12 text-center'>
            <FileText className='text-muted-foreground mb-4 h-12 w-12' />
            <h3 className='text-lg font-semibold'>No training data yet</h3>
            <p className='text-muted-foreground mt-1 max-w-md'>
              Upload a PDF of your real DM conversations (closed deals,
              objections, follow-ups). The AI will analyze every message and
              learn to sell exactly like you.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
