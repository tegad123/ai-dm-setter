'use client';

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { IconList, IconLayoutKanban, IconPlus } from '@tabler/icons-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { allStages } from '@/features/shared/lead-stage-badge';
import { LeadsTable } from './leads-table';
import { PipelineView } from './pipeline-view';

const STORAGE_KEY = 'leads-view-mode';

function DevCreateLead({ onCreated }: { onCreated: () => void }) {
  const [stage, setStage] = useState('NEW_LEAD');
  const [creating, setCreating] = useState(false);

  const create = useCallback(async () => {
    setCreating(true);
    try {
      const num = Math.floor(Math.random() * 9000) + 1000;
      await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          name: `Test Lead ${num}`,
          handle: `testlead${num}`,
          platform: 'INSTAGRAM',
          triggerType: 'DM',
          stage
        })
      });
      toast.success(`Created test lead in ${stage}`);
      onCreated();
    } catch {
      toast.error('Failed to create test lead');
    } finally {
      setCreating(false);
    }
  }, [stage, onCreated]);

  return (
    <div className='flex items-center gap-2 rounded-lg border border-dashed p-2'>
      <span className='text-muted-foreground text-xs font-medium'>DEV</span>
      <Select value={stage} onValueChange={(v) => setStage(v.toUpperCase())}>
        <SelectTrigger className='h-8 w-[160px] text-xs'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allStages.map((s) => (
            <SelectItem key={s.value} value={s.value.toUpperCase()}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size='sm' variant='outline' disabled={creating} onClick={create}>
        <IconPlus className='mr-1 h-3 w-3' />
        {creating ? 'Creating...' : 'Create Test Lead'}
      </Button>
    </div>
  );
}

export function LeadsViewToggle() {
  const [view, setView] = useState<'list' | 'pipeline'>('list');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'list' || saved === 'pipeline') setView(saved);
  }, []);

  const toggle = (v: 'list' | 'pipeline') => {
    setView(v);
    localStorage.setItem(STORAGE_KEY, v);
  };

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <div className='flex w-fit gap-1 rounded-lg border p-1'>
          <Button
            variant={view === 'list' ? 'default' : 'ghost'}
            size='sm'
            onClick={() => toggle('list')}
          >
            <IconList className='mr-1 h-4 w-4' />
            List
          </Button>
          <Button
            variant={view === 'pipeline' ? 'default' : 'ghost'}
            size='sm'
            onClick={() => toggle('pipeline')}
          >
            <IconLayoutKanban className='mr-1 h-4 w-4' />
            Pipeline
          </Button>
        </div>
        <DevCreateLead onCreated={() => setRefreshKey((k) => k + 1)} />
      </div>
      {view === 'list' ? (
        <LeadsTable key={`list-${refreshKey}`} />
      ) : (
        <PipelineView key={`pipeline-${refreshKey}`} />
      )}
    </div>
  );
}
