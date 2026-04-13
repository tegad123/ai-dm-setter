'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent
} from '@/components/ui/collapsible';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent
} from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import {
  Loader2,
  Upload,
  FileText,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Pencil,
  RotateCw,
  Trash2,
  Plus,
  Settings,
  X,
  Save
} from 'lucide-react';
import ScriptFrameworkView from '@/components/persona/script-framework-view';
import { SlotStatusSummary } from '@/components/persona/script-slot-cards';
import type { ScriptStep } from '@/lib/script-framework-types';
import type { ScriptSlot } from '@/lib/script-slot-types';
import type { VoiceNoteLibraryItem } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BreakdownSection {
  id: string;
  sectionType: string;
  title: string;
  content: string;
  sourceExcerpts: string[] | unknown;
  confidence: string;
  userEdited: boolean;
  userApproved: boolean;
  orderIndex: number;
}

interface BreakdownAmbiguity {
  id: string;
  question: string;
  suggestedDefault: string;
  userAnswer: string | null;
  resolved: boolean;
}

interface VoiceNoteSlotData {
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

interface Breakdown {
  id: string;
  sourceFileName: string | null;
  methodologySummary: string;
  methodologySummaryEdited: boolean;
  gaps: string[] | unknown;
  scriptSteps: ScriptStep[] | null;
  status: string;
  sections: BreakdownSection[];
  ambiguities: BreakdownAmbiguity[];
  voiceNoteSlots: VoiceNoteSlotData[];
  scriptSlots: ScriptSlot[];
  createdAt: string;
  updatedAt: string;
}

interface Persona {
  id: string;
  personaName: string;
  fullName: string;
  companyName: string;
  closerName: string;
  responseDelayMin: number;
  responseDelayMax: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function confidenceColor(c: string) {
  switch (c) {
    case 'high':
      return 'bg-green-100 text-green-800 border-green-300';
    case 'medium':
      return 'bg-amber-100 text-amber-800 border-amber-300';
    default:
      return 'bg-red-100 text-red-800 border-red-300';
  }
}

function statusBadge(status: string) {
  if (status === 'ACTIVE')
    return (
      <Badge className='border-green-300 bg-green-100 text-green-800'>
        Active
      </Badge>
    );
  if (status === 'DRAFT')
    return (
      <Badge className='border-amber-300 bg-amber-100 text-amber-800'>
        Draft
      </Badge>
    );
  return <Badge variant='secondary'>{status}</Badge>;
}

const ACCEPTED = '.pdf,.docx,.txt,.md';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PersonaPage() {
  // Core
  const [loading, setLoading] = useState(true);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [uploadStep, setUploadStep] = useState<'idle' | 'analyzing'>('idle');

  // Upload
  const [dragging, setDragging] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState('');

  // Section editing
  const [editingSectionId, setEditingSectionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [regeneratingSectionId, setRegeneratingSectionId] = useState<
    string | null
  >(null);

  // Add section
  const [showAddSection, setShowAddSection] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState('');
  const [newSectionContent, setNewSectionContent] = useState('');

  // Activation
  const [activating, setActivating] = useState(false);

  // Tabs
  const [activeTab, setActiveTab] = useState('behavior');

  // Library voice notes (for slot picker)
  const [libraryVoiceNotes, setLibraryVoiceNotes] = useState<
    VoiceNoteLibraryItem[]
  >([]);

  // Basic settings
  const [personaName, setPersonaName] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [closerName, setCloserName] = useState('');
  const [responseDelayMin, setResponseDelayMin] = useState(300);
  const [responseDelayMax, setResponseDelayMax] = useState(600);
  const [savingSettings, setSavingSettings] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // -------------------------------------------------------------------------
  // Data Fetching
  // -------------------------------------------------------------------------

  useEffect(() => {
    async function load() {
      try {
        const [personaRes, scriptRes, vnRes] = await Promise.all([
          apiFetch<{ persona: Persona | null }>('/settings/persona'),
          apiFetch<{ breakdown: Breakdown | null }>('/settings/persona/script'),
          apiFetch<{ items: VoiceNoteLibraryItem[] }>('/voice-notes').catch(
            () => ({ items: [] })
          )
        ]);
        setLibraryVoiceNotes(
          vnRes.items.filter((vn) => vn.status === 'ACTIVE')
        );
        if (personaRes.persona) {
          const p = personaRes.persona;
          setPersonaName(p.personaName || '');
          setFullName(p.fullName || '');
          setCompanyName(p.companyName || '');
          setCloserName(p.closerName || '');
          setResponseDelayMin(p.responseDelayMin ?? 300);
          setResponseDelayMax(p.responseDelayMax ?? 600);
        }
        if (scriptRes.breakdown) {
          setBreakdown(scriptRes.breakdown);
        }
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to load persona data'
        );
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleScriptUpload = useCallback(async (file: File) => {
    setUploadStep('analyzing');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte),
          ''
        )
      );
      const result = await apiFetch<{ breakdown: Breakdown }>(
        '/settings/persona/script',
        {
          method: 'POST',
          body: JSON.stringify({ pdfBase64: base64, fileName: file.name })
        }
      );
      setBreakdown(result.breakdown);
      toast.success('Script analyzed successfully');
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to analyze script'
      );
    } finally {
      setUploadStep('idle');
    }
  }, []);

  const handlePasteSubmit = useCallback(async () => {
    if (!pastedText.trim()) return;
    setUploadStep('analyzing');
    try {
      const result = await apiFetch<{ breakdown: Breakdown }>(
        '/settings/persona/script',
        {
          method: 'POST',
          body: JSON.stringify({ documentText: pastedText })
        }
      );
      setBreakdown(result.breakdown);
      setPasteMode(false);
      setPastedText('');
      toast.success('Script analyzed successfully');
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to analyze script'
      );
    } finally {
      setUploadStep('idle');
    }
  }, [pastedText]);

  const handleApproveSection = useCallback(
    async (sectionId: string, currentApproved: boolean) => {
      if (!breakdown) return;
      try {
        await apiFetch(`/settings/persona/script/${breakdown.id}/section`, {
          method: 'PUT',
          body: JSON.stringify({ sectionId, userApproved: !currentApproved })
        });
        setBreakdown((prev) =>
          prev
            ? {
                ...prev,
                sections: prev.sections.map((s) =>
                  s.id === sectionId
                    ? { ...s, userApproved: !currentApproved }
                    : s
                )
              }
            : prev
        );
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to update section'
        );
      }
    },
    [breakdown]
  );

  const handleSaveSection = useCallback(
    async (sectionId: string) => {
      if (!breakdown) return;
      try {
        await apiFetch(`/settings/persona/script/${breakdown.id}/section`, {
          method: 'PUT',
          body: JSON.stringify({
            sectionId,
            title: editTitle,
            content: editContent
          })
        });
        setBreakdown((prev) =>
          prev
            ? {
                ...prev,
                sections: prev.sections.map((s) =>
                  s.id === sectionId
                    ? {
                        ...s,
                        title: editTitle,
                        content: editContent,
                        userEdited: true
                      }
                    : s
                )
              }
            : prev
        );
        setEditingSectionId(null);
        toast.success('Section updated');
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to save section'
        );
      }
    },
    [breakdown, editTitle, editContent]
  );

  const handleRegenerateSection = useCallback(
    async (sectionId: string) => {
      if (!breakdown) return;
      setRegeneratingSectionId(sectionId);
      try {
        const result = await apiFetch<{ section: BreakdownSection }>(
          `/settings/persona/script/${breakdown.id}/section`,
          {
            method: 'POST',
            body: JSON.stringify({ sectionId })
          }
        );
        setBreakdown((prev) =>
          prev
            ? {
                ...prev,
                sections: prev.sections.map((s) =>
                  s.id === sectionId ? result.section : s
                )
              }
            : prev
        );
        toast.success('Section regenerated');
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to regenerate section'
        );
      } finally {
        setRegeneratingSectionId(null);
      }
    },
    [breakdown]
  );

  const handleDeleteSection = useCallback(
    async (sectionId: string) => {
      if (!breakdown || !confirm('Delete this section? This cannot be undone.'))
        return;
      try {
        await apiFetch(
          `/settings/persona/script/${breakdown.id}/section?sectionId=${sectionId}`,
          {
            method: 'DELETE'
          }
        );
        setBreakdown((prev) =>
          prev
            ? {
                ...prev,
                sections: prev.sections.filter((s) => s.id !== sectionId)
              }
            : prev
        );
        toast.success('Section deleted');
      } catch (err: unknown) {
        toast.error(
          err instanceof Error ? err.message : 'Failed to delete section'
        );
      }
    },
    [breakdown]
  );

  const handleAddSection = useCallback(async () => {
    if (!breakdown || !newSectionTitle.trim() || !newSectionContent.trim())
      return;
    try {
      const result = await apiFetch<{ section: BreakdownSection }>(
        `/settings/persona/script/${breakdown.id}/section`,
        {
          method: 'PUT',
          body: JSON.stringify({
            title: newSectionTitle,
            content: newSectionContent
          })
        }
      );
      setBreakdown((prev) =>
        prev
          ? {
              ...prev,
              sections: [...prev.sections, result.section]
            }
          : prev
      );
      setShowAddSection(false);
      setNewSectionTitle('');
      setNewSectionContent('');
      toast.success('Section added');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add section');
    }
  }, [breakdown, newSectionTitle, newSectionContent]);

  // Sprint 3: Handle slot updates from inline slot cards
  const handleSlotUpdate = useCallback((updatedSlot: ScriptSlot) => {
    setBreakdown((prev) =>
      prev
        ? {
            ...prev,
            scriptSlots: prev.scriptSlots.map((s) =>
              s.id === updatedSlot.id ? updatedSlot : s
            )
          }
        : prev
    );
  }, []);

  const handleActivate = useCallback(async () => {
    if (!breakdown) return;
    setActivating(true);
    try {
      const result = await apiFetch<{ breakdown: Breakdown }>(
        `/settings/persona/script/${breakdown.id}/activate`,
        {
          method: 'POST'
        }
      );
      setBreakdown(result.breakdown);
      toast.success('Persona activated!');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to activate');
    } finally {
      setActivating(false);
    }
  }, [breakdown]);

  const handleSaveSettings = useCallback(async () => {
    setSavingSettings(true);
    try {
      await apiFetch('/settings/persona', {
        method: 'PUT',
        body: JSON.stringify({
          personaName,
          fullName,
          companyName,
          closerName,
          responseDelayMin,
          responseDelayMax
        })
      });
      toast.success('Settings saved');
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : 'Failed to save settings'
      );
    } finally {
      setSavingSettings(false);
    }
  }, [
    personaName,
    fullName,
    companyName,
    closerName,
    responseDelayMin,
    responseDelayMax
  ]);

  // -------------------------------------------------------------------------
  // Drag & Drop
  // -------------------------------------------------------------------------

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleScriptUpload(file);
    },
    [handleScriptUpload]
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleScriptUpload(file);
    },
    [handleScriptUpload]
  );

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const approvedCount =
    breakdown?.sections.filter((s) => s.userApproved).length ?? 0;
  const gaps = Array.isArray(breakdown?.gaps)
    ? (breakdown.gaps as string[])
    : [];
  const blockingSlotCount =
    breakdown?.voiceNoteSlots?.filter(
      (s) => s.status === 'EMPTY' && s.fallbackBehavior === 'BLOCK_UNTIL_FILLED'
    ).length ?? 0;

  // Sprint 3: Lenient activation — only blocking VN slots and no approved sections gate activation.
  const canActivate = approvedCount > 0 && blockingSlotCount === 0;
  const isActive = breakdown?.status === 'ACTIVE';

  // Count unfilled slots for warning
  const unfilledSlotCount =
    breakdown?.scriptSlots?.filter(
      (s) => s.status === 'unfilled' && s.slotType !== 'runtime_judgment'
    ).length ?? 0;

  let activateTooltip = '';
  if (approvedCount === 0)
    activateTooltip = 'Approve at least one section first';
  else if (blockingSlotCount > 0)
    activateTooltip = `${blockingSlotCount} voice note slot(s) need audio or a fallback`;

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className='flex min-h-[60vh] items-center justify-center'>
        <Loader2 className='text-muted-foreground h-8 w-8 animate-spin' />
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className='mx-auto max-w-3xl space-y-6 px-4 py-8'>
      {/* 1. Header */}
      <div>
        <h1 className='text-2xl font-bold tracking-tight'>AI Persona</h1>
        <p className='text-muted-foreground mt-1'>
          Upload your sales script and the AI will learn exactly how you sell.
        </p>
      </div>

      {/* 2. Upload Card (when no breakdown) */}
      {!breakdown && uploadStep === 'idle' && (
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              <Upload className='h-5 w-5' /> Upload Your Sales Script
            </CardTitle>
            <CardDescription>
              Accepted formats: PDF, DOCX, TXT, Markdown. Drag and drop or click
              to select.
            </CardDescription>
          </CardHeader>
          <CardContent className='space-y-4'>
            {/* Drop zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-10 transition-colors ${
                dragging
                  ? 'border-primary bg-primary/5'
                  : 'border-muted-foreground/25 hover:border-muted-foreground/50'
              }`}
              onClick={() =>
                document.getElementById('script-file-input')?.click()
              }
            >
              <FileText className='text-muted-foreground mb-3 h-10 w-10' />
              <p className='text-muted-foreground text-center text-sm'>
                {dragging
                  ? 'Drop your file here'
                  : 'Drag and drop your script here, or click to browse'}
              </p>
              <input
                id='script-file-input'
                type='file'
                accept={ACCEPTED}
                className='hidden'
                onChange={onFileInput}
              />
            </div>

            <Separator />

            {/* Paste toggle */}
            {!pasteMode ? (
              <Button
                variant='outline'
                className='w-full'
                onClick={() => setPasteMode(true)}
              >
                Or paste your script
              </Button>
            ) : (
              <div className='space-y-3'>
                <Textarea
                  placeholder='Paste your sales script here...'
                  rows={8}
                  value={pastedText}
                  onChange={(e) => setPastedText(e.target.value)}
                />
                <div className='flex gap-2'>
                  <Button
                    onClick={handlePasteSubmit}
                    disabled={!pastedText.trim()}
                  >
                    Analyze Script
                  </Button>
                  <Button
                    variant='ghost'
                    onClick={() => {
                      setPasteMode(false);
                      setPastedText('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Analyzing progress */}
      {uploadStep === 'analyzing' && (
        <Card>
          <CardContent className='flex flex-col items-center justify-center gap-4 py-16'>
            <div className='w-full max-w-xs space-y-3'>
              <div className='bg-secondary h-2 w-full overflow-hidden rounded-full'>
                <div className='bg-primary h-full animate-[progress_90s_ease-in-out_forwards] rounded-full' />
              </div>
              <p className='text-muted-foreground text-center font-medium'>
                Analyzing your script...
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3. Breakdown Review */}
      {breakdown && uploadStep === 'idle' && (
        <>
          {/* 3a. Status bar */}
          <Card>
            <CardContent className='flex flex-wrap items-center gap-4 py-4'>
              <div className='flex items-center gap-2 text-sm'>
                <FileText className='text-muted-foreground h-4 w-4' />
                <span className='text-muted-foreground'>
                  {breakdown.sourceFileName || 'Pasted text'}
                </span>
              </div>
              {statusBadge(breakdown.status)}
              <span className='text-muted-foreground text-sm'>
                {breakdown.sections.length} section
                {breakdown.sections.length !== 1 ? 's' : ''}
              </span>
              <span className='text-muted-foreground text-sm'>
                {approvedCount} approved
              </span>
            </CardContent>
          </Card>

          {/* Tabs: Behavior | Script Framework */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className='w-full'>
              <TabsTrigger value='behavior' className='flex-1'>
                Behavior Settings
              </TabsTrigger>
              <TabsTrigger value='framework' className='flex-1'>
                Script Framework
                {(breakdown.scriptSteps?.length ?? 0) > 0 && (
                  <Badge variant='secondary' className='ml-1.5 text-xs'>
                    {breakdown.scriptSteps?.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            {/* ── Behavior Settings Tab ── */}
            <TabsContent value='behavior' className='mt-4 space-y-6'>
              {/* Sprint 3: Slot Status Summary */}
              {(breakdown.scriptSlots?.length ?? 0) > 0 && (
                <SlotStatusSummary slots={breakdown.scriptSlots} />
              )}

              {/* Sprint 3: Warning banner for unfilled slots */}
              {unfilledSlotCount > 0 && (
                <div className='flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/50 px-4 py-3'>
                  <AlertCircle className='h-4 w-4 shrink-0 text-amber-600' />
                  <p className='text-sm text-amber-800'>
                    You have {unfilledSlotCount} unfilled slot
                    {unfilledSlotCount !== 1 ? 's' : ''}. The AI will fall back
                    to text or skip these actions at runtime. Fill them in the
                    Script Framework tab for best results.
                  </p>
                </div>
              )}

              {/* 3c. Methodology Summary */}
              {breakdown.methodologySummary && (
                <Card>
                  <CardHeader>
                    <CardTitle className='text-base'>
                      Methodology Summary
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className='text-sm leading-relaxed'>
                      {breakdown.methodologySummary}
                    </p>
                  </CardContent>
                </Card>
              )}

              {/* 3d. Sections */}
              <div className='space-y-4'>
                <h2 className='text-lg font-semibold'>Sections</h2>
                {breakdown.sections
                  .sort((a, b) => a.orderIndex - b.orderIndex)
                  .map((section) => {
                    const isEditing = editingSectionId === section.id;
                    const isRegenerating = regeneratingSectionId === section.id;
                    const excerpts = Array.isArray(section.sourceExcerpts)
                      ? (section.sourceExcerpts as string[])
                      : [];
                    return (
                      <Card
                        key={section.id}
                        className={
                          section.userApproved
                            ? 'border-l-4 border-l-green-500'
                            : ''
                        }
                      >
                        <CardHeader className='pb-2'>
                          <div className='flex flex-wrap items-center gap-3'>
                            {isEditing ? (
                              <Input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className='max-w-xs'
                              />
                            ) : (
                              <CardTitle className='text-base'>
                                {section.title}
                              </CardTitle>
                            )}
                            <Badge
                              className={confidenceColor(section.confidence)}
                            >
                              {section.confidence}
                            </Badge>
                            {section.userEdited && (
                              <Badge variant='secondary' className='text-xs'>
                                Edited
                              </Badge>
                            )}
                            <div className='ml-auto flex items-center gap-2'>
                              <label className='flex cursor-pointer items-center gap-1.5 text-sm'>
                                <Checkbox
                                  checked={section.userApproved}
                                  onCheckedChange={() =>
                                    handleApproveSection(
                                      section.id,
                                      section.userApproved
                                    )
                                  }
                                />
                                Approved
                              </label>
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className='space-y-3'>
                          {isEditing ? (
                            <Textarea
                              value={editContent}
                              onChange={(e) => setEditContent(e.target.value)}
                              rows={6}
                            />
                          ) : (
                            <p className='text-sm leading-relaxed whitespace-pre-wrap'>
                              {section.content}
                            </p>
                          )}

                          {/* Source excerpts */}
                          {excerpts.length > 0 && (
                            <Collapsible>
                              <CollapsibleTrigger className='text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors'>
                                <ChevronRight className='h-3 w-3' />
                                Based on your script
                              </CollapsibleTrigger>
                              <CollapsibleContent className='mt-2 space-y-1'>
                                {excerpts.map((ex, i) => (
                                  <p
                                    key={i}
                                    className='text-muted-foreground border-muted border-l-2 pl-4 text-xs italic'
                                  >
                                    {ex}
                                  </p>
                                ))}
                              </CollapsibleContent>
                            </Collapsible>
                          )}

                          {/* Action buttons */}
                          <div className='flex items-center gap-2 pt-1'>
                            {isEditing ? (
                              <>
                                <Button
                                  size='sm'
                                  onClick={() => handleSaveSection(section.id)}
                                >
                                  <Save className='mr-1 h-3.5 w-3.5' /> Save
                                </Button>
                                <Button
                                  size='sm'
                                  variant='ghost'
                                  onClick={() => setEditingSectionId(null)}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <Button
                                size='sm'
                                variant='outline'
                                onClick={() => {
                                  setEditingSectionId(section.id);
                                  setEditTitle(section.title);
                                  setEditContent(section.content);
                                }}
                              >
                                <Pencil className='mr-1 h-3.5 w-3.5' /> Edit
                              </Button>
                            )}
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={isRegenerating}
                              onClick={() =>
                                handleRegenerateSection(section.id)
                              }
                            >
                              {isRegenerating ? (
                                <Loader2 className='mr-1 h-3.5 w-3.5 animate-spin' />
                              ) : (
                                <RotateCw className='mr-1 h-3.5 w-3.5' />
                              )}
                              Regenerate
                            </Button>
                            <Button
                              size='sm'
                              variant='outline'
                              className='text-destructive hover:text-destructive'
                              onClick={() => handleDeleteSection(section.id)}
                            >
                              <Trash2 className='mr-1 h-3.5 w-3.5' /> Delete
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}

                {/* 3e. Add Section */}
                {showAddSection ? (
                  <Card>
                    <CardHeader>
                      <CardTitle className='text-base'>
                        Add Custom Section
                      </CardTitle>
                    </CardHeader>
                    <CardContent className='space-y-3'>
                      <div className='space-y-1.5'>
                        <Label>Title</Label>
                        <Input
                          value={newSectionTitle}
                          onChange={(e) => setNewSectionTitle(e.target.value)}
                          placeholder='Section title'
                        />
                      </div>
                      <div className='space-y-1.5'>
                        <Label>Content</Label>
                        <Textarea
                          value={newSectionContent}
                          onChange={(e) => setNewSectionContent(e.target.value)}
                          placeholder='Section content...'
                          rows={4}
                        />
                      </div>
                      <div className='flex gap-2'>
                        <Button
                          size='sm'
                          onClick={handleAddSection}
                          disabled={
                            !newSectionTitle.trim() || !newSectionContent.trim()
                          }
                        >
                          <Save className='mr-1 h-3.5 w-3.5' /> Save
                        </Button>
                        <Button
                          size='sm'
                          variant='ghost'
                          onClick={() => {
                            setShowAddSection(false);
                            setNewSectionTitle('');
                            setNewSectionContent('');
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Button
                    variant='outline'
                    onClick={() => setShowAddSection(true)}
                  >
                    <Plus className='mr-1 h-4 w-4' /> Add Section
                  </Button>
                )}
              </div>

              {/* 3f. Gaps Panel */}
              {gaps.length > 0 && (
                <Collapsible>
                  <Card>
                    <CollapsibleTrigger asChild>
                      <CardHeader className='hover:bg-muted/50 cursor-pointer transition-colors'>
                        <CardTitle className='flex items-center gap-2 text-base'>
                          <ChevronDown className='h-4 w-4' />
                          What your script doesn&apos;t cover ({gaps.length})
                        </CardTitle>
                      </CardHeader>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <CardContent>
                        <ul className='list-disc space-y-1 pl-5'>
                          {gaps.map((g, i) => (
                            <li
                              key={i}
                              className='text-muted-foreground text-sm'
                            >
                              {g}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </CollapsibleContent>
                  </Card>
                </Collapsible>
              )}
            </TabsContent>

            {/* ── Script Framework Tab ── */}
            <TabsContent value='framework' className='mt-4'>
              <ScriptFrameworkView
                breakdownId={breakdown.id}
                scriptSteps={(breakdown.scriptSteps as ScriptStep[]) || []}
                scriptSlots={breakdown.scriptSlots || []}
                libraryVoiceNotes={libraryVoiceNotes}
                onStepsChange={(steps) =>
                  setBreakdown({ ...breakdown, scriptSteps: steps })
                }
                onSlotUpdate={handleSlotUpdate}
              />
            </TabsContent>
          </Tabs>

          {/* 3g. Global Actions */}
          <Card>
            <CardContent className='flex flex-wrap items-center gap-3 py-4'>
              <Button variant='outline' onClick={() => setBreakdown(null)}>
                <Upload className='mr-1 h-4 w-4' /> Re-upload Script
              </Button>
              <Button variant='outline' onClick={() => setBreakdown(null)}>
                <RotateCw className='mr-1 h-4 w-4' /> Regenerate All
              </Button>
              <div className='ml-auto'>
                {canActivate ? (
                  <Button onClick={handleActivate} disabled={activating}>
                    {activating && (
                      <Loader2 className='mr-1 h-4 w-4 animate-spin' />
                    )}
                    {isActive ? 'Reactivate' : 'Activate Persona'}
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0}>
                        <Button disabled>
                          {isActive ? 'Reactivate' : 'Activate Persona'}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{activateTooltip}</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {isActive && (
                <Badge className='border-green-300 bg-green-100 text-green-800'>
                  Active
                </Badge>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* 4. Basic Settings (collapsible) */}
      <Collapsible open={showSettings} onOpenChange={setShowSettings}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className='hover:bg-muted/50 cursor-pointer transition-colors'>
              <CardTitle className='flex items-center gap-2 text-base'>
                <Settings className='h-4 w-4' />
                Basic Settings
                {showSettings ? (
                  <ChevronDown className='ml-auto h-4 w-4' />
                ) : (
                  <ChevronRight className='ml-auto h-4 w-4' />
                )}
              </CardTitle>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className='space-y-4'>
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label htmlFor='personaName'>Persona Name</Label>
                  <Input
                    id='personaName'
                    value={personaName}
                    onChange={(e) => setPersonaName(e.target.value)}
                    placeholder='e.g. Sales AI'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='fullName'>Full Name</Label>
                  <Input
                    id='fullName'
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder='Your full name'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='companyName'>Company Name</Label>
                  <Input
                    id='companyName'
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    placeholder='Your company'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='closerName'>Closer Name</Label>
                  <Input
                    id='closerName'
                    value={closerName}
                    onChange={(e) => setCloserName(e.target.value)}
                    placeholder='Sales closer name'
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='delayMin'>Response Delay Min (seconds)</Label>
                  <Input
                    id='delayMin'
                    type='number'
                    value={responseDelayMin}
                    onChange={(e) =>
                      setResponseDelayMin(Number(e.target.value))
                    }
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='delayMax'>Response Delay Max (seconds)</Label>
                  <Input
                    id='delayMax'
                    type='number'
                    value={responseDelayMax}
                    onChange={(e) =>
                      setResponseDelayMax(Number(e.target.value))
                    }
                  />
                </div>
              </div>
              <Button onClick={handleSaveSettings} disabled={savingSettings}>
                {savingSettings && (
                  <Loader2 className='mr-1 h-4 w-4 animate-spin' />
                )}
                Save Settings
              </Button>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
