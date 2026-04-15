'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import {
  Loader2,
  ArrowLeft,
  Save,
  Trash2,
  ChevronDown,
  RotateCw,
  AlertCircle,
  CheckCircle2,
  Clock,
  Pencil
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getVoiceNote,
  updateVoiceNote,
  deleteVoiceNote,
  retryVoiceNote
} from '@/lib/api';
import type { VoiceNoteLibraryItem } from '@/lib/api';
import {
  parseTriggerJson,
  generateTriggerDescription
} from '@/lib/voice-note-triggers';
import type { VoiceNoteTrigger } from '@/lib/voice-note-triggers';
import TriggerBuilder from './trigger-builder';
import ChipSelector from './chip-selector';
import SuggestionPanel from './suggestion-panel';

const USE_CASE_SUGGESTIONS = [
  'social_proof',
  'objection_handling',
  'origin_story',
  'testimonial',
  'rapport_building',
  'closing_push',
  'follow_up',
  'pre_call_hype',
  'educational',
  'motivational',
  'pricing_explanation',
  'risk_reassurance',
  'introduction',
  'time_sensitivity'
];

const LEAD_TYPE_SUGGESTIONS = [
  'beginner',
  'experienced',
  'price_sensitive',
  'high_intent',
  'skeptical',
  'returning',
  'warm_inbound',
  'cold_outreach',
  'no_results_yet'
];

const CONVERSATION_STAGE_SUGGESTIONS = [
  'opener',
  'qualifying',
  'situation_discovery',
  'objection_handling',
  'financial_screening',
  'closing',
  'booking',
  'follow_up',
  'post_booking'
];

const EMOTIONAL_TONES = [
  'confident',
  'empathetic',
  'urgent',
  'casual',
  'serious',
  'motivational',
  'storytelling',
  'educational',
  'direct',
  'reassuring'
];

function statusBadge(status: VoiceNoteLibraryItem['status']) {
  switch (status) {
    case 'PROCESSING':
      return (
        <Badge className='border-blue-300 bg-blue-100 text-blue-800'>
          <Loader2 className='mr-1 h-3 w-3 animate-spin' />
          Processing
        </Badge>
      );
    case 'NEEDS_REVIEW':
      return (
        <Badge className='border-amber-300 bg-amber-100 text-amber-800'>
          <Clock className='mr-1 h-3 w-3' />
          Needs Review
        </Badge>
      );
    case 'ACTIVE':
      return (
        <Badge className='border-green-300 bg-green-100 text-green-800'>
          <CheckCircle2 className='mr-1 h-3 w-3' />
          Active
        </Badge>
      );
    case 'DISABLED':
      return (
        <Badge className='border-gray-300 bg-gray-100 text-gray-800'>
          Disabled
        </Badge>
      );
    case 'FAILED':
      return (
        <Badge className='border-red-300 bg-red-100 text-red-800'>
          <AlertCircle className='mr-1 h-3 w-3' />
          Failed
        </Badge>
      );
  }
}

export default function VoiceNoteReview({ id }: { id: string }) {
  const router = useRouter();
  const [item, setItem] = useState<VoiceNoteLibraryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Form state
  const [transcript, setTranscript] = useState('');
  const [editingTranscript, setEditingTranscript] = useState(false);
  const [summary, setSummary] = useState('');
  const [useCases, setUseCases] = useState<string[]>([]);
  const [leadTypes, setLeadTypes] = useState<string[]>([]);
  const [conversationStages, setConversationStages] = useState<string[]>([]);
  const [emotionalTone, setEmotionalTone] = useState('');
  const [triggerConditions, setTriggerConditions] = useState('');
  const [triggers, setTriggers] = useState<VoiceNoteTrigger[]>([]);
  const [userLabel, setUserLabel] = useState('');
  const [userNotes, setUserNotes] = useState('');
  const [priority, setPriority] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [suggestionApproved, setSuggestionApproved] = useState(false);

  const loadItem = useCallback(async () => {
    try {
      const res = await getVoiceNote(id);
      setItem(res.item);
      populateForm(res.item);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to load voice note'
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  function populateForm(i: VoiceNoteLibraryItem) {
    setTranscript(i.transcript || '');
    setSummary(i.summary || '');
    setUseCases(i.useCases || []);
    setLeadTypes(i.leadTypes || []);
    setConversationStages(i.conversationStages || []);
    setEmotionalTone(i.emotionalTone || '');
    setTriggerConditions(i.triggerConditionsNatural || '');
    setTriggers(parseTriggerJson(i.triggers));
    setUserLabel(i.userLabel || '');
    setUserNotes(i.userNotes || '');
    setPriority(i.priority || 0);
  }

  useEffect(() => {
    loadItem();
  }, [loadItem]);

  // Poll while PROCESSING
  useEffect(() => {
    if (item?.status !== 'PROCESSING') return;
    const interval = setInterval(async () => {
      try {
        const res = await getVoiceNote(id);
        if (res.item.status !== 'PROCESSING') {
          setItem(res.item);
          populateForm(res.item);
          clearInterval(interval);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [item?.status, id]);

  async function handleSave(activate: boolean) {
    setSaving(true);
    try {
      const res = await updateVoiceNote(id, {
        transcript,
        summary,
        useCases,
        leadTypes,
        conversationStages,
        emotionalTone,
        triggerConditionsNatural: triggerConditions,
        triggers: triggers.length > 0 ? triggers : null,
        triggerDescription:
          triggers.length > 0 ? generateTriggerDescription(triggers) : null,
        userLabel,
        userNotes,
        priority,
        active: activate
      });
      setItem(res.item);
      toast.success(activate ? 'Voice note activated!' : 'Voice note saved');
      router.push('/dashboard/voice-notes');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to save voice note'
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteVoiceNote(id);
      toast.success('Voice note deleted');
      router.push('/dashboard/voice-notes');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to delete voice note'
      );
    }
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await retryVoiceNote(id);
      setItem((prev) =>
        prev ? { ...prev, status: 'PROCESSING', errorMessage: null } : prev
      );
      toast.success('Retrying processing...');
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to retry processing'
      );
    } finally {
      setRetrying(false);
    }
  }

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Loader2 className='text-primary h-8 w-8 animate-spin' />
      </div>
    );
  }

  if (!item) {
    return (
      <div className='mx-auto max-w-3xl p-6'>
        <p className='text-muted-foreground'>Voice note not found.</p>
      </div>
    );
  }

  const isProcessing = item.status === 'PROCESSING';
  const isFailed = item.status === 'FAILED';

  return (
    <div className='mx-auto max-w-3xl space-y-6 p-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-3'>
          <Button
            variant='ghost'
            size='icon'
            onClick={() => router.push('/dashboard/voice-notes')}
          >
            <ArrowLeft className='h-4 w-4' />
          </Button>
          <div>
            <h1 className='text-xl font-bold'>
              {item.userLabel || 'Voice Note Review'}
            </h1>
            <div className='mt-1 flex items-center gap-2'>
              {statusBadge(item.status)}
            </div>
          </div>
        </div>

        <div className='flex items-center gap-2'>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant='outline' size='sm'>
                <Trash2 className='mr-1.5 h-3.5 w-3.5' />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete voice note?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete the audio file and all metadata.
                  This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Processing state */}
      {isProcessing && (
        <Card>
          <CardContent className='flex flex-col items-center gap-4 py-10'>
            <Loader2 className='text-primary h-10 w-10 animate-spin' />
            <p className='font-medium'>Processing your voice note...</p>
            <p className='text-muted-foreground text-sm'>
              Transcribing audio, generating labels, and creating embeddings.
              This usually takes 15-30 seconds.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Failed state */}
      {isFailed && (
        <Card className='border-red-200'>
          <CardContent className='flex items-center gap-4 py-4'>
            <AlertCircle className='h-6 w-6 shrink-0 text-red-500' />
            <div className='flex-1'>
              <p className='font-medium text-red-800'>Processing failed</p>
              {item.errorMessage && (
                <p className='text-sm text-red-600'>{item.errorMessage}</p>
              )}
            </div>
            <Button onClick={handleRetry} disabled={retrying}>
              {retrying ? (
                <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
              ) : (
                <RotateCw className='mr-1.5 h-4 w-4' />
              )}
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Audio player */}
      <Card>
        <CardContent className='py-4'>
          <audio
            controls
            src={item.audioFileUrl}
            className='w-full'
            preload='metadata'
          />
          <p className='text-muted-foreground mt-2 text-xs'>
            Duration: ~{Math.round(item.durationSeconds)}s
          </p>
        </CardContent>
      </Card>

      {/* Only show form fields if not in PROCESSING state */}
      {!isProcessing && (
        <>
          {/* Transcript */}
          <Card>
            <CardHeader className='pb-3'>
              <div className='flex items-center justify-between'>
                <CardTitle className='text-base'>Transcript</CardTitle>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setEditingTranscript(!editingTranscript)}
                >
                  <Pencil className='mr-1 h-3.5 w-3.5' />
                  {editingTranscript ? 'Lock' : 'Edit'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {editingTranscript ? (
                <Textarea
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                  rows={6}
                />
              ) : (
                <p className='text-muted-foreground text-sm whitespace-pre-wrap'>
                  {transcript || 'No transcript available'}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Summary */}
          <Card>
            <CardHeader className='pb-3'>
              <CardTitle className='text-base'>Summary</CardTitle>
              <CardDescription>
                AI-generated description of this voice note
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={2}
                placeholder='1-2 sentence summary of what this voice note covers'
              />
            </CardContent>
          </Card>

          {/* Migration Review Banner */}
          {item?.status === 'NEEDS_REVIEW' && item?.legacyTriggerText && (
            <Card className='border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'>
              <CardHeader className='pb-3'>
                <CardTitle className='text-base'>
                  Trigger Migration Review
                </CardTitle>
                <CardDescription>
                  This voice note&apos;s triggers were auto-converted from free
                  text. Review and approve below.
                </CardDescription>
              </CardHeader>
              <CardContent className='space-y-4'>
                <div className='space-y-1.5'>
                  <Label className='text-muted-foreground text-xs'>
                    Original Trigger Text
                  </Label>
                  <p className='rounded-md border bg-white p-3 text-sm dark:bg-black'>
                    {item.legacyTriggerText}
                  </p>
                </div>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    onClick={() => handleSave(true)}
                    disabled={saving}
                  >
                    <CheckCircle2 className='mr-1.5 h-4 w-4' />
                    Looks Good — Activate
                  </Button>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => {
                      // Scroll to triggers section
                      document
                        .getElementById('trigger-builder-section')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    <Pencil className='mr-1.5 h-4 w-4' />
                    Edit Triggers
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Metadata */}
          <Card>
            <CardHeader className='pb-3'>
              <CardTitle className='text-base'>Labels & Metadata</CardTitle>
            </CardHeader>
            <CardContent className='space-y-5'>
              {/* User label */}
              <div className='space-y-1.5'>
                <Label>Voice Note Name</Label>
                <Input
                  value={userLabel}
                  onChange={(e) => setUserLabel(e.target.value)}
                  placeholder='e.g., Risk Management Pep Talk'
                />
              </div>

              {/* Two-column grid */}
              <div className='grid gap-5 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label>Use Cases</Label>
                  <ChipSelector
                    suggestions={USE_CASE_SUGGESTIONS}
                    selected={useCases}
                    onChange={setUseCases}
                    placeholder='Add use case...'
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label>Lead Types</Label>
                  <ChipSelector
                    suggestions={LEAD_TYPE_SUGGESTIONS}
                    selected={leadTypes}
                    onChange={setLeadTypes}
                    placeholder='Add lead type...'
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label>Conversation Stages</Label>
                  <ChipSelector
                    suggestions={CONVERSATION_STAGE_SUGGESTIONS}
                    selected={conversationStages}
                    onChange={setConversationStages}
                    placeholder='Add stage...'
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label>Emotional Tone</Label>
                  <Select
                    value={emotionalTone}
                    onValueChange={setEmotionalTone}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder='Select tone' />
                    </SelectTrigger>
                    <SelectContent>
                      {EMOTIONAL_TONES.map((tone) => (
                        <SelectItem key={tone} value={tone}>
                          {tone.charAt(0).toUpperCase() + tone.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* AI-Suggested Triggers (Sprint 4) */}
              {item?.suggestionStatus === 'pending' &&
                item?.autoSuggestedTriggers &&
                !suggestionApproved && (
                  <div className='sm:col-span-2'>
                    <SuggestionPanel
                      voiceNoteId={item.id}
                      triggers={parseTriggerJson(item.autoSuggestedTriggers)}
                      status={item.suggestionStatus}
                      onApproved={(approved) => {
                        setTriggers(approved);
                        setSuggestionApproved(true);
                      }}
                      onRejected={() => {
                        setItem((prev) =>
                          prev
                            ? { ...prev, suggestionStatus: 'rejected' }
                            : prev
                        );
                      }}
                      onEditRequested={() => {
                        // Pre-fill TriggerBuilder with suggested triggers for editing
                        setTriggers(
                          parseTriggerJson(item.autoSuggestedTriggers)
                        );
                        setItem((prev) =>
                          prev
                            ? { ...prev, suggestionStatus: 'rejected' }
                            : prev
                        );
                        document
                          .getElementById('trigger-builder-section')
                          ?.scrollIntoView({ behavior: 'smooth' });
                      }}
                    />
                  </div>
                )}

              {/* Approved badge */}
              {suggestionApproved && (
                <div className='sm:col-span-2'>
                  <Badge className='border-green-300 bg-green-100 text-green-800'>
                    <CheckCircle2 className='mr-1 h-3 w-3' />
                    Triggers approved from AI suggestion
                  </Badge>
                </div>
              )}

              {/* Structured triggers */}
              <div id='trigger-builder-section' className='sm:col-span-2'>
                <TriggerBuilder
                  triggers={triggers}
                  onChange={setTriggers}
                  legacyText={item?.legacyTriggerText}
                />
              </div>

              {/* User notes */}
              <div className='space-y-1.5'>
                <Label>Notes (optional)</Label>
                <Textarea
                  value={userNotes}
                  onChange={(e) => setUserNotes(e.target.value)}
                  rows={2}
                  placeholder='Any personal notes about this voice note'
                />
              </div>
            </CardContent>
          </Card>

          {/* Advanced */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <Card>
              <CollapsibleTrigger className='w-full'>
                <CardHeader className='flex-row items-center justify-between pb-3'>
                  <CardTitle className='text-base'>Advanced</CardTitle>
                  <ChevronDown
                    className={`text-muted-foreground h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                  />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className='space-y-4'>
                  <div className='space-y-2'>
                    <Label>Priority ({priority})</Label>
                    <Slider
                      value={[priority]}
                      onValueChange={([v]) => setPriority(v)}
                      min={0}
                      max={10}
                      step={1}
                    />
                    <p className='text-muted-foreground text-xs'>
                      Higher priority voice notes are preferred when multiple
                      match the same conversation moment.
                    </p>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Action buttons */}
          <Separator />
          <div className='flex items-center justify-between'>
            <Button
              variant='outline'
              onClick={() => router.push('/dashboard/voice-notes')}
            >
              Cancel
            </Button>
            <div className='flex gap-2'>
              <Button
                variant='outline'
                onClick={() => handleSave(false)}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
                ) : (
                  <Save className='mr-1.5 h-4 w-4' />
                )}
                Save as Disabled
              </Button>
              <Button onClick={() => handleSave(true)} disabled={saving}>
                {saving ? (
                  <Loader2 className='mr-1.5 h-4 w-4 animate-spin' />
                ) : (
                  <CheckCircle2 className='mr-1.5 h-4 w-4' />
                )}
                Save & Activate
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
