'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
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
import { toast } from 'sonner';
import {
  Plus,
  FileText,
  Copy,
  Trash2,
  Loader2,
  Upload,
  Clock
} from 'lucide-react';
import {
  fetchScripts,
  deleteScript,
  activateScript,
  duplicateScript,
  apiFetch
} from '@/lib/api';
import type { ScriptListItem } from '@/lib/script-types';
import CreateScriptDialog from './create-script-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';

export default function ScriptsListView() {
  const router = useRouter();
  const [scripts, setScripts] = useState<ScriptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Global response timing (applies to all scripts)
  const [delayMinSec, setDelayMinSec] = useState<number>(300);
  const [delayMaxSec, setDelayMaxSec] = useState<number>(600);
  const [timingLoaded, setTimingLoaded] = useState(false);
  const [savingTiming, setSavingTiming] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchScripts();
      setScripts(data);
    } catch (err) {
      console.error('Failed to load scripts:', err);
      toast.error('Failed to load scripts');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTiming = useCallback(async () => {
    try {
      const res = await apiFetch<{
        account: { responseDelayMin: number; responseDelayMax: number };
      }>('/settings/account');
      setDelayMinSec(res.account.responseDelayMin);
      setDelayMaxSec(res.account.responseDelayMax);
    } catch (err) {
      console.error('Failed to load response timing:', err);
    } finally {
      setTimingLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    loadTiming();
  }, [load, loadTiming]);

  const handleSaveTiming = async () => {
    if (delayMaxSec < delayMinSec) {
      toast.error('Maximum delay must be at least the minimum delay');
      return;
    }
    setSavingTiming(true);
    try {
      await apiFetch('/settings/account', {
        method: 'PUT',
        body: JSON.stringify({
          responseDelayMin: delayMinSec,
          responseDelayMax: delayMaxSec
        })
      });
      toast.success('Response timing saved');
    } catch (err) {
      console.error('Failed to save response timing:', err);
      toast.error('Failed to save response timing');
    } finally {
      setSavingTiming(false);
    }
  };

  const formatSeconds = (s: number) => {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
  };

  const handleToggleActive = async (
    scriptId: string,
    currentlyActive: boolean
  ) => {
    try {
      if (!currentlyActive) {
        await activateScript(scriptId);
        toast.success('Script activated');
      }
      await load();
    } catch (err) {
      console.error('Failed to toggle script:', err);
      toast.error('Failed to update script status');
    }
  };

  const handleDuplicate = async (scriptId: string) => {
    try {
      const result = await duplicateScript(scriptId);
      toast.success('Script duplicated');
      router.push(`/dashboard/settings/persona/${result.id}`);
    } catch (err) {
      console.error('Failed to duplicate script:', err);
      toast.error('Failed to duplicate script');
    }
  };

  const handleDelete = async (scriptId: string) => {
    try {
      await deleteScript(scriptId);
      toast.success('Script deleted');
      await load();
    } catch (err) {
      console.error('Failed to delete script:', err);
      toast.error('Failed to delete script');
    }
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Loader2 className='text-muted-foreground h-6 w-6 animate-spin' />
      </div>
    );
  }

  return (
    <div className='space-y-6'>
      {/* Header */}
      <div className='flex items-center justify-between'>
        <div>
          <h2 className='text-2xl font-bold tracking-tight'>Sales Scripts</h2>
          <p className='text-muted-foreground text-sm'>
            Define your DM conversation flow. The active script powers the AI.
          </p>
        </div>

        <Button onClick={() => setCreateDialogOpen(true)}>
          <Plus className='mr-2 h-4 w-4' />
          Create Script
        </Button>
      </div>

      {/* Global Response Timing */}
      {timingLoaded && (
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <Clock className='text-muted-foreground h-5 w-5' />
              <div>
                <CardTitle className='text-base'>Response Timing</CardTitle>
                <CardDescription>
                  How long the AI waits before replying. A random value between
                  min and max is picked for each message — applies to every
                  script.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className='grid gap-4 sm:grid-cols-2'>
              <div className='space-y-2'>
                <Label htmlFor='delay-min'>
                  Minimum delay (seconds) ·{' '}
                  <span className='text-muted-foreground font-normal'>
                    {formatSeconds(delayMinSec)}
                  </span>
                </Label>
                <Input
                  id='delay-min'
                  type='number'
                  min={0}
                  value={delayMinSec}
                  onChange={(e) =>
                    setDelayMinSec(Math.max(0, Number(e.target.value) || 0))
                  }
                />
              </div>
              <div className='space-y-2'>
                <Label htmlFor='delay-max'>
                  Maximum delay (seconds) ·{' '}
                  <span className='text-muted-foreground font-normal'>
                    {formatSeconds(delayMaxSec)}
                  </span>
                </Label>
                <Input
                  id='delay-max'
                  type='number'
                  min={0}
                  value={delayMaxSec}
                  onChange={(e) =>
                    setDelayMaxSec(Math.max(0, Number(e.target.value) || 0))
                  }
                />
              </div>
            </div>
            <div className='mt-4 flex items-center gap-2'>
              <Button onClick={handleSaveTiming} disabled={savingTiming}>
                {savingTiming && (
                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                )}
                Save Timing
              </Button>
              <p className='text-muted-foreground text-xs'>
                Set both to 0 to reply immediately (testing only).
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {scripts.length === 0 && (
        <div className='border-border rounded-lg border border-dashed p-12 text-center'>
          <FileText className='text-muted-foreground mx-auto mb-4 h-12 w-12' />
          <h3 className='mb-2 text-lg font-semibold'>No scripts yet</h3>
          <p className='text-muted-foreground mb-4 text-sm'>
            Create a script to get started — upload your own or use a template.
          </p>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus className='mr-2 h-4 w-4' />
            Create Script
          </Button>
        </div>
      )}

      {/* Script cards */}
      <div className='grid gap-4'>
        {scripts.map((script) => (
          <div
            key={script.id}
            className='border-border bg-card hover:border-primary/30 cursor-pointer rounded-lg border p-4 transition-colors'
            onClick={() =>
              router.push(`/dashboard/settings/persona/${script.id}`)
            }
          >
            <div className='flex items-center justify-between'>
              <div className='min-w-0 flex-1'>
                <div className='flex items-center gap-2'>
                  <h3 className='truncate text-base font-semibold'>
                    {script.name}
                  </h3>
                  {script.isActive && (
                    <Badge variant='default' className='shrink-0'>
                      Active
                    </Badge>
                  )}
                  {script.isDefault && (
                    <Badge variant='secondary' className='shrink-0'>
                      Default Template
                    </Badge>
                  )}
                  {script.createdVia === 'upload_parsed' && (
                    <Badge
                      variant='outline'
                      className='shrink-0 border-blue-200 text-blue-600 dark:border-blue-800 dark:text-blue-400'
                    >
                      <Upload className='mr-1 h-3 w-3' />
                      Parsed
                    </Badge>
                  )}
                </div>
                {script.description && (
                  <p className='text-muted-foreground mt-1 line-clamp-1 text-sm'>
                    {script.description}
                  </p>
                )}
                <p className='text-muted-foreground mt-1 text-xs'>
                  {script.stepCount} steps
                </p>
              </div>

              <div
                className='flex items-center gap-3'
                onClick={(e) => e.stopPropagation()}
              >
                <div className='flex items-center gap-2'>
                  <span className='text-muted-foreground text-xs'>
                    {script.isActive ? 'Active' : 'Inactive'}
                  </span>
                  <Switch
                    checked={script.isActive}
                    onCheckedChange={() =>
                      handleToggleActive(script.id, script.isActive)
                    }
                  />
                </div>

                <Button
                  variant='ghost'
                  size='icon'
                  onClick={() => handleDuplicate(script.id)}
                  title='Duplicate'
                >
                  <Copy className='h-4 w-4' />
                </Button>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant='ghost' size='icon' title='Delete'>
                      <Trash2 className='h-4 w-4 text-red-500' />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Script</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete &ldquo;{script.name}&rdquo;
                        and all its steps, branches, and actions. This cannot be
                        undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDelete(script.id)}
                        className='bg-red-600 hover:bg-red-700'
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        ))}
      </div>

      <CreateScriptDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(id) => router.push(`/dashboard/settings/persona/${id}`)}
      />
    </div>
  );
}
