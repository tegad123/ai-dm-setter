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
import { toast } from 'sonner';
import { Plus, Trash2, X, MessageSquareText } from 'lucide-react';

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
        {!showForm && (
          <Button onClick={() => setShowForm(true)} className='shrink-0'>
            <Plus className='mr-2 h-4 w-4' />
            Add Example
          </Button>
        )}
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
