'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import { Plus, Trash2, X, MessageSquareText, Upload } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrainingExample {
  id: string;
  personaId: string;
  category: string;
  leadMessage: string;
  idealResponse: string;
  createdAt: string;
}

const CATEGORIES = [
  'GREETING',
  'QUALIFICATION',
  'OBJECTION_TRUST',
  'OBJECTION_MONEY',
  'OBJECTION_TIME',
  'OBJECTION_PRIOR_FAILURE',
  'CLOSING',
  'FOLLOW_UP',
  'STALL_TIME',
  'STALL_MONEY',
  'STALL_THINK',
  'STALL_PARTNER',
  'GHOST_SEQUENCE',
  'NO_SHOW',
  'PRE_CALL_NURTURE',
  'ORIGIN_STORY',
  'PROOF_POINT',
  'GENERAL'
] as const;

type Category = (typeof CATEGORIES)[number];

const CATEGORY_COLORS: Record<Category, string> = {
  GREETING: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  QUALIFICATION:
    'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  OBJECTION_TRUST:
    'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  OBJECTION_MONEY: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300',
  OBJECTION_TIME:
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  OBJECTION_PRIOR_FAILURE:
    'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
  CLOSING: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  FOLLOW_UP: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-300',
  STALL_TIME: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-300',
  STALL_MONEY: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300',
  STALL_THINK:
    'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300',
  STALL_PARTNER:
    'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300',
  GHOST_SEQUENCE:
    'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300',
  NO_SHOW: 'bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
  PRE_CALL_NURTURE:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300',
  ORIGIN_STORY: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-300',
  PROOF_POINT: 'bg-lime-100 text-lime-800 dark:bg-lime-900 dark:text-lime-300',
  GENERAL: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'
};

function formatCategory(cat: string): string {
  return cat
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TrainingDataPage() {
  const [examples, setExamples] = useState<TrainingExample[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [category, setCategory] = useState<Category>('GENERAL');
  const [leadMessage, setLeadMessage] = useState('');
  const [idealResponse, setIdealResponse] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  // --------------------------------------------------
  // Fetch training examples
  // --------------------------------------------------

  const fetchExamples = useCallback(async () => {
    try {
      const res = await apiFetch<{ examples: TrainingExample[] }>(
        '/settings/training'
      );
      setExamples(res.examples ?? []);
    } catch {
      // Silently fail -- empty state will show
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPersona();
    fetchExamples();
  }, [fetchPersona, fetchExamples]);

  // --------------------------------------------------
  // Save handler
  // --------------------------------------------------

  async function handleSave() {
    if (!personaId) {
      toast.error('No persona found. Please set up your persona first.');
      return;
    }
    if (!leadMessage.trim()) {
      toast.error("Please enter the lead's message");
      return;
    }
    if (!idealResponse.trim()) {
      toast.error('Please enter your response');
      return;
    }

    setSaving(true);
    try {
      const created = await apiFetch<TrainingExample>('/settings/training', {
        method: 'POST',
        body: JSON.stringify({
          personaId,
          category,
          leadMessage: leadMessage.trim(),
          idealResponse: idealResponse.trim()
        })
      });
      setExamples((prev) => [created, ...prev]);
      setLeadMessage('');
      setIdealResponse('');
      setCategory('GENERAL');
      setShowForm(false);
      toast.success('Training example saved');
    } catch {
      toast.error('Failed to save training example');
    } finally {
      setSaving(false);
    }
  }

  // --------------------------------------------------
  // Delete handler
  // --------------------------------------------------

  async function handleDelete(id: string) {
    setDeletingId(id);
    try {
      await apiFetch(`/settings/training/${id}`, { method: 'DELETE' });
      setExamples((prev) => prev.filter((e) => e.id !== id));
      toast.success('Example deleted');
    } catch {
      toast.error('Failed to delete example');
    } finally {
      setDeletingId(null);
    }
  }

  // --------------------------------------------------
  // Bulk import state & handler
  // --------------------------------------------------

  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);

  function autoDetectCategory(leadMsg: string, response: string): Category {
    const combined = (leadMsg + ' ' + response).toLowerCase();
    // Stall types (check before general objections)
    if (
      combined.includes('talk to my wife') ||
      combined.includes('talk to my partner') ||
      combined.includes('ask my wife') ||
      combined.includes('ask my husband')
    )
      return 'STALL_PARTNER';
    if (
      combined.includes('let me think') ||
      combined.includes('need to think') ||
      combined.includes('think about it')
    )
      return 'STALL_THINK';
    if (
      combined.includes('text me later') ||
      combined.includes('not a good time') ||
      combined.includes('hit me up later') ||
      combined.includes('reach out later')
    )
      return 'STALL_TIME';
    if (
      combined.includes('have money next') ||
      combined.includes('get paid') ||
      combined.includes('next paycheck') ||
      combined.includes('money next week')
    )
      return 'STALL_MONEY';
    // Ghost / No-show
    if (
      combined.includes('ghost') ||
      combined.includes('no response') ||
      combined.includes('stopped responding') ||
      combined.includes('giving up')
    )
      return 'GHOST_SEQUENCE';
    if (
      combined.includes('no show') ||
      combined.includes('no-show') ||
      combined.includes("didn't show") ||
      combined.includes('missed the call')
    )
      return 'NO_SHOW';
    // Pre-call / Downsell / Story
    if (
      combined.includes('before the call') ||
      combined.includes('pre-call') ||
      combined.includes('reminder') ||
      combined.includes('night before')
    )
      return 'PRE_CALL_NURTURE';
    if (
      combined.includes('origin story') ||
      combined.includes('my story') ||
      combined.includes('how i started') ||
      combined.includes('background')
    )
      return 'ORIGIN_STORY';
    if (
      combined.includes('proof') ||
      combined.includes('testimonial') ||
      combined.includes('student result') ||
      combined.includes('success story')
    )
      return 'PROOF_POINT';
    // Existing objection types
    if (
      combined.includes('how much') ||
      combined.includes('price') ||
      combined.includes('cost') ||
      combined.includes('afford') ||
      combined.includes('expensive')
    )
      return 'OBJECTION_MONEY';
    if (
      combined.includes('trust') ||
      combined.includes('scam') ||
      combined.includes('legit') ||
      combined.includes('real')
    )
      return 'OBJECTION_TRUST';
    if (
      combined.includes('time') ||
      combined.includes('busy') ||
      combined.includes('schedule')
    )
      return 'OBJECTION_TIME';
    if (
      combined.includes('tried before') ||
      combined.includes("didn't work") ||
      combined.includes('failed') ||
      combined.includes('lost money')
    )
      return 'OBJECTION_PRIOR_FAILURE';
    if (
      combined.includes('book') ||
      combined.includes('call') ||
      combined.includes('schedule a') ||
      combined.includes('sign up')
    )
      return 'CLOSING';
    if (
      combined.includes('follow up') ||
      combined.includes('checking in') ||
      combined.includes('still interested')
    )
      return 'FOLLOW_UP';
    if (
      combined.includes('hey') ||
      combined.includes('interested') ||
      combined.includes('saw your') ||
      combined.includes('hi ')
    )
      return 'GREETING';
    if (
      combined.includes('what do you do') ||
      combined.includes('challenge') ||
      combined.includes('goal') ||
      combined.includes('how long') ||
      combined.includes('experience')
    )
      return 'QUALIFICATION';
    return 'GENERAL';
  }

  function parseBulkText(
    text: string
  ): Array<{ category: Category; leadMessage: string; idealResponse: string }> {
    const blocks = text.split(/\n---\n|\n-{3,}\n/).filter((b) => b.trim());
    const results: Array<{
      category: Category;
      leadMessage: string;
      idealResponse: string;
    }> = [];

    for (const block of blocks) {
      // Try [LEAD]: ... [YOU]: ... format
      const labelMatch = block.match(
        /\[LEAD\]:?\s*([\s\S]*?)\[YOU\]:?\s*([\s\S]*)/i
      );
      if (labelMatch) {
        const lead = labelMatch[1].trim();
        const you = labelMatch[2].trim();
        if (lead && you) {
          results.push({
            category: autoDetectCategory(lead, you),
            leadMessage: lead,
            idealResponse: you
          });
          continue;
        }
      }

      // Try Lead: ... You: ... format
      const colonMatch = block.match(
        /(?:Lead|Them|Customer|Prospect):?\s*([\s\S]*?)(?:You|Me|Response|Reply):?\s*([\s\S]*)/i
      );
      if (colonMatch) {
        const lead = colonMatch[1].trim();
        const you = colonMatch[2].trim();
        if (lead && you) {
          results.push({
            category: autoDetectCategory(lead, you),
            leadMessage: lead,
            idealResponse: you
          });
          continue;
        }
      }

      // Try two-line format (first line = lead, second = response)
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        const lead = lines[0];
        const you = lines.slice(1).join('\n');
        results.push({
          category: autoDetectCategory(lead, you),
          leadMessage: lead,
          idealResponse: you
        });
      }
    }
    return results;
  }

  async function handleBulkImport() {
    if (!personaId) {
      toast.error('No persona found. Please set up your persona first.');
      return;
    }

    const textToImport = bulkText.trim();
    if (!textToImport) {
      toast.error('Please paste or upload conversation data first.');
      return;
    }

    setBulkImporting(true);
    try {
      // Use the server-side bulk parser for better accuracy
      const result = await apiFetch<{
        imported: number;
        categories: Record<string, number>;
      }>('/settings/training/bulk', {
        method: 'POST',
        body: JSON.stringify({ content: textToImport })
      });

      if (result.imported > 0) {
        // Refresh the examples list
        await fetchExamples();
        setBulkText('');
        setShowBulkImport(false);

        // Build category summary
        const summary = Object.entries(result.categories)
          .map(([cat, count]) => `${formatCategory(cat)}: ${count}`)
          .join(', ');
        toast.success(`Imported ${result.imported} examples! (${summary})`);
      } else {
        toast.error('No examples could be parsed from the input.');
      }
    } catch {
      toast.error('Failed to import training data');
    } finally {
      setBulkImporting(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    setBulkText(text);
    setShowBulkImport(true);
    toast.success(`Loaded ${file.name} — click Import to save`);

    // Reset the input so the same file can be re-selected
    e.target.value = '';
  }

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
      <div className='flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Training Data</h2>
          <p className='text-muted-foreground'>
            Add conversation examples to teach the AI how you talk. The more
            examples, the better it mirrors your style.
          </p>
        </div>
        <div className='flex gap-2'>
          {!showForm && (
            <Button onClick={() => setShowForm(true)} className='shrink-0'>
              <Plus className='mr-2 h-4 w-4' />
              Add Example
            </Button>
          )}
          {!showBulkImport && (
            <>
              <Button
                variant='outline'
                onClick={() => setShowBulkImport(true)}
                className='shrink-0'
              >
                <Upload className='mr-2 h-4 w-4' />
                Bulk Import
              </Button>
              <label>
                <input
                  type='file'
                  accept='.md,.txt,.csv'
                  className='hidden'
                  onChange={handleFileUpload}
                />
                <Button variant='outline' className='shrink-0' asChild>
                  <span>
                    <Upload className='mr-2 h-4 w-4' />
                    Upload File
                  </span>
                </Button>
              </label>
            </>
          )}
        </div>
      </div>

      {/* Add Example Form */}
      {showForm && (
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <CardTitle className='text-lg'>New Training Example</CardTitle>
              <Button
                variant='ghost'
                size='icon'
                onClick={() => {
                  setShowForm(false);
                  setLeadMessage('');
                  setIdealResponse('');
                  setCategory('GENERAL');
                }}
              >
                <X className='h-4 w-4' />
              </Button>
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            {/* Category Select */}
            <div className='space-y-2'>
              <Label htmlFor='category'>Category</Label>
              <Select
                value={category}
                onValueChange={(val) => setCategory(val as Category)}
              >
                <SelectTrigger id='category' className='w-full sm:w-[280px]'>
                  <SelectValue placeholder='Select a category' />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {formatCategory(cat)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Lead Message */}
            <div className='space-y-2'>
              <Label htmlFor='lead-message'>Lead&apos;s Message</Label>
              <Textarea
                id='lead-message'
                placeholder='What the lead said... e.g. "How much does your program cost?"'
                value={leadMessage}
                onChange={(e) => setLeadMessage(e.target.value)}
                rows={3}
              />
            </div>

            {/* Ideal Response */}
            <div className='space-y-2'>
              <Label htmlFor='ideal-response'>Your Response</Label>
              <Textarea
                id='ideal-response'
                placeholder="How you'd respond in your style..."
                value={idealResponse}
                onChange={(e) => setIdealResponse(e.target.value)}
                rows={3}
              />
            </div>

            {/* Save Button */}
            <div className='flex justify-end pt-2'>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : 'Save Example'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bulk Import Form */}
      {showBulkImport && (
        <Card>
          <CardHeader>
            <div className='flex items-center justify-between'>
              <CardTitle className='text-lg'>
                Bulk Import Conversations
              </CardTitle>
              <Button
                variant='ghost'
                size='icon'
                onClick={() => {
                  setShowBulkImport(false);
                  setBulkText('');
                }}
              >
                <X className='h-4 w-4' />
              </Button>
            </div>
          </CardHeader>
          <CardContent className='space-y-4'>
            <p className='text-muted-foreground text-sm'>
              Paste your DM conversations below. Separate each example with{' '}
              <code className='bg-muted rounded px-1 text-xs'>---</code>.
              Categories are auto-detected from keywords.
            </p>
            <div className='bg-muted space-y-1 rounded-md p-3 font-mono text-xs'>
              <p className='text-muted-foreground'># Format:</p>
              <p>[LEAD]: Hey I saw your post about trading!</p>
              <p>
                [YOU]: Yo appreciate you reaching out! What got you into
                trading?
              </p>
              <p>---</p>
              <p>[LEAD]: How much does your program cost?</p>
              <p>
                [YOU]: Great question. Before we talk numbers, let me understand
                your situation...
              </p>
            </div>
            <Separator />
            <div className='space-y-2'>
              <Label htmlFor='bulk-text'>Paste conversations</Label>
              <Textarea
                id='bulk-text'
                placeholder={
                  '[LEAD]: Their message here\n[YOU]: Your response here\n---\n[LEAD]: Next lead message\n[YOU]: Your response'
                }
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                rows={12}
                className='font-mono text-sm'
              />
            </div>
            {bulkText.trim() && (
              <p className='text-muted-foreground text-sm'>
                Preview: <strong>{parseBulkText(bulkText).length}</strong>{' '}
                examples detected
              </p>
            )}
            <div className='flex justify-end gap-2 pt-2'>
              <Button
                variant='outline'
                onClick={() => {
                  setShowBulkImport(false);
                  setBulkText('');
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleBulkImport}
                disabled={bulkImporting || !bulkText.trim()}
              >
                {bulkImporting
                  ? 'Importing...'
                  : `Import ${parseBulkText(bulkText).length} Examples`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Examples List */}
      {examples.length === 0 ? (
        <Card>
          <CardContent className='flex flex-col items-center justify-center py-12 text-center'>
            <MessageSquareText className='text-muted-foreground mb-4 h-12 w-12' />
            <h3 className='text-lg font-semibold'>No training examples yet</h3>
            <p className='text-muted-foreground mt-1 max-w-sm'>
              Add conversation examples so the AI can learn your unique
              communication style and tone.
            </p>
            {!showForm && (
              <Button
                variant='outline'
                className='mt-4'
                onClick={() => setShowForm(true)}
              >
                <Plus className='mr-2 h-4 w-4' />
                Add Your First Example
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className='grid gap-4'>
          {examples.map((example) => (
            <Card key={example.id}>
              <CardContent className='pt-6'>
                <div className='flex items-start justify-between gap-4'>
                  <div className='min-w-0 flex-1 space-y-3'>
                    {/* Category Badge */}
                    <Badge
                      variant='secondary'
                      className={
                        CATEGORY_COLORS[example.category as Category] || ''
                      }
                    >
                      {formatCategory(example.category)}
                    </Badge>

                    {/* Lead Message */}
                    <div>
                      <p className='text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase'>
                        Lead
                      </p>
                      <p className='text-sm'>{example.leadMessage}</p>
                    </div>

                    {/* Response */}
                    <div>
                      <p className='text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase'>
                        Your Response
                      </p>
                      <p className='text-sm'>{example.idealResponse}</p>
                    </div>
                  </div>

                  {/* Delete */}
                  <Button
                    variant='ghost'
                    size='icon'
                    className='text-muted-foreground hover:text-destructive shrink-0'
                    onClick={() => handleDelete(example.id)}
                    disabled={deletingId === example.id}
                  >
                    <Trash2 className='h-4 w-4' />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
