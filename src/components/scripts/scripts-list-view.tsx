'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
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
  ChevronDown,
  FileText,
  Copy,
  Trash2,
  Loader2
} from 'lucide-react';
import {
  fetchScripts,
  createScript,
  deleteScript,
  activateScript,
  duplicateScript
} from '@/lib/api';
import type { ScriptListItem } from '@/lib/script-types';

export default function ScriptsListView() {
  const router = useRouter();
  const [scripts, setScripts] = useState<ScriptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

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

  useEffect(() => {
    load();
  }, [load]);

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
      router.push(`/dashboard/settings/persona/${script.id}`);
    } catch (err) {
      console.error('Failed to create script:', err);
      toast.error('Failed to create script');
    } finally {
      setCreating(false);
    }
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
      // If currently active, we deactivate by reloading (no separate deactivate endpoint needed —
      // activating another script handles it, or we just don't allow deactivating the only script)
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button disabled={creating}>
              {creating ? (
                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
              ) : (
                <Plus className='mr-2 h-4 w-4' />
              )}
              Create Script
              <ChevronDown className='ml-2 h-4 w-4' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuItem onClick={() => handleCreate(true)}>
              <FileText className='mr-2 h-4 w-4' />
              From Default Template
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleCreate(false)}>
              <Plus className='mr-2 h-4 w-4' />
              Blank Script
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Empty state */}
      {scripts.length === 0 && (
        <div className='border-border rounded-lg border border-dashed p-12 text-center'>
          <FileText className='text-muted-foreground mx-auto mb-4 h-12 w-12' />
          <h3 className='mb-2 text-lg font-semibold'>No scripts yet</h3>
          <p className='text-muted-foreground mb-4 text-sm'>
            Create a script from the default template to get started.
          </p>
          <Button onClick={() => handleCreate(true)} disabled={creating}>
            {creating && <Loader2 className='mr-2 h-4 w-4 animate-spin' />}
            Create from Default Template
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
    </div>
  );
}
