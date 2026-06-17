'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  MessageSquare,
  User,
  UserCheck
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  ParsedMessage,
  TakeoverParseResult
} from '@/lib/conversation-takeover-parser';

type Step = 'paste' | 'parsing' | 'preview' | 'importing' | 'done';

export default function TakeoverView({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('paste');
  const [rawText, setRawText] = useState('');
  const [parsed, setParsed] = useState<TakeoverParseResult | null>(null);
  const [importResult, setImportResult] = useState<{
    importedCount: number;
    skippedCount: number;
  } | null>(null);

  async function handleParse() {
    if (!rawText.trim()) {
      toast.error('Paste the DM thread first.');
      return;
    }
    setStep('parsing');
    try {
      const res = await fetch(`/api/leads/${leadId}/takeover?action=parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Parse failed');
      setParsed(data as TakeoverParseResult);
      setStep('preview');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to parse thread'
      );
      setStep('paste');
    }
  }

  async function handleImport() {
    if (!parsed || parsed.messages.length === 0) return;
    setStep('importing');
    try {
      const res = await fetch(`/api/leads/${leadId}/takeover?action=import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: parsed.messages })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Import failed');
      setImportResult({
        importedCount: data.importedCount,
        skippedCount: data.skippedCount
      });
      setStep('done');
      toast.success(`Imported ${data.importedCount} messages.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import');
      setStep('preview');
    }
  }

  function removeMessage(index: number) {
    if (!parsed) return;
    setParsed({
      ...parsed,
      messages: parsed.messages.filter((_, i) => i !== index)
    });
  }

  function toggleSender(index: number) {
    if (!parsed) return;
    const msgs = [...parsed.messages];
    msgs[index] = {
      ...msgs[index],
      sender: msgs[index].sender === 'lead' ? 'human' : 'lead'
    };
    setParsed({ ...parsed, messages: msgs });
  }

  return (
    <div className='mx-auto max-w-2xl space-y-6'>
      {/* Back button */}
      <Button
        variant='ghost'
        size='sm'
        onClick={() => router.push(`/dashboard/leads/${leadId}`)}
      >
        <ArrowLeft className='mr-1.5 h-4 w-4' />
        Back to Lead
      </Button>

      {/* Step: Paste */}
      {step === 'paste' && (
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              <MessageSquare className='h-5 w-5' />
              Paste DM Thread
            </CardTitle>
            <CardDescription>
              Copy the full conversation from Instagram, Facebook, or any
              messaging app and paste it below. The AI will identify who said
              what and structure it for import.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            <Textarea
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={`Paste the conversation here, e.g.:\n\nJohn: Hey I saw your post about forex\nYou: Hey John! What caught your attention?\nJohn: The part about making consistent returns\n...`}
              rows={14}
              className='font-mono text-sm'
            />
            <div className='flex justify-end'>
              <Button onClick={handleParse} disabled={!rawText.trim()}>
                Parse Thread
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Parsing */}
      {step === 'parsing' && (
        <Card>
          <CardContent className='flex flex-col items-center gap-4 py-16'>
            <Loader2 className='text-primary h-10 w-10 animate-spin' />
            <p className='text-muted-foreground text-sm font-medium'>
              Parsing conversation thread…
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step: Preview */}
      {step === 'preview' && parsed && (
        <div className='space-y-4'>
          {/* Warnings */}
          {parsed.warnings.length > 0 && (
            <div className='space-y-1.5'>
              {parsed.warnings.map((w, i) => (
                <div
                  key={i}
                  className='flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
                >
                  <AlertCircle className='mt-0.5 h-4 w-4 shrink-0' />
                  {w}
                </div>
              ))}
            </div>
          )}

          <Card>
            <CardHeader className='pb-3'>
              <div className='flex items-center justify-between'>
                <CardTitle className='text-base'>
                  Preview — {parsed.messages.length} message
                  {parsed.messages.length !== 1 ? 's' : ''}
                </CardTitle>
                {parsed.detectedLeadName && (
                  <Badge variant='secondary'>
                    Lead: {parsed.detectedLeadName}
                  </Badge>
                )}
              </div>
              <CardDescription>
                Review each message. Click the sender badge to flip it, or the ×
                to remove a message before importing.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className='max-h-[420px] space-y-2 overflow-y-auto pr-1'>
                {parsed.messages.map((msg, i) => (
                  <MessagePreviewRow
                    key={i}
                    msg={msg}
                    onToggleSender={() => toggleSender(i)}
                    onRemove={() => removeMessage(i)}
                  />
                ))}
                {parsed.messages.length === 0 && (
                  <p className='text-muted-foreground py-4 text-center text-sm'>
                    No messages to import.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className='flex justify-between'>
            <Button
              variant='outline'
              onClick={() => {
                setParsed(null);
                setStep('paste');
              }}
            >
              Back
            </Button>
            <Button
              onClick={handleImport}
              disabled={parsed.messages.length === 0}
            >
              Import {parsed.messages.length} Message
              {parsed.messages.length !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      )}

      {/* Step: Importing */}
      {step === 'importing' && (
        <Card>
          <CardContent className='flex flex-col items-center gap-4 py-16'>
            <Loader2 className='text-primary h-10 w-10 animate-spin' />
            <p className='text-muted-foreground text-sm font-medium'>
              Importing messages…
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step: Done */}
      {step === 'done' && importResult && (
        <Card>
          <CardContent className='flex flex-col items-center gap-4 py-12'>
            <CheckCircle2 className='h-12 w-12 text-green-500' />
            <div className='text-center'>
              <p className='text-lg font-semibold'>Import complete</p>
              <p className='text-muted-foreground mt-1 text-sm'>
                {importResult.importedCount} message
                {importResult.importedCount !== 1 ? 's' : ''} imported.
                {importResult.skippedCount > 0
                  ? ` ${importResult.skippedCount} empty message${importResult.skippedCount !== 1 ? 's' : ''} skipped.`
                  : ''}
              </p>
              <p className='text-muted-foreground mt-1 text-sm'>
                The AI can now see this history and will resume the conversation
                from where you left off.
              </p>
            </div>
            <div className='flex gap-3'>
              <Button
                variant='outline'
                onClick={() => {
                  setRawText('');
                  setParsed(null);
                  setImportResult(null);
                  setStep('paste');
                }}
              >
                Import Another Thread
              </Button>
              <Button
                onClick={() =>
                  router.push(
                    `/dashboard/conversations?conversationId=${leadId}`
                  )
                }
              >
                Open Conversation
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MessagePreviewRow({
  msg,
  onToggleSender,
  onRemove
}: {
  msg: ParsedMessage;
  onToggleSender: () => void;
  onRemove: () => void;
}) {
  const isLead = msg.sender === 'lead';
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
        isLead
          ? 'border-border bg-background'
          : 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/30'
      }`}
    >
      <button
        type='button'
        onClick={onToggleSender}
        title='Click to flip sender'
        className='mt-0.5 shrink-0'
      >
        {isLead ? (
          <User className='h-4 w-4 text-gray-500' />
        ) : (
          <UserCheck className='h-4 w-4 text-blue-500' />
        )}
      </button>
      <div className='min-w-0 flex-1'>
        <span className='text-[10px] font-medium tracking-wide text-gray-400 uppercase'>
          {isLead ? 'Lead' : 'You'}
        </span>
        <p className='mt-0.5 text-xs whitespace-pre-wrap'>{msg.content}</p>
        {msg.timestamp && (
          <p className='text-muted-foreground mt-1 text-[10px]'>
            {new Date(msg.timestamp).toLocaleString()}
          </p>
        )}
      </div>
      <button
        type='button'
        onClick={onRemove}
        title='Remove message'
        className='text-muted-foreground hover:text-destructive mt-0.5 shrink-0 text-xs'
      >
        ×
      </button>
    </div>
  );
}
