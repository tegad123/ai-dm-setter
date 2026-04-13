'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { IconList, IconLayoutKanban } from '@tabler/icons-react';
import { LeadsTable } from './leads-table';
import { PipelineView } from './pipeline-view';

const STORAGE_KEY = 'leads-view-mode';

export function LeadsViewToggle() {
  const [view, setView] = useState<'list' | 'pipeline'>('list');

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
      {view === 'list' ? <LeadsTable /> : <PipelineView />}
    </div>
  );
}
