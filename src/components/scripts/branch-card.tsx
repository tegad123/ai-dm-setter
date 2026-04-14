'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  GripVertical,
  Trash2,
  GitBranch,
  ChevronDown,
  ChevronRight
} from 'lucide-react';
import ActionList from './action-list';
import { updateBranch, deleteBranch } from '@/lib/api';
import type {
  ScriptBranch,
  ScriptAction,
  ScriptForm
} from '@/lib/script-types';
import { toast } from 'sonner';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@/components/ui/collapsible';

interface BranchCardProps {
  branch: ScriptBranch;
  scriptId: string;
  stepId: string;
  forms: ScriptForm[];
  onUpdate: (branch: ScriptBranch) => void;
  onDelete: (branchId: string) => void;
}

export default function BranchCard({
  branch,
  scriptId,
  stepId,
  forms,
  onUpdate,
  onDelete
}: BranchCardProps) {
  const [open, setOpen] = useState(true);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: branch.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1
  };

  const handleFieldSave = async (field: string, value: string) => {
    try {
      await updateBranch(scriptId, stepId, branch.id, { [field]: value });
      onUpdate({ ...branch, [field]: value });
    } catch {
      toast.error('Failed to save branch');
    }
  };

  const handleDeleteBranch = async () => {
    try {
      await deleteBranch(scriptId, stepId, branch.id);
      onDelete(branch.id);
    } catch {
      toast.error('Failed to delete branch');
    }
  };

  const handleActionsChange = (actions: ScriptAction[]) => {
    onUpdate({ ...branch, actions });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className='border-l-primary/50 bg-card rounded border border-l-4 p-3'
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className='flex items-center gap-2'>
          <button
            className='text-muted-foreground hover:text-foreground cursor-grab'
            {...attributes}
            {...listeners}
          >
            <GripVertical className='h-4 w-4' />
          </button>

          <GitBranch className='text-primary h-4 w-4' />

          <CollapsibleTrigger className='flex flex-1 items-center gap-1 text-left'>
            {open ? (
              <ChevronDown className='text-muted-foreground h-4 w-4' />
            ) : (
              <ChevronRight className='text-muted-foreground h-4 w-4' />
            )}
            <span className='text-sm font-medium'>{branch.branchLabel}</span>
            <span className='text-muted-foreground ml-2 text-xs'>
              ({branch.actions.length} actions)
            </span>
          </CollapsibleTrigger>

          <Button
            variant='ghost'
            size='icon'
            className='h-7 w-7'
            onClick={handleDeleteBranch}
          >
            <Trash2 className='h-3.5 w-3.5 text-red-500' />
          </Button>
        </div>

        <CollapsibleContent className='mt-3 space-y-3'>
          <div className='grid gap-2 pl-6'>
            <div>
              <Label className='text-xs'>Branch Label</Label>
              <Input
                defaultValue={branch.branchLabel}
                onBlur={(e) => {
                  if (e.target.value !== branch.branchLabel) {
                    handleFieldSave('branchLabel', e.target.value);
                  }
                }}
                className='text-sm'
              />
            </div>
            <div>
              <Label className='text-xs'>Condition</Label>
              <Textarea
                defaultValue={branch.conditionDescription || ''}
                placeholder='When should this branch be taken?'
                onBlur={(e) => {
                  if (e.target.value !== (branch.conditionDescription || '')) {
                    handleFieldSave('conditionDescription', e.target.value);
                  }
                }}
                className='min-h-[40px] text-sm'
              />
            </div>
          </div>

          <div className='pl-6'>
            <Label className='text-muted-foreground mb-1 block text-xs'>
              Actions
            </Label>
            <ActionList
              actions={branch.actions}
              scriptId={scriptId}
              stepId={stepId}
              branchId={branch.id}
              forms={forms}
              onActionsChange={handleActionsChange}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
